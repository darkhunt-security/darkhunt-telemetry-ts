# darkhunt-telemetry-ts

LLM observability SDK for DarkHunt trace-hub. Built on OpenTelemetry, sends OTLP traces with `darkhunt.*` attributes.

TypeScript port of [`darkhunt-telemetry`](https://github.com/darkhunt-security/darkhunt-telemetry) (Python). Same wire format, same routing semantics — both libraries can target the same trace-hub.

Single client, single batched exporter — routes spans to the correct tenant endpoint at export time.

## Install

```bash
echo "@darkhunt-security:registry=https://npm.pkg.github.com" >> .npmrc
npm install @darkhunt-security/telemetry
```

Requires a Darkhunt-org GitHub PAT with `read:packages` in `~/.npmrc` (same setup used by `dashboard`, `darkhunt-runner`, etc.).

## Quick start

```ts
import { DarkhuntTelemetry } from '@darkhunt-security/telemetry';

const dh = new DarkhuntTelemetry({
  baseUrl: 'https://app.darkhunt.ai',
  apiKey: process.env.DH_API_KEY,
});

const trace = dh.trace({
  name: 'chat',
  tenantId: 'my-tenant',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
  assessmentRunId: 'run-1',
  sessionId: 'sess-1',
  userId: 'alice@example.com',
});

const gen = trace.generation('llm-call', {
  model: 'claude-opus-4',
  input: [{ role: 'user', content: 'Hello' }],
});
// ... call your LLM ...
gen.end({
  output: { role: 'assistant', content: 'Hi!' },
  usage: { input_tokens: 100, output_tokens: 50 },
});

trace.end();
await dh.flush();
```

## Lifecycle

The SDK batches spans in memory and exports them asynchronously, so you must drain the buffer before your process exits.

- **`dh.flush()`** — wait for in-flight batches to send. The provider stays alive; safe to call mid-process (e.g. between requests, after a critical span).
- **`dh.shutdown()`** — flush, then tear down the provider. The instance becomes unusable afterwards. Call this on graceful shutdown.

The constructor registers a `process.once('beforeExit', …)` handler that calls `shutdown()` automatically. This covers short scripts and natural process exit, but **not** signal-driven shutdown — long-running servers should wire it up explicitly:

```ts
const dh = new DarkhuntTelemetry();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await dh.shutdown();
    process.exit(0);
  });
}
```

For one-shot scripts (CLI tools, cron jobs), `await dh.flush()` before returning is sufficient — the `beforeExit` hook will handle teardown.

## Configuration

| Option            | Env var                   | Default                 |
| ----------------- | ------------------------- | ----------------------- |
| `baseUrl`         | `DARKHUNT_BASE_URL`       | `http://localhost:8080` |
| `apiKey`          | `DARKHUNT_API_KEY`        | _(required)_            |
| `enabled`         | `DARKHUNT_ENABLED`        | `true`                  |
| `release`         | `DARKHUNT_RELEASE`        |                         |
| `environment`     | `DARKHUNT_ENVIRONMENT`    |                         |
| `flushAt`         | `DARKHUNT_FLUSH_AT`       | `20` spans              |
| `flushIntervalMs` | `DARKHUNT_FLUSH_INTERVAL` | `5s`                    |
| `timeoutMs`       | `DARKHUNT_TIMEOUT`        | `10s`                   |

> Constructor options ending in `Ms` take **milliseconds**; the matching env vars take **seconds** (the SDK converts them). Defaults above show the effective value.

`apiKey` is a Darkhunt API token (`dh-...`). It's sent as `Authorization: Bearer <apiKey>` to the public OTLP ingestion endpoint (`POST /otlp/t/{tenantId}/v1/traces`). The constructor throws if `enabled` is `true` and no key is provided.

Precedence for every option: **constructor argument > env var > default**. Pass options explicitly to override anything coming from the environment:

```ts
// 1. All from env
const dh = new DarkhuntTelemetry();

// 2. Explicit options take priority over env
const dh = new DarkhuntTelemetry({
  baseUrl: 'https://seth-dev.darkhunt.ai',
  apiKey: devKey,
});

// 3. Mix — explicit option overrides only that field
const dh = new DarkhuntTelemetry({ apiKey: someKey }); // baseUrl from env
```

This is also how the [`darkhunt-cli`](https://github.com/darkhunt-security/darkhunt-cli) wires the SDK: the CLI reads `DH_API_KEY` / `DH_API_BASE_URL` (its own env-var prefix) and forwards them as explicit options, so end users don't have to set both `DH_*` and `DARKHUNT_*` vars.

Routing parameters (`tenantId`, `workspaceId`, `applicationId`, `assessmentRunId`) are required per trace — not on the client. Optional trace-level parameters (`sessionId`, `userId`, `tags`, `metadata`) are propagated to all child spans.

## API

### Traces

```ts
const trace = dh.trace({
  name: 'chat',
  tenantId: 't1',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
  assessmentRunId: 'run-1',
  sessionId: 'sess-1',
  userId: 'alice@example.com',
  tags: ['prod'],
  metadata: { key: 'value' },
});
trace.end();
```

### Spans

```ts
const span = trace.span('preprocess', { input: 'raw data' });
// ... do work ...
span.end({ output: 'processed data' });
```

Use `observationType` to categorize spans:

```ts
trace.span('weather-api', { observationType: 'tool', input: { city: 'NYC' } });
trace.span('sub-agent', { observationType: 'agent', input: { task: '...' } });
```

Supported types: `'span'` (default), `'tool'`, `'agent'`, `'generation'`, `'event'`, `'chain'`, `'retriever'`, `'evaluator'`, `'embedding'`, `'guardrail'`.

Spans can be nested:

```ts
const parent = trace.span('pipeline');
const child = parent.span('step-1');
child.end();
parent.end();
```

### Generations (LLM calls)

```ts
const gen = trace.generation('llm-call', {
  model: 'claude-opus-4',
  modelParameters: { temperature: 0.7 },
  input: [{ role: 'user', content: 'Hello' }],
});
gen.end({
  output: { role: 'assistant', content: 'Hi!' },
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 20,
    cache_creation_tokens: 0,
  },
  cost: { total: 0.005 },
});
```

### Events (fire-and-forget)

```ts
trace.event('user-feedback', { input: { rating: 5 } });
```

## Examples

### 1. Wrapping a single LLM call

The smallest useful unit: one trace, one generation. Use this shape inside any function that calls an LLM.

```ts
async function answer(question: string) {
  const trace = dh.trace({
    name: 'answer',
    tenantId: 't1',
    workspaceId: 'ws-1',
    applicationId: 'app-1',
    assessmentRunId: 'run-1',
  });
  const gen = trace.generation('claude', {
    model: 'claude-opus-4',
    input: [{ role: 'user', content: question }],
  });
  const resp = await callClaude(question);
  gen.end({ output: resp.content, usage: resp.usage });
  trace.end();
  return resp;
}
```

### 2. Multi-turn chat (one trace, many generations)

A single user-facing interaction is one trace. Each model round-trip is a generation under it. This is what makes a conversation show up as one timeline in trace-hub instead of N disconnected calls.

```ts
const trace = dh.trace({
  name: 'chat-session',
  tenantId: 't1',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
  assessmentRunId: 'run-1',
  sessionId: 'sess-42',
  userId: 'alice@example.com',
});

for (const userMsg of incomingMessages) {
  const gen = trace.generation('turn', {
    model: 'claude-opus-4',
    input: [...history, { role: 'user', content: userMsg }],
  });
  const reply = await callClaude([...history, { role: 'user', content: userMsg }]);
  gen.end({ output: reply.content, usage: reply.usage });
  history.push({ role: 'user', content: userMsg }, { role: 'assistant', content: reply.content });
}

trace.end();
```

### 3. Tool-using agent (nested spans)

When the model calls a tool, capture both sides. Nesting matters — `parent.span(...)` makes the tool call a child of the LLM turn that requested it, so trace-hub renders it inside the right step.

```ts
const turn = trace.generation('plan', { model: 'claude-opus-4', input: messages });
const decision = await callClaude(messages);
turn.end({ output: decision, usage: decision.usage });

if (decision.tool_use) {
  const tool = trace.span(decision.tool_use.name, {
    observationType: 'tool',
    input: decision.tool_use.input,
  });
  const result = await runTool(decision.tool_use);
  tool.end({ output: result });
}
```

### 4. RAG pipeline (retriever → generation)

Two observations, two types: the retrieval shows up labelled `retriever` (vector search latency, hit count), the answer shows up as `generation` (tokens, cost). Useful when you want to attribute slowness to retrieval vs the model.

```ts
const trace = dh.trace({
  name: 'rag-query',
  tenantId: 't1',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
  assessmentRunId: 'run-1',
});

const retrieval = trace.span('vector-search', {
  observationType: 'retriever',
  input: { query: userQuery, k: 5 },
});
const docs = await vectorStore.search(userQuery, 5);
retrieval.end({ output: { hits: docs.length, ids: docs.map((d) => d.id) } });

const gen = trace.generation('answer', {
  model: 'claude-opus-4',
  input: buildPrompt(userQuery, docs),
});
const resp = await callClaude(buildPrompt(userQuery, docs));
gen.end({ output: resp.content, usage: resp.usage });

trace.end();
```

### 5. Streaming with time-to-first-token

`completionStartTime` (seconds since epoch, fractional) lets trace-hub split latency into "wait for first token" vs "stream the rest" — the standard way to see whether a slow response is the model thinking or the model talking.

```ts
const gen = trace.generation('stream', {
  model: 'claude-opus-4',
  input: messages,
});

const stream = await client.messages.stream({ model: 'claude-opus-4', messages });
let firstTokenAt: number | undefined;
let text = '';
for await (const chunk of stream) {
  if (firstTokenAt === undefined) firstTokenAt = Date.now() / 1000;
  text += chunk.delta?.text ?? '';
}

gen.update({ completionStartTime: firstTokenAt });
gen.end({ output: text, usage: (await stream.finalMessage()).usage });
```

### 6. Recording errors

Mark failed work with `level: 'ERROR'` and a `statusMessage`. trace-hub uses these to surface failures and compute reliability metrics — don't silently swallow exceptions.

```ts
const gen = trace.generation('claude', { model: 'claude-opus-4', input: messages });
try {
  const resp = await callClaude(messages);
  gen.end({ output: resp.content, usage: resp.usage });
} catch (err) {
  gen.end({
    level: 'ERROR',
    statusMessage: err instanceof Error ? err.message : String(err),
  });
  throw err;
}
```

### 7. Filling in trace details after the fact

Sometimes you don't know `userId` or `sessionId` until after the first model call (e.g. auth happens mid-flow). Open the trace anyway with placeholders, then `update()` once you know — all spans created after the update inherit the new values.

```ts
const trace = dh.trace({
  name: 'request',
  tenantId: 't1',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
  assessmentRunId: 'run-1',
});

const auth = trace.span('authenticate');
const user = await authenticate(req);
auth.end({ output: { userId: user.id } });

trace.update({ userId: user.id, sessionId: user.activeSession });

// subsequent spans now carry userId + sessionId automatically
const gen = trace.generation('claude', { model: 'claude-opus-4', input: messages });
// ...
```

### 8. Guardrail on input (and tagging the result)

Show how an input check fits in front of the model. Tag the trace so you can later filter for "blocked" runs in trace-hub.

```ts
const trace = dh.trace({
  name: 'moderated-chat',
  tenantId: 't1',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
  assessmentRunId: 'run-1',
  tags: ['prod'],
});

const guard = trace.span('input-policy', {
  observationType: 'guardrail',
  input: { text: userMsg },
});
const verdict = await policyCheck(userMsg);
guard.end({ output: verdict });

if (verdict.blocked) {
  trace.update({ tags: ['prod', 'blocked'] });
  trace.event('blocked-by-policy', { input: { reason: verdict.reason } });
  trace.end();
  return { error: verdict.reason };
}

const gen = trace.generation('claude', { model: 'claude-opus-4', input: userMsg });
// ...
```

## Architecture

```
Your app
  -> DarkhuntTelemetry (single TracerProvider + DarkhuntSpanExporter)
    -> BatchSpanProcessor (batched async export)
      -> group spans by (tenantId, workspaceId, applicationId, assessmentRunId)
        -> POST /otlp/t/{tenantId}/v1/traces (protobuf, per group)
          -> trace-hub
```

Each span carries `darkhunt.tenant_id`, `darkhunt.workspace_id`, `darkhunt.application_id`, and `darkhunt.assessment_run_id` attributes. The custom exporter reads these to route spans to the correct endpoint with the right headers (`X-Workspace-Id`, `X-Application-Id`).

Failed exports retry with exponential backoff for retryable HTTP statuses (429, 502, 503, 504): 1s → 2s → 4s, capped at 30s, with jitter.

## What gets sent

Every span shipped to trace-hub carries:

- **Routing/identity attributes** — `tenantId`, `workspaceId`, `applicationId`, `assessmentRunId` (required), plus optional `sessionId`, `userId`, `userEmail`, `release`, `environment`, `tags`.
- **Observation payloads** — anything you pass as `input`, `output`, or `metadata`. Strings are sent as-is; objects are `JSON.stringify`'d and stored verbatim.
- **Generation extras** — `model`, `modelParameters`, `usage` (token counts), `cost`, `promptName`, `promptVersion`.
- **OTel envelope** — span name, start/end timestamps, status, parent/child relationships, and resource attributes (`service.name=darkhunt-telemetry`, `service.version`).

The SDK does **not** redact, hash, or sample anything. If you pass raw prompts, completions, tool arguments, or PII, they leave your process verbatim. To control what reaches trace-hub, scrub at the call site before passing to `input`/`output`/`metadata` — for example:

```ts
gen.end({
  output: { role: 'assistant', content: redact(response.content) },
  usage: response.usage,
});
```

Transport is HTTPS to `baseUrl` with `Authorization: Bearer <apiKey>`.

## Development

```bash
npm install
npm run dev          # tsx watch src/index.ts
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier --write
npm run build        # tsc → dist/
```

## Releasing

Push to `main`. CI publishes `@darkhunt-security/telemetry@<base>-build.<run_number>` to GitHub Packages and posts to Slack. The base version lives in `package.json` (`0.1.0`); CI appends `-build.N` per run, matching the org convention used by `@darkhunt-security/workflow-manager-openapi` and other internal packages.

To bump the base (for breaking changes), edit `package.json` on a PR and merge.

## Tech stack

- [Node.js 24](https://nodejs.org/) + ESM
- [@opentelemetry/api](https://opentelemetry.io/) — span/tracer interfaces
- [@opentelemetry/sdk-trace-node](https://opentelemetry.io/) — TracerProvider + BatchSpanProcessor
- [@opentelemetry/otlp-transformer](https://opentelemetry.io/) — protobuf serialization
