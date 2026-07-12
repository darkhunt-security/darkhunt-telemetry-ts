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
  _provided the SDK's `dist` has no top-level await_ (it currently doesn't,
  so a plain `import { DarkhuntTelemetry }` compiled to `require()` loads
  fine, e.g. under `ts-node` on Node 25). Verified against this exact CJS
  setup. So:
  - **Node ≥ 22.12:** proceed even if the project is CommonJS. Don't refuse
    up front — wire it and _actually run it once_ to confirm the load (a
    no-TLA guarantee isn't forever). Only if the load fails do you need a
    dynamic-`import()` wrapper or an ESM migration.
  - **Node < 22.12 AND CommonJS:** _then_ the old caution applies —
    `require()` of the ESM package throws `ERR_REQUIRE_ESM`. Stop and tell
    the user; they need to migrate to ESM or use dynamic `import()` from a
    CJS wrapper, neither of which the agent should do silently.
  - Native `"type": "module"` / `.mts` projects: always fine.

Once those check out:

```bash
npm install @darkhunt-security/telemetry
```

**Where the package lives.** It's the scoped package `@darkhunt-security/telemetry`,
published to **GitHub Packages** — browse published versions / builds at
<https://github.com/darkhunt-security/darkhunt-telemetry-ts/pkgs/npm/telemetry>. It also
resolves from the default public npm registry (`npm install` above works with no
`.npmrc` scope config — verified). If a consumer is pinned to GitHub Packages instead,
they'll have a `@darkhunt-security:registry=https://npm.pkg.github.com` line in `.npmrc`.

**Don't hardcode a version from this doc — look up the current one.** Builds ship
continuously (the `-build.N` suffix is the CI run), so any number written here goes stale.
Get the latest from the source of truth and pin what you actually installed:

```bash
npm view @darkhunt-security/telemetry version   # → current published build to pin
# or browse the GitHub Packages page linked above
```

Then pin exactly that in `package.json`, e.g. `"@darkhunt-security/telemetry":
"^<version-from-above>"`. Match whatever version the user's organisation publishes through
CI.

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
> `DARKHUNT_API_KEY_UAT`) _and_ a seth-dev key in `~/.darkhunt/credentials.json`
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
"$(jq -r .apiBaseUrl ~/.darkhunt/credentials.json)/trace-hub"`.)

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
> (`~/.darkhunt/credentials.json`) _and_ serves the MCP itself (`darkhunt-cli mcp`), so it underpins
> the whole MCP-first path. Only if the MCP is unavailable, use the `darkhunt-cli` directly; only if
> _both_ are unavailable should you fall back to hitting the `…/workflow-manager/api/…` REST
> endpoints with curl. **Don't silently drop to raw REST** because listing/creating an app "seems
> easier" — that's off-pattern and brittle. If neither MCP nor CLI is reachable, say so and ask
> before curling the API directly.

**MCP path (primary — do this first).** App creation lives in the Darkhunt **MCP tools**, not a bare
`darkhunt-cli` subcommand (the CLI's own commands are `enroll` / `scan` / `corpus` / `datasets` /
`attack-libraries` / `target` / `playground` / `update` / `mcp` — none of them create an app). The CLI
ships the MCP server (`darkhunt-cli mcp`) that an AI client (e.g. Claude Code) drives, reusing the
credentials from `enroll`.

**Where to get `darkhunt-cli`.** Install it from the official installer releases:
<https://github.com/darkhunt-security/darkhunt-cli-installer/releases> — grab the build for
the user's platform (or run the installer script from that repo). Once installed, `darkhunt-cli`
is on `PATH` and both `enroll` and `mcp` (below) work. If the `darkhunt-cli` command isn't found,
that releases page is where it comes from — point the user there rather than assuming it's an
`npm i -g` package.

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

**Critical: capture `startTime = Date.now()` BEFORE any awaited LLM call** — _if_ you use the
manual `trace.generation()` form. Without `startTime`, the OTel span starts at construction time
(post-LLM-call), so the recorded duration covers only ~0ms of bookkeeping instead of actual LLM
time. Same applies to the trace root span. **Better: prefer the active-context form (§6b), which
times the span automatically and needs no `startTime`.**

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

### 6b. Prefer the active-context form (interop + automatic timing)

The manual `trace.generation(name, { startTime })` → `.end()` pattern works, but the span is never
the **active** OTel span, so (a) you must hand-capture `startTime`, and (b) third-party OTel
auto-instrumentation (the LLM SDK's own spans, an HTTP client) can't nest under it — you get a
walled-off tree. Prefer **`startActiveGeneration`** (and **`startActiveSpan`** for tool /
retriever / guardrail spans): it runs your callback with the span **active** for the awaited call,
ends it when the callback settles (marking ERROR on a throw), and times it automatically.

```ts
const answer = await trace.startActiveGeneration('answer', { model }, async (gen) => {
  gen.update({ inputMessages }); // known at start
  const r = await llm(prompt); // span is ACTIVE here → auto-instrumentation nests; timing is real
  gen.end({ model, outputMessages: r.messages, usage: r.usage });
  return r.text; // becomes the return value of startActiveGeneration
});
```

No `startTime` to capture, and anything OTel-instrumented inside the callback nests under the
generation. `Trace.startActiveSpan(name, opts, fn)` / `Span.startActiveSpan(...)` are the same for
non-LLM spans. (The manual `trace.generation()` / `trace.span()` factories still exist for
streaming, or when you must hold a span open across separate calls.)

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
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  } = { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
  if (u.cache_read_input_tokens != null) usage.cache_read_tokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null)
    usage.cache_creation_tokens = u.cache_creation_input_tokens;
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

| Provider call                                                                     | Observation                                               | Notes                                                                                      |
| --------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Embeddings                                                                        | `trace.span(name, { observationType: 'embedding' })`      | A span has **no** `model` / `usage` field — put the model name + token count in `metadata` |
| Content moderation                                                                | `trace.span(name, { observationType: 'guardrail' })`      | Set `level: 'WARNING'` + `statusMessage` **only when flagged**; omit `level` otherwise     |
| Image generation (DALL·E etc.)                                                    | `trace.generation(name, { model, input: prompt })`        | It produces content → a generation; `output` = the image URL; **no `usage`** to send       |
| Management / async calls (assistant create, fine-tune job, batch submit/retrieve) | `trace.span(name, { observationType: 'tool', toolName })` | These don't run inference themselves (the work is async) — record them as tool spans       |

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

| SDK option        | OTel attribute emitted                | trace-hub field                  | Notes                                                                                                                                                                                   |
| ----------------- | ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observationType` | `darkhunt.observation.type`           | `span.type`                      | one of `span` / `tool` / `agent` / `generation` / `event` / `chain` / `retriever` / `evaluator` / `embedding` / `guardrail`                                                             |
| `input`           | `darkhunt.observation.input`          | `content.input`                  | masked; objects walked recursively                                                                                                                                                      |
| `output`          | `darkhunt.observation.output`         | `content.output`                 | masked                                                                                                                                                                                  |
| `level`           | `darkhunt.observation.level`          | `span.level`                     | SDK `ObservationLevel` = `'DEBUG'` / `'INFO'` / `'WARNING'` / `'ERROR'` (NOT `'DEFAULT'`). **Omit** `level` to get the backend's default; passing `'DEFAULT'` is not a valid SDK value. |
| `statusMessage`   | OTel `setStatus({ message })`         | `error.message` (`_span_status`) | masked; sets ERROR status when paired with `level: 'ERROR'`                                                                                                                             |
| `version`         | `darkhunt.version`                    | `span.version`                   |                                                                                                                                                                                         |
| `metadata`        | `darkhunt.observation.metadata.<key>` | `span.metadata.<key>`            | one OTel attr per key — never a single JSON blob (backend can't iterate)                                                                                                                |

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
> cost (verified: a generation sent with usage but _no_ `cost` rendered `$0.0002`).
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
it must still run for a user who has _no_ Darkhunt account, and it's usually a
folder of many independent one-shot entry scripts rather than one server. Two
patterns make that clean.

### Opt-in / graceful degradation — never crash the host app

The client is **not** safe to construct unconditionally here: on the public
endpoint the constructor **throws** if `apiKey` is missing, and `dh.trace()`
**throws** if any routing field is missing. So a bare `new DarkhuntTelemetry()`
in a sample script breaks `node examples/foo.js` for anyone who just wants to
try the underlying SDK. Gate on config presence and no-op when absent:

```ts
const REQUIRED = [
  'DARKHUNT_API_KEY',
  'DARKHUNT_TENANT_ID',
  'DARKHUNT_WORKSPACE_ID',
  'DARKHUNT_APPLICATION_ID',
];
const enabled =
  process.env['DARKHUNT_ENABLED'] !== 'false' && REQUIRED.every((k) => !!process.env[k]);

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
  if (!entry) return 'my-sdk-examples'; // e.g. `node -e ...` → argv[1] is undefined
  const rel = path.relative(ROOT, entry);
  if (!rel || rel.startsWith('..')) return 'my-sdk-examples';
  const parts = rel
    .replace(/\.[cm]?js$/i, '')
    .split(path.sep)
    .filter((s) => s && s !== 'index');
  return ['my-sdk-examples', ...parts].join('.'); // chat/vision.js → my-sdk-examples.chat.vision
}
```

Two things to know: these nodes are **independent by design** — each script
opens its own root trace with no handoffs, so they render as disconnected
islands (that's correct; they're unrelated demos, not a multi-agent graph). And
a node only appears **after it has emitted at least one trace** — a service with
zero spans shows up nowhere, so "I don't see my other examples" just means those
scripts haven't run yet. (These are all still **one application** — the split is
`service.name`, not `applicationId`.)

> **You MUST tell the user the topology will render as disconnected nodes — and
> why — before you call the integration done.** An island graph is the _correct_
> output for a repo of independent single-agent scripts, but if you hand it over
> without a word, the user opens the Topology tab, sees unconnected cards, and
> reads it as a broken integration. Pre-empt that: see "On completion, report the
> topology shape" below — it applies to every integration, not just this archetype.

## Multi-agent topology & handoffs

When the service is one agent in a **multi-agent system**, the platform reconstructs the
**agent topology** — who handed off to whom. **Identity:** one `serviceName` per agent (e.g.
`finance.quant`) — that is the topology node.

### How much do you actually need? (least → most divergence from vanilla OTel)

Reconstruction is built to work off **standard OTel signals**, so the baseline needs **nothing**
Darkhunt-specific. Add custom bits only to sharpen the graph — pick the lowest level that gets you
the graph you need:

| Level                 | You emit                                                                                | You get                                                                          | Darkhunt-specific?                                                                     |
| --------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **0 — zero friction** | Plain **nested** OTel spans + one `service.name` per agent (normal context propagation) | The **call-graph** topology (walked from the `parentSpanId` cross-service chain) | **Nothing** — it's just OTel                                                           |
| **1 — low friction**  | + standard OTel **span links** (consumer → producer) where data-flow ≠ call-flow        | The **data-flow** topology (fan-in, real producer, loops)                        | Standard OTel links; **no marker required** — an unmarked link is treated as a handoff |
| **2 — precision**     | + `darkhunt.link.kind = agent_handoff` on those links                                   | Same, disambiguated from non-handoff link uses (batch/messaging)                 | The marker attribute                                                                   |
| **3 — ergonomics**    | The SDK's `trace.handoffToken()` / `handoffFrom`                                        | Same, with fan-in arrays + token plumbing handled for you                        | The SDK helpers                                                                        |

**Principle: minimum divergence.** Nesting (Level 0) is _standard OTel context propagation_, not a
Darkhunt invention — a normally-instrumented app already produces it, and for a **linear** pipeline
the call graph **is** the data-flow graph, so you're done with zero custom code. Reach for **links**
(Level 1) only where the data flow genuinely differs from the call flow — fan-in from several
services, a loop, an async producer→consumer. The **marker** (Level 2) and the **SDK helpers**
(Level 3) are optional sugar: the marker only to disambiguate handoff links from other OTel link
uses; the helpers for fan-in-array + token ergonomics. Don't push an integrator up the ladder further
than their graph requires.

### ⚠️ Each agent's entry span must SURVIVE ingestion — nest, or carry a link (verified against the pipeline, 2026-07)

> **This is the single most important thing to get right.** Reconstruction is **links-first with a
> `parentSpanId`-chain fallback**: an `agent_handoff` link draws the edge if the span has one, else
> the nearest cross-service ancestor along the parent chain does. **Either way the edge only forms if
> the upstream span it points at still exists** — and ingestion **drops a contentless span** (an
> agent's root span usually is — its generations/tools are child spans) **unless** it is a
> _cross-service entry_ (has a `parentSpanId` into another service). So the failure mode is:
>
> - **Nest** (standard OTel context propagation) → each agent root is a cross-service entry → kept →
>   the parent chain (and any links) connect it. Robust, zero-config default.
> - **Don't nest AND don't link** (each agent opens its own root trace, no links) → the contentless
>   roots are **dropped** → nothing to connect → **disconnected islands** (a real bug we hit:
>   ingestion looked perfect — per-agent generations/tools/models/cost all correct — but the Topology
>   tab showed unconnected cards).
>
> Nesting is the safe path because it satisfies **both** the parent-chain reconstruction **and** span
> retention at once. _(An earlier version of this note said "the builder uses parent-child, not
> links." That was imprecise — the builder **does** honor `agent_handoff` links; the islands came
> from the content filter dropping the link **targets**, which nesting prevents. Links-only can work
> if the link targets are retained — but that leans on ingestion keeping link-carrying roots, so
> nesting stays the recommended default.)_

**The simplest way to connect the graph — and the closest to vanilla OTel — is to NEST each agent's
trace under its caller.** Two things make that happen:

1. **A global OTel context manager + propagator must be registered** — otherwise `context.with()`
   is a no-op and every `dh.trace()` starts a fresh root with no parent. **As of SDK ≥ 0.5.4 the SDK
   does this for you automatically** when you construct `new DarkhuntTelemetry()` (it registers the
   global context manager + W3C propagator, without registering its TracerProvider globally, so it
   won't hijack a host's OTel). So on current versions there is **nothing to wire up** — just
   construct the client before the first `client.trace(...)` call.

   Only if the target app **manages its own OTel context** (or is pinned to SDK < 0.5.4) do you
   register it yourself, once, before any client/trace — and opt the SDK out with
   `new DarkhuntTelemetry({ registerContextManager: false })` (or `DARKHUNT_REGISTER_CONTEXT_MANAGER=false`):

   ```ts
   // ONLY needed on SDK < 0.5.4, or when you deliberately manage OTel yourself:
   import { context, propagation } from '@opentelemetry/api';
   import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
   import { W3CTraceContextPropagator } from '@opentelemetry/core';

   context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
   propagation.setGlobalPropagator(new W3CTraceContextPropagator());
   ```

2. **Nesting is automatic — just pass `handoffFrom` to `client.trace()`.**
   `client.trace({ handoffFrom: [callerToken] })` makes the agent's root span a **child** of
   `handoffFrom[0]` on its own (`parentSpanId` set, shared `trace_id`) AND keeps it as an
   `agent_handoff` link. The caller's token is its `handoffToken()` (a W3C traceparent).
   `Trace.span()/generation()` already parent under the trace's own root, so the SDK only has to
   parent the root — which it does from `handoffFrom[0]`. You don't wrap `client.trace()` in anything;
   the context plumbing is inside the SDK. `handoffFrom[0]` is the **parent edge** (the topology
   arrow); any further entries stay supplementary links (fan-in). A whole task lands in **one trace**,
   nested — verify with: all of a task's spans share a single `trace_id`.

**Emit the handoff token** the same way (it's what feeds the downstream's `handoffFrom`):

```ts
// Upstream agent: nest under its own caller, then expose its entry-span token.
const trace = client.trace({ name: 'research-agent', sessionId, userId, handoffFrom });
// ...work...
return { ...result, handoff: trace.handoffToken() }; // opaque W3C-traceparent string

// Downstream agent: handoffFrom[0] is the parent (nests); more entries = fan-in links.
const trace = client.trace({
  name: 'analyst-agent',
  handoffFrom: [research.handoff, quant.handoff],
  sessionId,
  userId,
});
```

### Keep the token out of business signatures — carry it in ambient context

The token is observability plumbing, so it should never be a typed `handoff` **parameter** on your
agent functions, entry inputs, message/return types, or graph state. Threading it there couples
business code to telemetry — the tell is that _removing_ telemetry later forces edits to domain
signatures across every agent. Instead, carry it the way OTel carries trace context: **out-of-band,
in an ambient async-context store**, so agents read the upstream token and publish their own without
it ever appearing in a signature.

```ts
// handoff-context.ts — a tiny AsyncLocalStorage carrier (mirrors Temporal's `currentHandoff()`).
import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage<{ token?: string }>();
export const withHandoff = <T>(token: string | undefined, fn: () => T): T => als.run({ token }, fn);
export const currentHandoff = (): string | undefined => als.getStore()?.token;
export const publishHandoff = (token: string): void => {
  const s = als.getStore();
  if (s) s.token = token;
};
```

```ts
// The gateway seeds the scope with its root token; agents pass only DATA (no `handoff` arg).
await withHandoff(root.handoffToken(), async () => {
  const plan = await coordinator(task);
  const weather = await geodata(plan);
  return advisor(weather);
});

// Each agent reads its upstream from ambient context and publishes its own for whatever runs next:
function coordinator(task) {
  const parent = currentHandoff();
  const trace = client.trace({
    name: 'coordinator-agent',
    sessionId,
    userId,
    handoffFrom: parent ? [parent] : [],
  });
  publishHandoff(trace.handoffToken());
  // ...business work; returns business data only...
}
```

**Cross-process is the same idea one level up:** the token rides the transport's metadata channel
(next section), and the consumer lifts it off the header/field into `handoffFrom` (or an ambient
store) _on entry_ — it still never becomes a business field. The Temporal path already does exactly
this: an activity interceptor reads the Temporal Header into `currentHandoff()`, and the activity
passes that to `client.trace({ handoffFrom })`.

### Carrying the handoff token across each transport

**The token is an opaque W3C `traceparent` STRING, and it belongs in the transport's METADATA /
HEADER channel — NOT in the business payload (args / body / message data).** Producer mints it with
`trace.handoffToken()` (or `span.handoffToken()`); consumer nests under it with
`client.trace({ handoffFrom: [token] })`. Carry it **out of band** on every transport, exactly like the
HTTP `traceparent` header — smuggling trace context into your domain args/body couples business data
to observability plumbing. The transport is otherwise irrelevant; the only thing that changes is
which metadata channel carries the string. Every transport still needs the two universals above
(a global OTel context manager — the SDK auto-registers it; and one `service.name` per agent).

**Don't hand-roll the metadata plumbing — the SDK ships it.** Instead of reading/writing header/field
strings yourself, use the official helpers:

- **HTTP** — `@darkhunt-security/telemetry/transports`: `handoffToHttpHeaders(token, headers?)` (producer)
  and `handoffFromHttpHeaders(headers)` (consumer; case-insensitive, accepts Express `req.headers` or a
  WHATWG `Headers`).
- **Queue** — `@darkhunt-security/telemetry/transports`: `handoffToMessageMeta(token, meta?)` (producer,
  keyed by `HANDOFF_MESSAGE_META_KEY`, kept out of `data`), `handoffFromMessageMeta(meta)` and
  `handoffsFromMessages(metas)` (consumer; the latter is the **fan-in** reader → an ordered, de-duped array).
- **Temporal** — `@darkhunt-security/telemetry/temporal`: `handoffWorkflowInterceptors` +
  `handoffActivityInterceptors()` + `currentHandoff()` carry the token in a **Temporal Header**;
  `childArgs(input, handoffFrom)` authors a per-edge override. Register the workflow interceptor from the
  **sandbox-safe** subpath `@darkhunt-security/telemetry/temporal/workflow` (the worker-side barrel pulls
  in `node:async_hooks` and must never be imported from workflow code). See the per-transport notes below.

| Transport                         | Metadata / header channel (NOT the payload)                                                                       | Producer                                                         | Consumer                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Temporal**                      | a **Temporal Header** (via `handoffWorkflowInterceptors` / `handoffActivityInterceptors`) — NOT the workflow args | interceptors set the header; `childArgs` for a per-edge override | `currentHandoff()` → `client.trace({ handoffFrom })`                    |
| **HTTP**                          | the standard **`traceparent` header** (W3C Trace Context)                                                         | `handoffToHttpHeaders(handoff, headers)`                         | `handoffFromHttpHeaders(req.headers)` → `client.trace({ handoffFrom })` |
| **Queue** (Redis/Kafka/…)         | a **message header / attribute** kept out of `data` (`HANDOFF_MESSAGE_META_KEY`)                                  | `handoffToMessageMeta(handoff)`                                  | `handoffsFromMessages(metas)` → `client.trace({ handoffFrom })`         |
| **In-process graph** (LangGraph…) | a field in the **graph state**                                                                                    | node writes `state.handoff`                                      | node reads `state.handoff` → `client.trace({ handoffFrom })`            |

- **HTTP** — use the **standard `traceparent` header**, NOT a body field. It's the W3C convention, so
  any OTel-instrumented service propagates it for free, and the request body stays pure business data.
  **Fan-in** is natural: each incoming request carries its own `traceparent`; the consumer collects
  one per caller.
- **Queue** — carry the token in the **message header / attribute, not the body**. Kafka has native
  record headers; SQS has message attributes; NATS/AMQP have headers; a raw Redis stream has no header
  concept, so use a **dedicated stream field** kept separate from the serialized payload
  (`XADD … traceparent <token> data <json>` — never inside `data`). The stream is durable, so
  ordering/timing don't matter (a consumer that runs first just waits); **read the upstream
  message(s) first** — you need the token before you open the nested trace. Fan-in = an array of
  tokens. The queue itself is invisible to the graph (only `publish`/`consume` tool spans); edges stay
  agent→agent.
- **Temporal** — the token belongs in a **Temporal Header**, not the workflow args (your business
  inputs). The SDK ships the interceptors: register `handoffWorkflowInterceptors` (from the sandbox-safe
  `@darkhunt-security/telemetry/temporal/workflow` subpath) as a `workflowModules` entry and
  `handoffActivityInterceptors()` on the activity side; the activity reads its upstream token via
  `currentHandoff()` and passes it as `handoffFrom` to `client.trace(...)`. For a deliberate agent→agent
  edge that differs from the call graph (link to the real producer; self-loops vs back-edges — see below),
  the coordinator authors a **per-edge override** with `childArgs(input, [chosenToken])` on the
  `executeChild` call — the workflow interceptor relocates it into the header and strips it from the
  child's args. And **never instrument workflow code** (deterministic sandbox — no network/timers, so no
  SDK): telemetry lives in activities + the gateway; an activity retry re-runs its LLM+tool loop and
  re-emits spans.
- **In-process graph** (LangGraph, etc.) — there's no wire header in-process, so the token rides in
  the graph **state** (or ambient OTel context). Still give each node **its own `service.name`
  client** (`agentClient('domain.node')`) and thread the token node→node (a node writes its
  `handoffToken()` into state; the next reads it as `handoffFrom`), or the nodes collapse into one
  undifferentiated blob.

  (The reference demo now uses these SDK helpers on every transport — the Temporal Header via
  `handoffWorkflowInterceptors`/`handoffActivityInterceptors`, the HTTP `traceparent` header via
  `handoffToHttpHeaders`/`handoffFromHttpHeaders`, and a dedicated Redis-stream field via
  `handoffToMessageMeta`/`handoffsFromMessages` — so the token never rides in the business payload.)

### The orchestrator/gateway node — hand off from its root

Ingestion **retains a trace ROOT span even when it's contentless** (the root anchors the topology), so
a gateway/orchestrator that only fans work out survives on its own — just open the root and hand off
from it. Put the task on the root's `input` so the node still carries content in the dashboard:

```ts
const root = dh.trace({ name, sessionId, userId, input: { task } });
const handoff = root.handoffToken(); // pass into the first agent's handoffFrom
```

A `dispatch` **tool span** on the gateway is optional — add one only to record an explicit dispatch
action; to hand off from that span instead of the root, use `dispatch.handoffToken()`.

### Link to the REAL producing agent, not the orchestrator

Thread the token **wherever one agent's output becomes the next agent's input** — that is the
true data dependency, and it's the edge the graph should show. Linking a downstream agent back to
the _orchestrator_ (because the orchestrator spawned it) yields a plausible-but-WRONG graph. Real
bug: an `advisor` that consumes the `geodata` agent's forecast was linked to the `coordinator`, so
it rendered as a parallel sibling of `geodata` instead of downstream of it. Fix: `advisor`'s
`handoffFrom` = `[geodata.handoff]` → `coordinator → geodata → advisor`.

### Logical coupling through a datastore/queue ≠ a drawn edge — flag it to the user EXPLICITLY

When two services are related only through an **indirect medium** — a shared database, vector
store, object bucket, cache, or a queue/file/table the handoff token does **not** ride on — there
is **no `parentSpanId` chain between them**, so the topology renders them as **disjointed islands**
even though a human sees an obvious data dependency. This is frequently _correct_: they're separate
processes, often run at different times. The canonical case is a **RAG app**: an `ingest` service
scrapes → embeds → **writes** the vector store, and an `answer` service later **reads** it. Real
dependency, but **not a live handoff** — nothing carries a trace context from one to the other, so
the SDK has nothing to nest. (Verified live: a RAG demo's `ingest` WORKER and `answer` AGENT
rendered as two independent cards, linked in reality only by the Astra collection across runs.)

**Do NOT silently synthesize an edge, and do NOT let the user assume it will auto-connect.** If you
detect a logical connection that the current code does not thread a token through, you MUST call it
out — say plainly that linking the agents is an **architecture change, not a telemetry tweak**:

- `handoffToken()` returns a **plain string**; to draw the edge you have to **carry it across the
  medium** — persist it next to the data (an extra column/field on the row the producer writes and
  the consumer reads back), put it in the queue message / file metadata / HTTP header, etc. — and
  have the downstream service pass it as `handoffFrom[0]` (see the ⚠️ nesting block above).
- If the architecture has **nowhere to thread that token** (e.g. producer and consumer run in
  unrelated invocations with only a datastore between them), the nodes **will stay disjointed, and
  that is the honest picture** — surface it, don't fake a link.

Put it to the user in concrete terms, e.g.:

> "`ingest` and `answer` share the vector DB but never hand off in one live flow, so the graph shows
> two independent nodes. Connecting them isn't a telemetry setting — it needs an **architecture
> change**: store the ingest run's `handoffToken()` alongside the vectors (or in whatever record
> `answer` reads) and have `answer` pass it back as `handoffFrom`. Otherwise these agents stay
> disjointed. Want that change, or is independent the truthful shape here?"

Make this **explicit** every time you spot the pattern — a shared store, a message the token isn't
on, a cron/batch boundary. The user should never be surprised later that "obviously related"
services show up unconnected; you flagged it and named the architectural work required.

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

1. **Nodes disconnected → each agent opened its own root trace with no nesting.** Nest by passing the
   caller's token as `handoffFrom` to `client.trace(...)` (the SDK auto-nests + registers the context
   manager for you). See the ⚠️ block above.
2. **Gateway/orchestrator node missing** — hand off from `root.handoffToken()` (the root is retained
   even when contentless). A `dispatch` tool span is optional — add one only to record an explicit
   dispatch action.
3. **Wrong arrows → linked to the orchestrator instead of the real producer.** Link where output→input.
4. **Never link to a throwaway span.** `handoffToken()` targets the always-exported root span; a
   helper span created and `.end()`-ed immediately can be dropped on fast agents → dangling link.
5. **Fan-in is `handoffFrom: [a, b, c]`** — `[0]` is the parent edge; the rest are links.
6. **Don't infer handoffs from the call graph** — the orchestrator calls everyone (a star). Declare
   the causal edges via `handoffFrom`.
7. **Logical link but no token threaded → nodes stay disjointed, and you MUST say so.** If services
   are coupled only through a datastore / queue / batch boundary (classic RAG `ingest`→`answer`),
   there's no `parentSpanId` chain to nest, so they render as islands. Tell the user explicitly that
   connecting them is an **architecture change** (carry `handoffToken()` across that medium), not a
   telemetry setting — see "Logical coupling through a datastore/queue" above.

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
>
> - workspace management) — there is **no tracing-query / read-trace tool**. So
>   from the agent side you have exactly two checks: **(1)** the curl empty-body
>   probe below, which confirms **auth + routing only** (a 400), and **(2)** the
>   human opening the dashboard. There is no API to assert "span X landed." Tell
>   the user that final confirmation is theirs to eyeball; don't claim you verified
>   ingestion programmatically.

> **Verify through the real integration, not a throwaway probe script.** A probe
> that emits a span under a _different_ `serviceName` (e.g. `ingest-verify`) mints
> a **whole separate node in the Topology view** — and it renders as its own Agent
> with a `↻ ×N` self-loop for each time you ran it. There's no delete-trace API, so
> that node is **permanent noise** in the OBSERVABILITY app (verified this run: a
> `ingest-verify` probe left a standing `↻ ×2` agent card next to the real one).
> Prefer the two clean checks: **(1)** the curl endpoint probe above (server-side,
> emits nothing), and **(2)** running the _actual_ instrumented code path and
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

## On completion, report the topology shape to the user

**Finishing the wiring is not the last step — telling the user what their
Topology view will (and won't) show is.** The dashboard's Topology tab is the
first thing most users open, and a graph of **disconnected nodes is a perfectly
correct result** for many architectures. But an unconnected graph handed over
_without explanation_ reads as a broken integration — the user assumes the
handoff/nesting silently failed and files it as a mistake. So close every
integration with an explicit, one-paragraph statement of the topology shape and
the reason for it. Do this proactively; don't wait to be asked.

Decide which case you're in and say so:

- **Connected graph (real handoffs wired).** A global OTel context manager is registered (automatic
  on SDK ≥ 0.5.4) and you threaded `handoffToken()` / `handoffFrom` so agents nest via `parentSpanId`.
  Tell the user which edges to expect (`coordinator → geodata → advisor`, self-loops,
  etc.) so they can confirm the graph matches the intended causal DAG.

- **Disconnected nodes (no handoffs — and that's correct).** The services are
  independent processes with no live agent→agent handoff (a repo of standalone
  single-agent scripts; a producer/consumer pair coupled only through a
  datastore, queue, or batch boundary; a set of unrelated example entry points).
  There is **no `parentSpanId` chain**, so trace-hub has nothing to nest and the
  nodes render as islands. **State this before the user sees it**, name the
  reason, and make clear that connecting them would be an **architecture change,
  not a telemetry setting** (carry a `handoffToken()` across the boundary — see
  the ⚠️ nesting block and "Logical coupling through a datastore/queue"). Offer
  the change if it's actually wanted; otherwise confirm that independent is the
  honest shape.

Concrete wording for the disconnected case (adapt to the repo):

> "These six examples are independent single-agent scripts — each runs as its own
> process and none hands off to another, so the Topology view will show them as
> **separate, unconnected nodes**. That's the correct picture, not a
> misconfiguration: Darkhunt draws edges from the cross-service `parentSpanId`
> chain, and there is no such chain here (the shared budget PDF in a few of them
> is a data source across separate runs, not a live handoff). Connecting them
> would require real handoffs with token threading — an architecture change, not
> a telemetry tweak. Want that, or is independent the truthful shape here?"

If the repo will be run by others (an OSS / examples repo), also **persist this
note in the repo** (a short "Why the topology shows separate nodes (expected)"
subsection in the README's telemetry section), so whoever runs it later reaches
the same understanding without you in the loop.

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
   You must NEST via `parentSpanId` — pass the caller's token as `handoffFrom` to `client.trace(...)`
   (the SDK registers the context manager and auto-nests), hand off from the orchestrator's root,
   link to the real producer, and use self-loops (not per-round back-edges) for deep loops.
10. **Reusing an existing app / reaching for raw REST.** Two setup mistakes from a real run
    (see step 2b): (a) grabbing a pre-existing `applicationId` instead of **creating a new,
    dedicated OBSERVABILITY app** — the integration's traces end up in the wrong scope; (b)
    listing/creating apps by curling `…/workflow-manager/api/…` when the **Darkhunt MCP** (or, failing
    that, `darkhunt-cli`) is the intended interface. Use the MCP first; if it isn't connected, offer
    to wire it up — don't silently route around it to raw REST.
11. **Handing over a disconnected topology without explaining it.** When the finished integration
    correctly renders as independent, unconnected nodes (a repo of standalone single-agent scripts;
    services coupled only through a datastore/queue), the user opens the Topology tab, sees islands,
    and assumes the integration is broken. You must proactively state — before they see it — that the
    disconnected graph is the _correct_ shape and why (no agent→agent handoff → no `parentSpanId`
    chain to nest), and that connecting them is an architecture change, not a telemetry setting. See
    "On completion, report the topology shape to the user." For OSS/example repos, persist that note
    in the README too.

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
