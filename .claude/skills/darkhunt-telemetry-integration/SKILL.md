---
name: darkhunt-telemetry-integration
description: |
  Use this skill when integrating `@darkhunt-security/telemetry` (the Darkhunt
  trace-hub TypeScript SDK at /Users/sergey/proj/darkhunt/darkhunt-telemetry-ts)
  into a Node.js / TypeScript service. Covers: install, singleton client setup,
  trace + generation + span emission, backdated `startTime`, graceful shutdown,
  routing-field discipline (tenantId / workspaceId / applicationId), in-cluster
  vs public ingest paths, the masking layer, multi-agent topology + agent handoffs
  (`trace.handoffToken()` / `handoffFrom`, span links, worker-vs-agent, loops &
  cycles), and the canonical SDK-field-to-trace-hub mapping (what attributes the
  backend actually reads). Auto-invoke when the user asks about adding LLM tracing,
  sending spans to trace-hub, integrating Darkhunt observability, wiring
  DarkhuntTelemetry / `client.trace()` / `trace.generation()` calls, or building a
  multi-agent system where agents hand off to each other (agent topology / handoff
  links / loops).
---

# Darkhunt telemetry SDK — integration guide

This skill walks through wiring `@darkhunt-security/telemetry` into a TS/Node
service. The reference integration is `attack-discovery` at
`/Users/sergey/proj/darkhunt/attack-discovery` — read it (especially
`src/activities/iterate-llm.ts` and `src/worker.ts`) when in doubt; the patterns
below are extracted from there.

The SDK source lives at `/Users/sergey/proj/darkhunt/darkhunt-telemetry-ts`
and ships `README.md` with the complete API reference + masking docs. **Read
that README first** if the user is doing something the patterns below don't
cover (RAG retriever spans, multi-turn chat sessions, streaming
time-to-first-token, custom masking patterns).

## What the SDK is

Darkhunt-specific span exporter built on OpenTelemetry primitives
(TracerProvider, BatchSpanProcessor, OTLP/protobuf transport) that ships spans
— traces, LLM generations, tool calls, retrievals, guardrails — to Darkhunt
trace-hub. Routing semantics (`tenantId` / `workspaceId` / `applicationId`)
and the attribute schema are Darkhunt-specific; trace-hub is the only intended
receiver. Built-in client-side data masking redacts 66 secret/PII patterns
before payloads leave the process.

Key shapes:

- **`DarkhuntTelemetry`** — the client. One per process, lifetime-of-the-process.
- **`Trace`** — a single user-facing interaction. Carries routing fields
  (tenant / workspace / application).
- **`Generation`** — one LLM round-trip under a trace. Carries `model`,
  `inputMessages`, `outputMessages`, `usage`, `cost`, `metadata`.
- **`Span`** — anything else (tool calls, retrievals, guardrails, sub-agents,
  generic work). Use `observationType` to categorize.

## Step-by-step integration

### 1. Install + pin

**Preflight check before installing.** The SDK is ESM-only and requires
Node `^18.19.0 || >=20.6.0` (the floor set by its OpenTelemetry deps).
Before adding the dependency, verify the target project:

- `package.json` `engines.node` (or the project's CI matrix) satisfies
  `^18.19.0 || >=20.6.0`. If the project pins an older Node (< 18.19), flag
  it and ask before bumping.
- **CommonJS is NOT an automatic blocker — check the Node version first.**
  The SDK is ESM-only, but a CommonJS project (`"type": "commonjs"`,
  tsconfig `module: commonjs`) can still `require()` / `import` it **on
  Node ≥ 22.12 (and 23+)**, where Node's `require(ESM)` is on by default —
  *provided the SDK's `dist` has no top-level await* (it currently doesn't,
  so a plain `import { DarkhuntTelemetry }` compiled to `require()` loads
  fine, e.g. under `ts-node` on Node 25). Verified against this exact CJS
  setup. So:
    - **Node ≥ 22.12:** proceed even if the project is CommonJS. Don't refuse
      up front — wire it and *actually run it once* to confirm the load (a
      no-TLA guarantee isn't forever). Only if the load fails do you need a
      dynamic-`import()` wrapper or an ESM migration.
    - **Node < 22.12 AND CommonJS:** *then* the old caution applies —
      `require()` of the ESM package throws `ERR_REQUIRE_ESM`. Stop and tell
      the user; they need to migrate to ESM or use dynamic `import()` from a
      CJS wrapper, neither of which the agent should do silently.
    - Native `"type": "module"` / `.mts` projects: always fine.

Once those check out:

```bash
npm install @darkhunt-security/telemetry
```

Pin a recent published build in `package.json`:

```json
"@darkhunt-security/telemetry": "^0.5.0-build.18"
```

(Match whatever version the user's organisation publishes through CI; the
`-build.N` suffix reflects the CI run.)

### 2. Get an API key

A `dh-...` API key is required for public/external ingest (`internal: false`
— CLIs, browsers, app servers calling the public endpoint). In-cluster
service-to-service callers using `internal: true` don't need one (the cluster
network policy gates auth) and can skip this step.

Create one in the Darkhunt dashboard:

1. Open **https://app.darkhunt.ai** and go to **Settings** (bottom of the left
   nav).
2. Under the **SECURITY** group, click **API Keys**
   (`Settings → Security → API Keys`).
3. Click **+ Create API key** (top right).
4. Give it a descriptive **Name** (e.g. `production-tracing`,
   `my-service-staging`) and pick an **Expiration**
   (30 / 60 / 90 / 180 days, 1 year, or No expiration). Default is 90 days —
   prefer a bounded expiry for production and set a rotation reminder.
5. Click **Create**, then **copy the key immediately** — the full secret is
   shown only once. Afterwards the list only displays the masked prefix
   (e.g. `dh-9028f••••••••`).

The key carries the **same privileges as your account**, so treat it as a
secret: store it in a secrets manager / env file, never commit it.

**The env var the key must go in is `DARKHUNT_API_KEY`** — that's the name the
SDK reads by default (`src/client.ts:85`,
`options.apiKey ?? process.env.DARKHUNT_API_KEY`):

```bash
DARKHUNT_API_KEY=dh-9028f...your-full-secret...
```

Equivalently, pass it explicitly as the `apiKey` constructor option (an
explicit `apiKey` wins over the env var). Either way it's sent as
`Authorization: Bearer <apiKey>` on the public ingest path. If it's missing on
the public endpoint (`internal: false` and `enabled`), the constructor throws:
`apiKey is required for the public endpoint (pass via options, set
DARKHUNT_API_KEY, or use internal: true)`.

> **The key, the base URL, and the tenant must all be the same environment.**
> A `dh-` key is scoped to one environment's tenant (prod / UAT / a dev like
> seth-dev). A key from one environment sent to another environment's host
> authenticates against the wrong tenant → **401** (or spans silently routed
> nowhere). Real trap: a shell with both a prod/UAT key in `~/.zshrc` (e.g.
> `DARKHUNT_API_KEY_UAT`) *and* a seth-dev key in `~/.darkhunt/credentials.json`
> — pick the key, `DARKHUNT_BASE_URL`, and `DARKHUNT_TENANT_ID` from the **same**
> source/environment. When you enroll (step 2b), `~/.darkhunt/credentials.json`
> holds a matched `{ apiKey, apiBaseUrl, tenantId }` set — prefer that trio
> together rather than mixing an env-var key with a creds-file base URL.

The base URL defaults to `https://api.darkhunt.ai/trace-hub`; override it via the
`DARKHUNT_BASE_URL` env var or the `baseUrl` option when pointing at a
self-hosted / staging / dev trace-hub. **Two rules when you override it:** use the
**ingest API host** (`api…darkhunt.ai`), not the dashboard (`app…darkhunt.ai`,
which redirects POSTs → 405); and **keep the `/trace-hub` path** — the exporter
posts to `{baseUrl}/otlp/t/{tenantId}/v1/traces`, so dropping `/trace-hub` yields 404. Example (dev): `DARKHUNT_BASE_URL=https://api-seth-dev.darkhunt.ai/trace-hub`.

> **Gotcha: the enrolled `credentials.json` `apiBaseUrl` has NO `/trace-hub`
> suffix.** `~/.darkhunt/credentials.json` stores the bare host (e.g.
> `https://api-seth-dev.darkhunt.ai`). If you source `DARKHUNT_BASE_URL` from
> that field you **must append `/trace-hub` yourself** — otherwise the exporter
> POSTs to `{host}/otlp/...` and gets a 404. (i.e. `DARKHUNT_BASE_URL =
> "$(jq -r .apiBaseUrl ~/.darkhunt/credentials.json)/trace-hub"`.)

Set **`serviceName`** (option, or `DARKHUNT_SERVICE_NAME` / `OTEL_SERVICE_NAME`) to the OTel
Resource `service.name`. The backend records it per span, so in a multi-service / multi-agent
system give **each process its own** value (e.g. `weather.coordinator`, `weather.geodata`) to tell
producers apart — the Resource is per-`TracerProvider`, so distinct names require distinct
clients/processes, not one shared instance.

For `tool`-type observations, set **`toolName`** (and optionally `toolCallId` / `toolArguments`) on
the span — emitted as `gen_ai.tool.name` / `gen_ai.tool.call.id` / `gen_ai.tool.call.arguments`, the
fields the backend uses to show the actual tool (e.g. "geocode") rather than the generic type.

### 2b. Create an application (get the `applicationId`)

Every trace needs an `applicationId` — a **workspace-scoped UUID**. **Create a new, dedicated
OBSERVABILITY application for this integration** before wiring the client. **Do not reuse an
existing `applicationId`** — mixing a fresh integration's traces into someone else's / a
pre-existing app pollutes that app's scope and makes the new traces hard to find. (The only time
to reuse is when the user explicitly points you at a specific existing app to send to.)

> **Tool precedence: Darkhunt MCP → `darkhunt-cli` → raw REST (last resort).** Reach for the
> **Darkhunt MCP first**, at the very start of the task — it's the intended, supported interface
> and reuses enrolled credentials. **We highly recommend installing the `darkhunt-cli` for a smooth
> integration** — it isn't just a fallback: it's what `enroll`s your credentials
> (`~/.darkhunt/credentials.json`) *and* serves the MCP itself (`darkhunt-cli mcp`), so it underpins
> the whole MCP-first path. Only if the MCP is unavailable, use the `darkhunt-cli` directly; only if
> *both* are unavailable should you fall back to hitting the `…/workflow-manager/api/…` REST
> endpoints with curl. **Don't silently drop to raw REST** because listing/creating an app "seems
> easier" — that's off-pattern and brittle. If neither MCP nor CLI is reachable, say so and ask
> before curling the API directly.

**MCP path (primary — do this first).** App creation lives in the Darkhunt **MCP tools**, not a bare
`darkhunt-cli` subcommand (the CLI's own commands are `enroll` / `scan` / `corpus` / `datasets` /
`attack-libraries` / `target` / `playground` / `update` / `mcp` — none of them create an app). The CLI
ships the MCP server (`darkhunt-cli mcp`) that an AI client (e.g. Claude Code) drives, reusing the
credentials from `enroll`.

**Check the MCP is connected before anything else.** In Claude Code, look for `darkhunt_*` tools; if
they're absent, the server isn't registered in this session. **Offer to wire it up** rather than
routing around it:

```bash
# One-time terminal step — keeps your dh- key OUT of the chat transcript.
# Tenant is looked up from the key; add --tenant only if the key spans multiple tenants.
darkhunt-cli enroll --api-key dh-...          # → ~/.darkhunt/credentials.json

# Register the MCP server for the project (then RELOAD the session — MCP tools
# load at startup, so the darkhunt_* tools appear only after a restart):
claude mcp add darkhunt -- darkhunt-cli mcp
```

Once the `darkhunt_*` tools are available (auth reused from enroll):

```text
darkhunt_status               # confirm auth + tenant + reachable API
darkhunt_list_workspaces      # → pick your workspaceId (UUID)
darkhunt_create_application    { workspaceId, name, type: 'OBSERVABILITY', description? }
                              # → returns the NEW application's UUID (use this)
darkhunt_list_applications    # only to sanity-check naming / avoid a duplicate — NOT to grab
                              # and reuse a random existing app's UUID
```

- **`type` defaults to `RED_TEAM`** (a connector-less app for adversarial scanning). For a telemetry
  app, pass **`type: 'OBSERVABILITY'`** so the app's **Tracing** view is enabled and your spans land in
  a sensible scope.
- Put the returned UUID in **`DARKHUNT_APPLICATION_ID`**. In a multi-agent system, one app **per
  domain/service group** is typical (agents are told apart by `serviceName`) — create one per domain and
  set e.g. `DARKHUNT_APP_WEATHER=<uuid>`, plumbing the right one into each process's
  `DARKHUNT_APPLICATION_ID`.

**Dashboard path (fallback if MCP+CLI are both unavailable).** Open **app.darkhunt.ai** → the **Get
started / Applications** area → create a **new** application (the new-app / RedTeamWizard flow) → copy
its `applicationId` (alongside your `tenantId` and `workspaceId`). Use this if you'd rather click than
script; the MCP path is better for reproducible, multi-app setups.

Either way, the **newly created** `applicationId` + `tenantId` + `workspaceId` are the routing fields
the client needs next.

### 3. Singleton client (process-wide)

**Don't construct `DarkhuntTelemetry` per request.** The SDK registers a
`process.once('beforeExit', ...)` handler per construction and spins up a
NodeTracerProvider + BatchSpanProcessor each time, so a per-call client leaks
listeners (Node's 10-listener warning) and prevents BSP from batching across
calls.

The reference pattern from `attack-discovery/src/activities/iterate-llm.ts:124`:

```ts
let telemetryClient: DarkhuntTelemetry | null = null;

function getTelemetryClient(): DarkhuntTelemetry {
  if (!telemetryClient) {
    telemetryClient = new DarkhuntTelemetry({
      baseUrl: config.telemetry.baseUrl,
      // In-cluster service-to-service: post to /internal/... (no upstream
      // auth filter, no bearer required). For CLI / external clients, use
      // `internal: false` and pass `apiKey` instead.
      internal: true,
    });
  }
  return telemetryClient;
}

export async function shutdownTelemetry(): Promise<void> {
  if (telemetryClient) {
    await telemetryClient.shutdown();
    telemetryClient = null;
  }
}
```

### 4. Wire shutdown on signals

The SDK auto-flushes on `process.beforeExit`, but **not** on signal-driven
shutdown. Long-running servers must wire it up. From
`attack-discovery/src/worker.ts:77-90`:

```ts
const shutdown = (signal: NodeJS.Signals) => {
  logger.info({ signal }, 'shutting down');
  void apiServer.close();
  void worker.shutdown();
  void shutdownTelemetry();
  void stopHealthServer();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

// On natural exit, await the same shutdown again (idempotent because
// shutdownTelemetry no-ops once the client is null):
await worker.run();
await shutdownTelemetry();
```

For one-shot scripts / CLIs / cron jobs: `await client.flush()` before
returning is enough — the `beforeExit` hook handles teardown.

### 5. Open trace + generation per LLM call

Pattern from `attack-discovery/src/activities/iterate-llm.ts:154-176`:

```ts
function openGeneration(
  ctx: {
    tenantId: string;
    workspaceId: string;
    applicationId: string;
    assessmentRunId: string; // optional — used by Darkhunt assessment workflows
    techniqueId: string;
  },
  spanSuffix: string,
  startTime: number // epoch ms — captured BEFORE any await
): { trace: Trace; generation: Generation } {
  const client = getTelemetryClient();
  const trace = client.trace({
    name: ctx.assessmentRunId,
    sessionId: ctx.assessmentRunId, // groups all turns of one run as one timeline
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    applicationId: ctx.applicationId,
    assessmentRunId: ctx.assessmentRunId, // optional; Darkhunt-internal grouping
    userId: 'darkhunt',
    userEmail: 'darkhunt',
    startTime, // backdate root span
  });
  const generation = trace.generation(
    `${ctx.techniqueId}:${spanSuffix}`,
    { startTime } // backdate generation span
  );
  return { trace, generation };
}
```

**Critical: capture `startTime = Date.now()` BEFORE any awaited LLM call.**
Without `startTime`, the OTel span starts at construction time (post-LLM-call),
so the recorded duration covers only ~0ms of bookkeeping instead of actual
LLM time. Same applies to the trace root span.

### 6. End span with payload

```ts
generation.update({
  inputMessages: [{ role: 'user', content: prompt }],
  metadata: buildTurnSpanMetadata(input), // see "metadata discipline" below
});
generation.end({
  model,
  outputMessages: [{ role: 'assistant', content: reply }],
  usage: {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  },
});
trace.end();
```

`update()` is for fields known at start; `end()` is for fields known when work
finishes. You can pass everything to `end()` if there's no streaming
intermediate state to record.

**Strict-TypeScript projects: two `tsc` errors the snippets above can trigger.**
Many host projects compile with `exactOptionalPropertyTypes` and
`noPropertyAccessFromIndexSignature` (both on in the Anthropic SDK repo, for
example). Two adjustments keep the integration clean:

- **`exactOptionalPropertyTypes` rejects assigning `undefined` to an optional
  field.** So `usage: { input_tokens, output_tokens, cache_read_tokens:
maybeUndefined }` fails to typecheck — build the object and add the optional
  cache fields **conditionally** instead of assigning `undefined`:

  ```ts
  const usage: {
    input_tokens: number; output_tokens: number;
    cache_read_tokens?: number; cache_creation_tokens?: number;
  } = { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
  if (u.cache_read_input_tokens != null) usage.cache_read_tokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) usage.cache_creation_tokens = u.cache_creation_input_tokens;
  generation.end({ model, outputMessages, usage });
  ```

- **`noPropertyAccessFromIndexSignature` forbids dotted access on `process.env`.**
  Read env vars with bracket syntax: `process.env['NODE_ENV']`, not
  `process.env.NODE_ENV`.

## Routing fields

Every span carries three required routing attributes — `tenantId`,
`workspaceId`, `applicationId`. The exporter groups by these and posts to
`POST /otlp/t/{tenantId}/v1/traces` with `X-Workspace-Id` / `X-Application-Id`
headers.

Set them once at the client level if they're constant for the process; pass
per-trace if multi-tenant. The constructor merges
`constructor arg > env var > default` and `dh.trace()` throws if any field
is still missing.

```ts
// Single-tenant: client-level
// (apiKey omitted — the SDK reads DARKHUNT_API_KEY from the env by default)
const dh = new DarkhuntTelemetry({
  tenantId: 't1',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
});
dh.trace({ name: 'chat' }); // tenant/workspace/app inherited

// Multi-tenant: per-trace
const dh = new DarkhuntTelemetry();
dh.trace({
  tenantId: req.tenantId,
  workspaceId: req.wsId,
  applicationId: 'shared',
});
```

`assessmentRunId` is **optional** and used internally by Darkhunt assessment
workflows (e.g. `attack-discovery`). It does not affect routing. General
production tracing should omit it. When set, it's emitted as
`darkhunt.assessment_run_id` and read by trace-hub for grouping inside the
assessment dashboards.

## sessionId and userId — set them every time

Routing fields are required; `sessionId` and `userId` are technically
optional but **every integration should set them**. They unlock the two
features customers actually buy the platform for:

- **Conversation visualization** — the dashboard groups traces sharing a
  `sessionId` into one timeline. A chatbot that doesn't set it shows up as
  N disconnected traces instead of one conversation.
- **Guardrails / anomaly detection** — Darkhunt's policy engine keys off
  `userId` for per-user rate limits, abuse signals, and policy decisions.
  Without it, the only available scope is per-application — much coarser.

When wiring a service, look for the stable identifiers already in scope and
plumb them through. Examples from real integrations:

- **Express / HTTP handlers** — `req.session?.id` (or signed cookie) →
  `sessionId`; `req.user?.id` or `req.user?.email` → `userId`.
- **Worker / queue jobs** — the job/correlation ID → `sessionId`; the
  invoking customer/account ID → `userId`.
- **`attack-discovery` pattern** — both fields set to `ctx.assessmentRunId`
  / `'darkhunt'` so every turn of one assessment lands in the same timeline
  attributed to the synthetic operator.

If these aren't known at trace open (auth happens mid-flow), open the trace
anyway and call `trace.update({ userId, sessionId })` once they're known —
all spans created after the update inherit the values.

## In-cluster vs public ingest

| Caller location               | `internal`        | Auth                                   | URL pattern                                      |
| ----------------------------- | ----------------- | -------------------------------------- | ------------------------------------------------ |
| In-cluster service-to-service | `true`            | none (cluster network policy gates it) | `POST {baseUrl}/internal/t/{tenantId}/v1/traces` |
| External CLI / browser / app  | `false` (default) | `Authorization: Bearer <apiKey>`       | `POST {baseUrl}/otlp/t/{tenantId}/v1/traces`     |

`attack-discovery` runs in-cluster and uses `internal: true` with no
`apiKey`; CLIs and dashboards use `internal: false` and pass a `dh-...`
bearer token.

## Metadata discipline

The `metadata` bag is a flat `Record<string, string>` on each span. It shows
up in the trace-hub dashboard and is filterable. Be strict:

- **Emit**: customer-facing summary fields the operator needs to filter or
  alert on (e.g. `score`, `goal.pass`, `goal.reason`, `terminal`).
- **Don't emit**: raw LLM responses, internal parser flags, per-metric
  breakdowns, anything that's "ops noise". They overwhelm the trace view
  and may leak proprietary methodology.

Reference: `attack-discovery/src/activities/iterate-llm.ts:226-249`'s
`buildTurnSpanMetadata` shows the surgical "promote a few summary fields,
drop the rest" pattern.

## Span types — pick the right one

| Work                          | API                                                       | `observationType`    |
| ----------------------------- | --------------------------------------------------------- | -------------------- |
| LLM round-trip                | `trace.generation(name, opts)`                            | (auto: `generation`) |
| External tool / function call | `trace.span(name, { observationType: 'tool', ... })`      | `'tool'`             |
| Vector search / retrieval     | `trace.span(name, { observationType: 'retriever', ... })` | `'retriever'`        |
| Sub-agent step                | `trace.span(name, { observationType: 'agent', ... })`     | `'agent'`            |
| Input/output guardrail        | `trace.span(name, { observationType: 'guardrail', ... })` | `'guardrail'`        |
| Generic work                  | `trace.span(name, opts)`                                  | `'span'` (default)   |
| Fire-and-forget marker        | `trace.event(name, opts)`                                 | `'event'`            |

Spans nest naturally — `parent.span(...)` makes the child a child in the
trace tree.

### Recipe: non-chat provider calls → observation types

The table above is generic; here's the worked mapping for the common non-chat
calls in an SDK-examples repo (verified against the OpenAI SDK):

| Provider call                                  | Observation                                                    | Notes                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Embeddings                                     | `trace.span(name, { observationType: 'embedding' })`          | A span has **no** `model` / `usage` field — put the model name + token count in `metadata` |
| Content moderation                             | `trace.span(name, { observationType: 'guardrail' })`          | Set `level: 'WARNING'` + `statusMessage` **only when flagged**; omit `level` otherwise     |
| Image generation (DALL·E etc.)                 | `trace.generation(name, { model, input: prompt })`            | It produces content → a generation; `output` = the image URL; **no `usage`** to send       |
| Management / async calls (assistant create, fine-tune job, batch submit/retrieve) | `trace.span(name, { observationType: 'tool', toolName })` | These don't run inference themselves (the work is async) — record them as tool spans        |

## Supported fields — SDK ↔ trace-hub mapping

This is the canonical list of what the SDK can emit and what trace-hub
reads. Anything not in this table is either dead code (set by SDK, ignored
by backend) or a backend gap (read by backend, no SDK API yet — see
"Known gaps" below). Source of truth for the right column:
`/Users/sergey/proj/darkhunt/trace-hub/src/main/resources/mappings/darkhunt.yaml`.

### Trace-level fields

Set on `client.trace({...})` or as constructor defaults on `new DarkhuntTelemetry({...})`.

| SDK option        | Required | OTel attribute emitted             | trace-hub field                    |
| ----------------- | -------- | ---------------------------------- | ---------------------------------- |
| `tenantId`        | yes      | `darkhunt.tenant_id` + URL routing | tenant scope                       |
| `workspaceId`     | yes      | `darkhunt.workspace_id` + header   | workspace scope                    |
| `applicationId`   | yes      | `darkhunt.application_id` + header | application scope                  |
| `name`            | no       | `darkhunt.trace.name`              | `trace.name`                       |
| `sessionId`       | no       | `darkhunt.session.id`              | `trace.sessionId`                  |
| `userId`          | no       | `darkhunt.user.id`                 | `trace.userId`                     |
| `userEmail`       | no       | `darkhunt.user.email`              | `trace.userEmail`                  |
| `tags`            | no       | `darkhunt.trace.tags` (CSV)        | `trace.tags`                       |
| `release`         | no       | `darkhunt.release`                 | `trace.version` + `serviceVersion` |
| `environment`     | no       | `darkhunt.environment`             | `environment.deployment`           |
| `assessmentRunId` | no       | `darkhunt.assessment_run_id`       | `trace.assessmentRunId` (internal) |

OTel resource attributes auto-set by the SDK (read by trace-hub as
`environment.serviceName` / `environment.serviceVersion`):

- `service.name` → `darkhunt-telemetry`
- `service.version` → SDK package version

### Span-level fields (all spans)

Set on `trace.span(name, opts)` / `trace.generation(name, opts)` / via
`.update(opts)` / `.end(opts)`.

| SDK option        | OTel attribute emitted                | trace-hub field                  | Notes                                                                                                                       |
| ----------------- | ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `observationType` | `darkhunt.observation.type`           | `span.type`                      | one of `span` / `tool` / `agent` / `generation` / `event` / `chain` / `retriever` / `evaluator` / `embedding` / `guardrail` |
| `input`           | `darkhunt.observation.input`          | `content.input`                  | masked; objects walked recursively                                                                                          |
| `output`          | `darkhunt.observation.output`         | `content.output`                 | masked                                                                                                                      |
| `level`           | `darkhunt.observation.level`          | `span.level`                     | SDK `ObservationLevel` = `'DEBUG'` / `'INFO'` / `'WARNING'` / `'ERROR'` (NOT `'DEFAULT'`). **Omit** `level` to get the backend's default; passing `'DEFAULT'` is not a valid SDK value. |
| `statusMessage`   | OTel `setStatus({ message })`         | `error.message` (`_span_status`) | masked; sets ERROR status when paired with `level: 'ERROR'`                                                                 |
| `version`         | `darkhunt.version`                    | `span.version`                   |                                                                                                                             |
| `metadata`        | `darkhunt.observation.metadata.<key>` | `span.metadata.<key>`            | one OTel attr per key — never a single JSON blob (backend can't iterate)                                                    |

### Generation-only fields

Set on `trace.generation(name, opts)` / via `.update(opts)` / `.end(opts)`.
These add to the span fields above.

| SDK option                    | OTel attribute(s) emitted                                                 | trace-hub field              |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `model`                       | `darkhunt.observation.model.name` + `gen_ai.request.model`                | `model.name`                 |
| `modelParameters`             | `darkhunt.observation.model.parameters` (JSON)                            | `model.parameters`           |
| `inputMessages`               | `gen_ai.input.messages` (JSON)                                            | `content.input`              |
| `outputMessages`              | `gen_ai.output.messages` (JSON)                                           | `content.output`             |
| `systemInstructions`          | `gen_ai.system_instructions`                                              | `content.system`             |
| `usage.input_tokens`          | `darkhunt.observation.usage_details` (JSON) + `gen_ai.usage.input_tokens` | `tokens.input`               |
| `usage.output_tokens`         | `gen_ai.usage.output_tokens`                                              | `tokens.output`              |
| `usage.cache_read_tokens`     | `gen_ai.usage.cache_read.input_tokens`                                    | `tokens.cacheRead`           |
| `usage.cache_creation_tokens` | `gen_ai.usage.cache_creation.input_tokens`                                | `tokens.cacheCreation`       |
| `cost`                        | `darkhunt.observation.cost_details` (JSON) + `gen_ai.usage.cost`          | `cost.json` + `cost.total`   |
| `completionStartTime`         | `darkhunt.observation.completion_start_time` (nanos)                      | `timing.completionStartTime` |
| `promptName`                  | `darkhunt.observation.prompt.name`                                        | `prompt.name`                |
| `promptVersion`               | `darkhunt.observation.prompt.version`                                     | `prompt.version`             |

> **You usually don't need to pass `cost`.** trace-hub auto-prices a generation
> from `model` + `usage` for known models — send an accurate `model` and
> `usage.{input,output,cache_*}_tokens` and the dashboard shows a computed dollar
> cost (verified: a generation sent with usage but *no* `cost` rendered `$0.0002`).
> Only set `cost` explicitly for custom / self-hosted / unpriced models the
> backend can't price on its own.

### Known gaps (backend reads, SDK doesn't yet emit)

Don't try to use these from SDK code — there's no public API. If the user
needs them, fall back to the workaround listed.

| trace-hub field                            | YAML reads                                          | Workaround until SDK supports it                                                                    |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `model.provider`                           | `gen_ai.system`                                     | Put provider in `metadata.provider` for now                                                         |
| `tool.name` / `callId` / `parameters`      | `gen_ai.tool.name` / `.call.id` / `.call.arguments` | Use `observationType: 'tool'` + `input` to record tool args; structured tool fields not yet emitted |
| `environment.osType` / `arch` / `terminal` | `host.name` / `host.arch` / `process.runtime.name`  | OTel resource detectors may auto-populate these in some Node setups; not guaranteed                 |

### Things the SDK sets but trace-hub ignores

Don't rely on these — they exist in the wire payload but never reach the
dashboard:

- `darkhunt.status_message` — set by SDK alongside `setStatus({ message })`,
  but the YAML mapping reads only `_span_status` (the OTel native). The
  redundant attr is dead weight today.

## Instrumenting a sample / OSS / multi-script repo

The reference integration (`attack-discovery`) is a single always-configured
service. A **public SDK-examples / quickstart repo** is a different archetype —
it must still run for a user who has *no* Darkhunt account, and it's usually a
folder of many independent one-shot entry scripts rather than one server. Two
patterns make that clean.

### Opt-in / graceful degradation — never crash the host app

The client is **not** safe to construct unconditionally here: on the public
endpoint the constructor **throws** if `apiKey` is missing, and `dh.trace()`
**throws** if any routing field is missing. So a bare `new DarkhuntTelemetry()`
in a sample script breaks `node examples/foo.js` for anyone who just wants to
try the underlying SDK. Gate on config presence and no-op when absent:

```ts
const REQUIRED = ['DARKHUNT_API_KEY', 'DARKHUNT_TENANT_ID', 'DARKHUNT_WORKSPACE_ID', 'DARKHUNT_APPLICATION_ID'];
const enabled = process.env['DARKHUNT_ENABLED'] !== 'false' && REQUIRED.every((k) => !!process.env[k]);

// Returns null when unconfigured; callers optional-chain so the demo still runs.
export function startTrace(name, args) {
  if (!enabled) return null;
  return getClient().trace({ name, ...args });
}
```

Then every call site uses optional chaining and the OpenAI/Anthropic demo runs
untouched when Darkhunt isn't set up:

```ts
const startTime = Date.now();
const trace = startTrace('chat.basic');
const gen = trace?.generation('answer', { model, startTime });
gen?.update({ inputMessages });
// ...real LLM call...
gen?.end({ model, outputMessages, usage });
trace?.end();
await flushTelemetry(); // no-op when disabled
```

### One service.name per example script

The OTel Resource (`service.name`) is **per-`TracerProvider`, i.e. per process**
— and each example is its own process. So derive a distinct `serviceName` from
the entry script and every example becomes its own topology node, with **zero**
per-file edits:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

function deriveServiceName() {
  if (process.env['DARKHUNT_SERVICE_NAME']) return process.env['DARKHUNT_SERVICE_NAME'];
  const entry = process.argv[1];
  if (!entry) return 'my-sdk-examples';               // e.g. `node -e ...` → argv[1] is undefined
  const rel = path.relative(ROOT, entry);
  if (!rel || rel.startsWith('..')) return 'my-sdk-examples';
  const parts = rel.replace(/\.[cm]?js$/i, '').split(path.sep).filter((s) => s && s !== 'index');
  return ['my-sdk-examples', ...parts].join('.');      // chat/vision.js → my-sdk-examples.chat.vision
}
```

Two things to know: these nodes are **independent by design** — each script
opens its own root trace with no handoffs, so they render as disconnected
islands (that's correct; they're unrelated demos, not a multi-agent graph). And
a node only appears **after it has emitted at least one trace** — a service with
zero spans shows up nowhere, so "I don't see my other examples" just means those
scripts haven't run yet. (These are all still **one application** — the split is
`service.name`, not `applicationId`.)

## Multi-agent topology & handoffs

When the service is one agent in a **multi-agent system**, the platform reconstructs the
**agent topology** — who handed off to whom. **Identity:** one `serviceName` per agent (e.g.
`finance.quant`) — that is the topology node.

### ⚠️ The edges come from the `parentSpanId` chain — you MUST nest (verified against the live trace-hub, 2026-07-08)

> **This is the single most important thing to get right, and the easiest to get wrong.** The
> deployed trace-hub builds agent→agent edges by walking the **`parentSpanId` cross-service
> chain** (each agent's entry span must be a **child of its caller's span**). It does **not**
> draw the graph from `agent_handoff` span links — it stores links but the graph builder uses
> parent-child. So if each agent opens its **own root trace** and you only wire `handoffFrom`
> links, **the nodes render as disconnected islands** (real bug we hit: ingestion looked
> perfect — per-agent generations, tools, models, cost all correct — but the Topology tab
> showed unconnected cards).

**To connect the graph, NEST each agent's trace under its caller.** Two things are required:

1. **Register the global OTel context manager + propagator yourself.** The SDK builds a
   `NodeTracerProvider` but never calls `provider.register()`, so the global OTel API has **no**
   context manager or propagator — `context.with()` is a no-op and every `dh.trace()` starts a
   fresh root with no parent. Do this ONCE, before any client/trace is created:

   ```ts
   import { context, propagation } from '@opentelemetry/api';
   import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
   import { W3CTraceContextPropagator } from '@opentelemetry/core';

   context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
   propagation.setGlobalPropagator(new W3CTraceContextPropagator());
   ```

   (Yes, this means you DO take `@opentelemetry/{api,context-async-hooks,core}` as direct deps.)

2. **Create each agent's trace inside its caller's context**, so the agent's root span gets a
   `parentSpanId` and shares the caller's `trace_id`. The caller's token is just its
   `handoffToken()` (a W3C traceparent). `Trace.span()/generation()` parent under the trace's
   **own** root (`parentContext: this.rootContext`), so ONLY the agent root needs the caller
   context — a one-liner wrapper does it:

   ```ts
   // openTrace = drop-in for dh.trace(args), but nested under args.handoffFrom[0].
   export function openTrace(args) {
     const parent = args?.handoffFrom?.[0]; // the DIRECT upstream token
     if (typeof parent !== 'string' || !parent) return dh.trace(args);
     const ctx = propagation.extract(context.active(), { traceparent: parent });
     return context.with(ctx, () => dh.trace(args)); // agent root → child of caller
   }
   ```

   Use `openTrace(...)` instead of `dh.trace(...)` in every agent. `handoffFrom[0]` becomes the
   **parent edge** (the topology arrow); any further `handoffFrom` entries stay as supplementary
   links (fan-in). A whole task then lands in **one trace**, nested — verify with: all of a
   task's spans share a single `trace_id`.

**Emit the handoff token** the same two-call way (it's what feeds `openTrace`'s parent):

```ts
// Upstream agent: expose its entry-span token.
const trace = openTrace({ name: 'research-agent', sessionId, userId, handoffFrom });
// ...work...
return { ...result, handoff: trace.handoffToken() }; // opaque W3C-traceparent string

// Downstream agent: its DIRECT upstream is handoffFrom[0] (the parent); more = fan-in links.
const trace = openTrace({
  name: 'analyst-agent',
  handoffFrom: [research.handoff, quant.handoff],
  sessionId,
  userId,
});
```

Cross-process (Temporal / queue / HTTP): the token is a string — carry it in the workflow arg /
message / header. The reference integration is `temporal-demo`
(`/Users/sergey/proj/darkhunt/temporal-demo`: `src/telemetry.ts` `openTrace`/`spanHandoff`,
`src/otel.ts` globals, `src/domains/*/workflows/coordinator.ts` threading).

### The orchestrator/gateway node needs CONTENT or it disappears

The trace-hub keeps a span only if it has a `generation` (input/outputMessages) **or a `tool`**
name — otherwise it's dropped (unless it's a cross-service boundary). A gateway/orchestrator that
opens a **contentless root trace** gets filtered out, so its node vanishes AND its children lose
their root edge. Fix: emit a **tool span** on it (e.g. a `dispatch` tool span with the task as
`input`) and hand off from THAT span, not the root — build the token from the span's context:

```ts
const root = dh.trace({ name, sessionId, userId });
const dispatch = root.span('dispatch', {
  observationType: 'tool',
  toolName: 'dispatch',
  input: { task },
});
// spanHandoff: like handoffToken() but for a child span (uses otTrace.getSpanContext(span.context)).
const handoff = spanHandoff(dispatch); // pass into the first agent's handoffFrom
```

### Link to the REAL producing agent, not the orchestrator

Thread the token **wherever one agent's output becomes the next agent's input** — that is the
true data dependency, and it's the edge the graph should show. Linking a downstream agent back to
the _orchestrator_ (because the orchestrator spawned it) yields a plausible-but-WRONG graph. Real
bug: an `advisor` that consumes the `geodata` agent's forecast was linked to the `coordinator`, so
it rendered as a parallel sibling of `geodata` instead of downstream of it. Fix: `advisor`'s
`handoffFrom` = `[geodata.handoff]` → `coordinator → geodata → advisor`.

**Other span rules:**

- **Agent vs Worker** — a node with ≥1 `generation` renders as an **Agent** (model, cost, AI-risk
  surface); a tools-only node is a **Worker** (no cost). Emit `trace.generation(...)` for EVERY
  real LLM call — including "boilerplate" ones (e.g. a letter-drafting call) or their cost never
  surfaces and a misplaced-model cost trap stays hidden.
- **Per-agent model + cost** — set `model` + `usage` on each `generation`.
- **Self-loop `↻ ×N`** — automatic. N = the agent's cross-service entry spans (times invoked).
- **Deep repeated loops → self-loops, NOT per-round back-edges.** For an N-round loop over M agents
  (e.g. a 12-round consensus panel: 3 specialists + consensus, each firing 12×), link **every**
  round's agents to the SAME stable upstream (the shared chart) so they render as clean `↻ ×12`
  self-loops. Do NOT link each round back to the prior round's output — that emits 3×11 back-edges
  and turns the graph into a tangle. Real bug: doing so made the panel unreadable vs. the clean fan.
- **Small cycle `↺` between two agents** — here a back-edge IS right: on a retry / re-review add the
  _prior_ agent to the next agent's `handoffFrom` (retried `remediation` links the failed `verify`;
  each debate `rebuttal` links the opposing `thesis`). Reserve back-edges for genuine 2-agent
  cycles; use self-loops for deep repeat loops.

**Gotchas (each was a real bug):**

1. **Nodes disconnected → you forgot to nest** (register globals + `openTrace`). Links alone don't
   draw edges on this backend; the `parentSpanId` chain does. See the ⚠️ block above.
2. **Gateway/orchestrator node missing → its span had no generation/tool content** and was filtered.
   Give it a `dispatch` tool span and hand off from that span.
3. **Wrong arrows → linked to the orchestrator instead of the real producer.** Link where output→input.
4. **Never link to a throwaway span.** `handoffToken()` targets the always-exported root span; a
   helper span created and `.end()`-ed immediately can be dropped on fast agents → dangling link.
5. **Fan-in is `handoffFrom: [a, b, c]`** — `[0]` is the parent edge; the rest are links.
6. **Don't infer handoffs from the call graph** — the orchestrator calls everyone (a star). Declare
   the causal edges via `handoffFrom`.

## Verification

After wiring, run:

```bash
npx tsc --noEmit          # ensure types resolve
npm run test              # if integration has unit-test coverage
```

Then exercise a real path that emits a span and check trace-hub for the
incoming trace.

> **The Darkhunt MCP cannot read traces back — don't promise a server-side
> confirmation you can't do.** The MCP toolset is red-team oriented
> (`scan` / `playground` / `targets` / `policies` / `datasets` / `corpora` / app
> + workspace management) — there is **no tracing-query / read-trace tool**. So
> from the agent side you have exactly two checks: **(1)** the curl empty-body
> probe below, which confirms **auth + routing only** (a 400), and **(2)** the
> human opening the dashboard. There is no API to assert "span X landed." Tell
> the user that final confirmation is theirs to eyeball; don't claim you verified
> ingestion programmatically.

> **Verify through the real integration, not a throwaway probe script.** A probe
> that emits a span under a *different* `serviceName` (e.g. `ingest-verify`) mints
> a **whole separate node in the Topology view** — and it renders as its own Agent
> with a `↻ ×N` self-loop for each time you ran it. There's no delete-trace API, so
> that node is **permanent noise** in the OBSERVABILITY app (verified this run: a
> `ingest-verify` probe left a standing `↻ ×2` agent card next to the real one).
> Prefer the two clean checks: **(1)** the curl endpoint probe above (server-side,
> emits nothing), and **(2)** running the *actual* instrumented code path and
> reading its node. If you truly must emit a span from a script, give it the
> **same `serviceName` as the real integration** so it folds into that node
> instead of creating a phantom agent.

The dashboard should show:

- One trace per `assessmentRunId` (sessionId-grouped)
- Each generation showing `inputMessages` / `outputMessages` rendered as
  chat bubbles
- Routing attributes (`darkhunt.tenant_id`, `darkhunt.workspace_id`, etc.)
  visible on the span detail panel
- Token usage / model name / cost on generation spans

> **A clean `flush()` / `shutdown()` is NOT proof the span was ingested.** The
> BatchSpanProcessor exports in the background and **swallows export failures**
> — a 401 (wrong-environment key), 404 (missing `/trace-hub`), or dropped batch
> surfaces only on the OTel **diag** channel, never as a thrown error. So "the
> script ran without throwing" tells you nothing about ingestion. To confirm
> server-side without the dashboard, probe the exact ingest endpoint the
> exporter uses and read the HTTP status:
>
> ```bash
> # good key + routing + (empty body) → 400  (reached the handler: auth+routing OK)
> # wrong/absent key                  → 401  (auth failed — check key↔environment)
> # missing /trace-hub in baseUrl      → 404  (routing/path wrong)
> curl -s -o /dev/null -w '%{http_code}\n' -X POST \
>   -H "Authorization: Bearer $DARKHUNT_API_KEY" \
>   -H 'Content-Type: application/x-protobuf' \
>   -H "X-Workspace-Id: $DARKHUNT_WORKSPACE_ID" \
>   -H "X-Application-Id: $DARKHUNT_APPLICATION_ID" \
>   --data-binary '' \
>   "$DARKHUNT_BASE_URL/otlp/t/$DARKHUNT_TENANT_ID/v1/traces"
> ```
>
> A **400 on the empty-body probe is the success signal** (the request
> authenticated and routed; only the empty protobuf was rejected — the real SDK
> payload would be a 2xx). This curl probe is the **reliable** server-side check.
>
> **Don't count on the in-process OTel diag logger for a success signal.**
> Registering `diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)`
> before constructing the client sounds like it should print the export result,
> but with the current exporter stack (`@opentelemetry/otlp-transformer` 0.218 /
> `sdk-trace` 2.9, verified) it emits **only** the `Registered a global for diag`
> line and **nothing on a successful export** — the OTLP exporter is silent on
> 2xx and logs only on error. A quiet diag channel therefore proves nothing about
> ingestion; treat its silence as "no error seen," not "span landed." Confirm with
> the curl probe above or the dashboard, not the diag logger.

If spans don't appear: check (1) routing fields are populated, (2) baseUrl
points at the right environment **and ends in `/trace-hub`**, (3) for
`internal: false`, the apiKey is valid **and belongs to the same environment as
the baseUrl/tenant** (a wrong-env key → 401), (4) the process actually exits
gracefully so `flush()` runs (a `kill -9` will lose the in-memory batch).

## Common pitfalls

1. **Constructing the client per call.** Causes listener leaks. Use the
   singleton pattern above.
2. **Missing `startTime`.** Span duration shows ~0ms because the span starts
   after the awaited LLM call returns. Always capture `Date.now()` _before_
   the await.
3. **No signal-driven shutdown.** SIGTERM/SIGINT bypasses `beforeExit`, so
   the in-memory span batch is lost. Wire SIGTERM/SIGINT to `client.shutdown()`.
4. **Routing fields scattered across constructor + per-trace.** Pick one
   place per field and stick to it; the constructor is for "constant for the
   process," per-trace args are for "varies per request."
5. **Metadata bloat.** Every key in `metadata` shows up on every dashboard
   row for that span. Promote only summary fields; keep raw debug data on
   the span body (`input`/`output`) where it doesn't pollute the metadata
   view.
6. **Forgetting `trace.end()`.** Spans that never end stay open in BSP and
   never get exported. Always pair `client.trace(...)` with `trace.end()`.
7. **`inputMessages` goes on `generation.update()` — not the `generation()` constructor or
   `.end()`.** `GenerationOptions`/`GenerationEndOptions` reject `inputMessages` (a `tsc` error).
   Rule of thumb: `generation(name, { model, modelParameters, startTime })` → `.update({
inputMessages, systemInstructions })` (known at start) → `.end({ outputMessages, usage })`
   (known at finish).
8. **`Trace.end()` takes no options** — only an optional end time, NOT `{ level, statusMessage }`
   (also a `tsc` error). To record an error, set `level: 'ERROR'` + `statusMessage` on a **span**
   or generation, not on the trace.
9. **Nodes disconnected / gateway node missing / wrong arrows** — see the ⚠️ topology block above.
   These were the biggest real bugs: you must NEST via `parentSpanId` (register OTel globals +
   `openTrace`), give the orchestrator a tool span, link to the real producer, and use self-loops
   (not per-round back-edges) for deep loops.
10. **Reusing an existing app / reaching for raw REST.** Two setup mistakes from a real run
    (see step 2b): (a) grabbing a pre-existing `applicationId` instead of **creating a new,
    dedicated OBSERVABILITY app** — the integration's traces end up in the wrong scope; (b)
    listing/creating apps by curling `…/workflow-manager/api/…` when the **Darkhunt MCP** (or, failing
    that, `darkhunt-cli`) is the intended interface. Use the MCP first; if it isn't connected, offer
    to wire it up — don't silently route around it to raw REST.

## Reference files in attack-discovery

- `src/activities/iterate-llm.ts:124-176` — singleton client + `openGeneration` helper
- `src/activities/iterate-llm.ts:226-275` — `buildTurnSpanMetadata` + `emitTurnSpan` (production span shape)
- `src/worker.ts:77-90` — graceful shutdown on SIGTERM/SIGINT
- `src/config.ts:32-37` — `TELEMETRY_BASE_URL` env wiring

## When to read the SDK docs

The repo README at `/Users/sergey/proj/darkhunt/darkhunt-telemetry-ts/README.md`
is intentionally thin — it covers install, the 4-step integration, common
patterns, and points at the full guide. The full SDK guide is the
docusaurus page at:

`/Users/sergey/proj/darkhunt/docs/docs/darkhunt-ai-security/sdks/typescript.md`
(published as `https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript`)

Read the docs page for:

- Custom masking patterns (`mask.customPatterns`)
- Multi-turn chat sessions (one trace, many generations under it)
- RAG pipelines (retriever span + generation, attribution)
- Streaming with `completionStartTime` for time-to-first-token
- Recording errors with `level: 'ERROR'` + `statusMessage`
- Filling in `userId` / `sessionId` after the trace opens (`trace.update(...)`)
- The full configuration table and env-var precedence
- Built-in masking ruleset (66 rules, 13 markers, validators)

For the canonical attribute mapping (what trace-hub actually reads), see the
"Supported fields" table above and verify against
`/Users/sergey/proj/darkhunt/trace-hub/src/main/resources/mappings/darkhunt.yaml`
when in doubt — that YAML is the contract.

This skill is the integration playbook tuned to the conventions used across
Darkhunt services; the docs page is the user-facing SDK reference.
