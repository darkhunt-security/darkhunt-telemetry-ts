---
name: darkhunt-telemetry-integration
description: |
  Use this skill when integrating `@darkhunt-security/telemetry` (the Darkhunt
  trace-hub TypeScript SDK at /Users/sergey/proj/darkhunt/darkhunt-telemetry-ts)
  into a Node.js / TypeScript service. Covers: install, singleton client setup,
  trace + generation + span emission, backdated `startTime`, graceful shutdown,
  routing-field discipline (tenantId / workspaceId / applicationId), in-cluster
  vs public ingest paths, the masking layer, and the canonical
  SDK-field-to-trace-hub mapping (what attributes the backend actually reads).
  Auto-invoke when the user asks about adding LLM tracing, sending spans to
  trace-hub, integrating Darkhunt observability, or wiring DarkhuntTelemetry /
  `client.trace()` / `trace.generation()` calls into a service.
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
receiver. Built-in client-side data masking redacts ~60 secret/PII patterns
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
Node 24+. Before adding the dependency, verify the target project:

- `package.json` has `"type": "module"` (or the project is otherwise ESM,
  e.g. via `.mts` files). If the project is CommonJS, stop and tell the
  user the SDK won't `require()` cleanly — they need to migrate to ESM or
  use dynamic `import()` from a CJS wrapper, neither of which the agent
  should do silently.
- `package.json` `engines.node` (or the project's CI matrix) is on Node 24+.
  If the project pins an older Node, flag it and ask before bumping.

Once both check out:

```bash
npm install @darkhunt-security/telemetry
```

Pin a recent published build in `package.json`:

```json
"@darkhunt-security/telemetry": "^0.5.0-build.18"
```

(Match whatever version the user's organisation publishes through CI; the
`-build.N` suffix reflects the CI run.)

### 2. Singleton client (process-wide)

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

### 3. Wire shutdown on signals

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

### 4. Open trace + generation per LLM call

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

### 5. End span with payload

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
const dh = new DarkhuntTelemetry({
  apiKey: process.env.DH_API_KEY,
  tenantId: 't1',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
});
dh.trace({ name: 'chat' }); // tenant/workspace/app inherited

// Multi-tenant: per-trace
const dh = new DarkhuntTelemetry({ apiKey: process.env.DH_API_KEY });
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
| `level`           | `darkhunt.observation.level`          | `span.level`                     | `'DEFAULT'` / `'DEBUG'` / `'WARNING'` / `'ERROR'`                                                                           |
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

## Verification

After wiring, run:

```bash
npx tsc --noEmit          # ensure types resolve
npm run test              # if integration has unit-test coverage
```

Then exercise a real path that emits a span and check trace-hub for the
incoming trace. The dashboard should show:

- One trace per `assessmentRunId` (sessionId-grouped)
- Each generation showing `inputMessages` / `outputMessages` rendered as
  chat bubbles
- Routing attributes (`darkhunt.tenant_id`, `darkhunt.workspace_id`, etc.)
  visible on the span detail panel
- Token usage / model name / cost on generation spans

If spans don't appear: check (1) routing fields are populated, (2) baseUrl
points at the right environment, (3) for `internal: false`, the apiKey is
valid, (4) the process actually exits gracefully so `flush()` runs (a `kill -9`
will lose the in-memory batch).

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
