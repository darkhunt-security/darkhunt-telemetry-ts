---
name: darkhunt-telemetry-integration
description: |
  Use this skill when integrating `@darkhunt-security/telemetry` (the Darkhunt
  trace-hub TypeScript SDK at /Users/sergey/proj/darkhunt/darkhunt-telemetry-ts)
  into a Node.js / TypeScript service. Covers: install, singleton client setup,
  trace + generation + span emission, backdated `startTime`, graceful shutdown,
  routing-field discipline (tenantId / workspaceId / applicationId /
  assessmentRunId), in-cluster vs public ingest paths, and the masking layer.
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

OpenTelemetry-based span exporter that sends spans (traces, LLM generations,
tool calls, retrievals, guardrails) to any OTLP-compatible receiver — Darkhunt
trace-hub by default, but vanilla OTLP/protobuf so it talks to any backend.
Built-in client-side data masking redacts ~60 secret/PII patterns before
payloads leave the process.

Key shapes:

- **`DarkhuntTelemetry`** — the client. One per process, lifetime-of-the-process.
- **`Trace`** — a single user-facing interaction. Carries routing fields
  (tenant / workspace / application / assessmentRunId).
- **`Generation`** — one LLM round-trip under a trace. Carries `model`,
  `inputMessages`, `outputMessages`, `usage`, `cost`, `metadata`.
- **`Span`** — anything else (tool calls, retrievals, guardrails, sub-agents,
  generic work). Use `observationType` to categorize.

## Step-by-step integration

### 1. Install + pin

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
    assessmentRunId: string;
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
    assessmentRunId: ctx.assessmentRunId,
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

Every span carries four required routing attributes — `tenantId`,
`workspaceId`, `applicationId`, `assessmentRunId`. The exporter groups by
these and posts to `POST /otlp/t/{tenantId}/v1/traces` with
`X-Workspace-Id` / `X-Application-Id` headers.

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
dh.trace({ assessmentRunId: 'run-' + Date.now() }); // tenant/workspace/app inherited

// Multi-tenant: per-trace
const dh = new DarkhuntTelemetry({ apiKey: process.env.DH_API_KEY });
dh.trace({
  tenantId: req.tenantId,
  workspaceId: req.wsId,
  applicationId: 'shared',
  assessmentRunId: 'r',
});
```

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

## When to read the SDK README

Read `/Users/sergey/proj/darkhunt/darkhunt-telemetry-ts/README.md` for:

- Custom masking patterns (`mask.customPatterns`)
- Multi-turn chat sessions (one trace, many generations under it)
- RAG pipelines (retriever span + generation, attribution)
- Streaming with `completionStartTime` for time-to-first-token
- Recording errors with `level: 'ERROR'` + `statusMessage`
- Filling in `userId` / `sessionId` after the trace opens (`trace.update(...)`)
- The full configuration table and env-var precedence

The README is canonical for the SDK API; this skill is the integration
playbook tuned to the conventions used across Darkhunt services.
