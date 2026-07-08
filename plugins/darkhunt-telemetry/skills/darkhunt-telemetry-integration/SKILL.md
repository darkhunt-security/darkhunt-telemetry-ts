---
name: darkhunt-telemetry-integration
description: |
  Use this skill when integrating `@darkhunt-security/telemetry` (the Darkhunt
  trace-hub TypeScript SDK) into a Node.js / TypeScript service. Covers: install,
  creating an API key, singleton client setup, trace + generation + span
  emission, backdated `startTime`, graceful shutdown, routing-field discipline
  (tenantId / workspaceId / applicationId), the masking layer, multi-agent topology
  + agent handoffs (`trace.handoffToken()` / `handoffFrom`, span links, worker-vs-agent,
  loops & cycles), and the canonical SDK-field-to-trace-hub mapping (what attributes the
  backend actually reads). Auto-invoke when the user asks about adding LLM tracing,
  sending spans to Darkhunt trace-hub, integrating Darkhunt observability, wiring
  DarkhuntTelemetry / `client.trace()` / `trace.generation()` calls, or building a
  multi-agent system where agents hand off to each other (agent topology / handoff
  links / loops).
---

# Darkhunt telemetry SDK — integration guide

This skill walks through wiring `@darkhunt-security/telemetry` into a TS/Node
service. The full SDK reference (custom masking, multi-turn chat, RAG retriever
spans, streaming time-to-first-token) lives at
**https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript** — read it when
the user needs something the patterns below don't cover.

## What the SDK is

A Darkhunt span exporter built on OpenTelemetry primitives (TracerProvider,
BatchSpanProcessor, OTLP/protobuf transport) that ships spans — traces, LLM
generations, tool calls, retrievals, guardrails — to Darkhunt trace-hub.
Routing semantics (`tenantId` / `workspaceId` / `applicationId`) and the
attribute schema are Darkhunt-specific; trace-hub is the intended receiver.
Built-in client-side data masking redacts 66 secret/PII patterns before
payloads leave the process.

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

- `package.json` has `"type": "module"` (or the project is otherwise ESM,
  e.g. via `.mts` files). If the project is CommonJS, stop and tell the
  user the SDK won't `require()` cleanly — they need to migrate to ESM or
  use dynamic `import()` from a CJS wrapper, neither of which the agent
  should do silently.
- `package.json` `engines.node` (or the project's CI matrix) satisfies
  `^18.19.0 || >=20.6.0`. If the project pins an older Node (< 18.19), flag
  it and ask before bumping.

Once both check out:

```bash
npm install @darkhunt-security/telemetry
```

### 2. Get an API key

A `dh-...` API key authenticates the SDK to the public ingest endpoint. Create
one in the Darkhunt dashboard:

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

**The env var the key must go in is `DARKHUNT_API_KEY`** — the SDK reads it from
the environment by default:

```bash
DARKHUNT_API_KEY=dh-9028f...your-full-secret...
```

Equivalently, pass it explicitly as the `apiKey` constructor option (an
explicit `apiKey` wins over the env var). Either way it's sent as
`Authorization: Bearer <apiKey>`. If it's missing, the constructor throws:
`apiKey is required for the public endpoint (pass via options, set
DARKHUNT_API_KEY, or use internal: true)`.

While you're on the dashboard, also grab your **`tenantId`**, **`workspaceId`**,
and **`applicationId`** from the [Get started page](https://app.darkhunt.ai/get-started?flow=tool)
and set them as `DARKHUNT_TENANT_ID`, `DARKHUNT_WORKSPACE_ID`,
`DARKHUNT_APPLICATION_ID` — the SDK reads those automatically too (see
[Routing fields](#routing-fields)).

The base URL defaults to `https://api.darkhunt.ai/trace-hub`; override it via the
`DARKHUNT_BASE_URL` env var or the `baseUrl` option when pointing at a
self-hosted / staging / dev trace-hub. **Two rules when you override it:** use the
**ingest API host** (`api…darkhunt.ai`), not the dashboard (`app…darkhunt.ai`,
which redirects POSTs → 405); and **keep the `/trace-hub` path** — the exporter
posts to `{baseUrl}/otlp/t/{tenantId}/v1/traces`, so dropping `/trace-hub` yields 404. Example (dev): `DARKHUNT_BASE_URL=https://api-seth-dev.darkhunt.ai/trace-hub`.

Set **`serviceName`** (option, or `DARKHUNT_SERVICE_NAME` / `OTEL_SERVICE_NAME`) to the OTel
Resource `service.name`. The backend records it per span, so in a multi-service / multi-agent
system give **each process its own** value (e.g. `weather.coordinator`, `weather.geodata`) to tell
producers apart — the Resource is per-`TracerProvider`, so distinct names require distinct
clients/processes, not one shared instance.

For `tool`-type observations, set **`toolName`** (and optionally `toolCallId` / `toolArguments`) on
the span — emitted as `gen_ai.tool.name` / `gen_ai.tool.call.id` / `gen_ai.tool.call.arguments`, the
fields the backend uses to show the actual tool (e.g. "geocode") rather than the generic type.

### 3. Singleton client (process-wide)

**Don't construct `DarkhuntTelemetry` per request.** The SDK registers a
`process.once('beforeExit', ...)` handler per construction and spins up a
NodeTracerProvider + BatchSpanProcessor each time, so a per-call client leaks
listeners (Node's 10-listener warning) and prevents BSP from batching across
calls. Put it in a dedicated module the rest of the app imports:

```ts
// src/telemetry.ts
import { DarkhuntTelemetry } from '@darkhunt-security/telemetry';

// Reads DARKHUNT_API_KEY, DARKHUNT_TENANT_ID, DARKHUNT_WORKSPACE_ID,
// and DARKHUNT_APPLICATION_ID from the environment.
export const dh = new DarkhuntTelemetry();

export async function shutdownTelemetry(): Promise<void> {
  await dh.shutdown();
}
```

### 4. Wire shutdown on signals

The SDK auto-flushes on `process.beforeExit`, but **not** on signal-driven
shutdown. Long-running servers must wire it up so the in-memory span batch
isn't lost on deploy/restart:

```ts
const shutdown = async (signal: NodeJS.Signals) => {
  console.log(`shutting down (${signal})`);
  await shutdownTelemetry();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
```

For one-shot scripts / CLIs / cron jobs: `await dh.flush()` before returning is
enough — the `beforeExit` hook handles teardown.

### 5. Open trace + generation per LLM call

```ts
import { dh } from './telemetry.js';

export async function handleChat(req, res) {
  const startTime = Date.now(); // capture BEFORE the awaited LLM call

  const trace = dh.trace({
    name: 'chat',
    sessionId: req.session?.id, // groups turns into one conversation timeline
    userId: req.user?.email,
    startTime, // backdate the root span
  });
  const gen = trace.generation('answer', { startTime });

  gen.update({
    inputMessages: [{ role: 'user', content: req.body.message }],
  });

  const reply = await yourLlmCall(req.body.message); // your existing client

  gen.end({
    model: 'claude-opus-4',
    outputMessages: [{ role: 'assistant', content: reply.content }],
    usage: {
      input_tokens: reply.usage.inputTokens,
      output_tokens: reply.usage.outputTokens,
    },
  });
  trace.end();

  res.json({ reply: reply.content });
}
```

**`startTime` backdates the span to a timestamp you captured earlier.** Pass it
(on both the trace root and the generation) whenever the moment the span should
begin is earlier than the line that constructs it. In the example above the
spans are opened _before_ the await, so they already capture the full LLM
latency — `startTime` just pins the start to the exact captured instant rather
than the slightly-later construction line. It becomes essential when you instead
open the generation _after_ the call returns (a common pattern): without it the
span starts post-call and records ~0ms of duration.

`update()` is for fields known at start; `end()` is for fields known when work
finishes. You can pass everything to `end()` if there's no streaming
intermediate state to record. Wrap in `try/catch` and record failures with
`gen.end({ level: 'ERROR', statusMessage: String(err) })`.

## Routing fields

Every span carries three required routing attributes — `tenantId`,
`workspaceId`, `applicationId`. The exporter groups by these and posts to
`POST {baseUrl}/otlp/t/{tenantId}/v1/traces` with `X-Workspace-Id` /
`X-Application-Id` headers.

Set them once at the client level if they're constant for the process (or via
the `DARKHUNT_*` env vars), pass per-trace if multi-tenant. The constructor
merges `constructor arg > env var > default` and `dh.trace()` throws if any
field is still missing.

```ts
// Single-tenant: client-level (or via DARKHUNT_TENANT_ID / _WORKSPACE_ID / _APPLICATION_ID)
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
plumb them through:

- **Express / HTTP handlers** — `req.session?.id` (or signed cookie) →
  `sessionId`; `req.user?.id` or `req.user?.email` → `userId`.
- **Worker / queue jobs** — the job/correlation ID → `sessionId`; the
  invoking customer/account ID → `userId`.

If these aren't known at trace open (auth happens mid-flow), open the trace
anyway and call `trace.update({ userId, sessionId })` once they're known —
all spans created after the update inherit the values.

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

## Metadata discipline

The `metadata` bag is a flat `Record<string, string>` on each span. It shows
up in the trace-hub dashboard and is filterable. Be strict:

- **Emit**: summary fields the operator needs to filter or alert on
  (e.g. `score`, `route`, `outcome`).
- **Don't emit**: raw LLM responses, internal parser flags, per-metric
  breakdowns, anything that's "ops noise". They overwhelm the trace view.
  Keep raw debug data on the span body (`input`/`output`) where it doesn't
  pollute the metadata view.

## Supported fields — SDK ↔ trace-hub mapping

The canonical list of what the SDK emits and what trace-hub reads.

### Trace-level fields

Set on `client.trace({...})` or as constructor defaults on `new DarkhuntTelemetry({...})`.

| SDK option      | Required | trace-hub field                    |
| --------------- | -------- | ---------------------------------- |
| `tenantId`      | yes      | tenant scope                       |
| `workspaceId`   | yes      | workspace scope                    |
| `applicationId` | yes      | application scope                  |
| `name`          | no       | `trace.name`                       |
| `sessionId`     | no       | `trace.sessionId`                  |
| `userId`        | no       | `trace.userId`                     |
| `userEmail`     | no       | `trace.userEmail`                  |
| `tags`          | no       | `trace.tags`                       |
| `release`       | no       | `trace.version` + `serviceVersion` |
| `environment`   | no       | `environment.deployment`           |

### Span-level fields (all spans)

Set on `trace.span(name, opts)` / `trace.generation(name, opts)` / via
`.update(opts)` / `.end(opts)`.

| SDK option        | trace-hub field       | Notes                                                                                                                |
| ----------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `observationType` | `span.type`           | `span` / `tool` / `agent` / `generation` / `event` / `chain` / `retriever` / `evaluator` / `embedding` / `guardrail` |
| `input`           | `content.input`       | masked; objects walked recursively                                                                                   |
| `output`          | `content.output`      | masked                                                                                                               |
| `level`           | `span.level`          | `'DEFAULT'` / `'DEBUG'` / `'WARNING'` / `'ERROR'`                                                                    |
| `statusMessage`   | `error.message`       | masked; sets ERROR status when paired with `level: 'ERROR'`                                                          |
| `version`         | `span.version`        |                                                                                                                      |
| `metadata`        | `span.metadata.<key>` | one attribute per key — never a single JSON blob                                                                     |

### Generation-only fields

Set on `trace.generation(name, opts)` / via `.update(opts)` / `.end(opts)`.
These add to the span fields above.

| SDK option                    | trace-hub field              |
| ----------------------------- | ---------------------------- |
| `model`                       | `model.name`                 |
| `modelParameters`             | `model.parameters`           |
| `inputMessages`               | `content.input`              |
| `outputMessages`              | `content.output`             |
| `systemInstructions`          | `content.system`             |
| `usage.input_tokens`          | `tokens.input`               |
| `usage.output_tokens`         | `tokens.output`              |
| `usage.cache_read_tokens`     | `tokens.cacheRead`           |
| `usage.cache_creation_tokens` | `tokens.cacheCreation`       |
| `cost`                        | `cost.json` + `cost.total`   |
| `completionStartTime`         | `timing.completionStartTime` |
| `promptName`                  | `prompt.name`                |
| `promptVersion`               | `prompt.version`             |

## Multi-agent topology & handoffs

When the service is one agent in a **multi-agent system**, the platform reconstructs the
**agent topology** — who handed off to whom — from **span links** (standard OTel, not a
proprietary format). Wire it with the handoff helper; without links you only get a _star_
under the orchestrator, not the real DAG.

**Identity:** one `serviceName` per agent (e.g. `finance.quant`) — that is the topology node.

**Emit a handoff — two calls:**

```ts
// Upstream agent: expose its entry-span token.
const trace = dh.trace({ name: 'research-agent', sessionId, userId });
// ...work...
const handoff = trace.handoffToken(); // opaque, serialisable string (a W3C traceparent)
return { ...result, handoff };

// Downstream agent: declare its upstream(s). Fan-in = pass several.
const trace = dh.trace({ name: 'analyst-agent', handoffFrom: [research.handoff, quant.handoff], sessionId, userId });
```

`handoffFrom` accepts `HandoffToken` strings **or** OTel `Context`s; each becomes an
`agent_handoff` span link on the trace's **root span**. The orchestrator threads each
upstream's `handoffToken` into the downstream's `handoffFrom` — wherever it already passes
that agent's output as the next agent's input. Cross-process (Temporal / queue / HTTP): the
token is a string, so carry it in the workflow arg / message / header like any other value.

**Emit the right spans so the graph reads correctly:**

- **Agent vs Worker** — a node with ≥1 `generation` span renders as an **Agent** (model, cost,
  and the AI-risk surface); a tools-only node renders as a **Worker** (no cost, can't be
  jailbroken/injected). Emit `trace.generation(...)` for every real LLM call.
- **Per-agent model + cost** — set `model` + `usage` on each `generation`.
- **Self-loop `↻ ×N`** — automatic. N = the agent's cross-service entry spans (how many times it
  was invoked). A retry loop or N debate rounds ⇒ N entry spans ⇒ `↻ ×N`.
- **Cycle `↺` between two agents** — needs a **back-edge**. On a retry / re-review, add the
  _prior_ agent to the next agent's `handoffFrom` (e.g. the retried `remediation` links to the
  failed `verify`; each debate `rebuttal` links to the opposing `thesis`). A one-directional flow
  won't draw a cycle — the back-link does.

**Gotchas (each was a real bug):**

1. **Never link to a throwaway span.** `handoffToken()` targets the always-exported root span. A
   helper span created and `.end()`-ed immediately gets dropped on fast (sub-second, tool-only)
   agents → the downstream link dangles → **no edge**. Use `handoffToken()` / `handoffFrom` only.
2. **Fan-in is `handoffFrom: [a, b, c]`** — a span has one parent but can link to many upstreams.
3. **Don't infer handoffs from the call graph** — the orchestrator calls everyone (a star).
   Declare the causal edges yourself via `handoffFrom`.
4. **You don't set the `darkhunt.link.kind` marker** — the SDK tags handoff links for you. Don't
   route non-handoff OTel links through `handoffFrom`.

## Verification

After wiring, run:

```bash
npx tsc --noEmit          # ensure types resolve
npm test                  # if the integration has unit-test coverage
```

Then exercise a real path that emits a span and check trace-hub for the
incoming trace. The dashboard should show one trace per `sessionId`, each
generation rendering `inputMessages` / `outputMessages` as chat bubbles, the
routing attributes on the span detail panel, and token usage / model / cost on
generation spans.

If spans don't appear, check: (1) routing fields are populated, (2) `baseUrl`
points at the right environment, (3) the `apiKey` is valid, (4) the process
exits gracefully so `flush()` runs (a `kill -9` loses the in-memory batch).

## Common pitfalls

1. **Constructing the client per call.** Causes listener leaks. Use the
   singleton module above.
2. **Opening a span after the work, without `startTime`.** If you construct the
   generation _after_ the awaited call returns, its duration shows ~0ms. Capture
   `Date.now()` before the call and pass it as `startTime` to backdate the span.
3. **No signal-driven shutdown.** SIGTERM/SIGINT bypasses `beforeExit`, so
   the in-memory span batch is lost. Wire SIGTERM/SIGINT to `dh.shutdown()`.
4. **Routing fields scattered across constructor + per-trace.** Pick one
   place per field: the constructor (or env vars) for "constant for the
   process," per-trace args for "varies per request."
5. **Metadata bloat.** Every key in `metadata` shows up on every dashboard
   row for that span. Promote only summary fields.
6. **Forgetting `trace.end()`.** Spans that never end stay open in BSP and
   never get exported. Always pair `dh.trace(...)` with `trace.end()`.

## When to read the SDK docs

The full SDK guide — custom masking patterns (`mask.customPatterns`),
multi-turn chat sessions, RAG retriever spans, streaming `completionStartTime`
for time-to-first-token, recording errors with `level: 'ERROR'` +
`statusMessage`, the full configuration + env-var precedence table, and the
built-in 66-rule masking ruleset — is at:

**https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript**
