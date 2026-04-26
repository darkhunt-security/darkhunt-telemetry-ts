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

const dh = new DarkhuntTelemetry({ baseUrl: 'http://trace-hub' });

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

## Configuration

| Option            | Env var                             | Default                 |
| ----------------- | ----------------------------------- | ----------------------- |
| `baseUrl`         | `DARKHUNT_BASE_URL`                 | `http://localhost:8080` |
| `enabled`         | `DARKHUNT_ENABLED`                  | `true`                  |
| `release`         | `DARKHUNT_RELEASE`                  |                         |
| `environment`     | `DARKHUNT_ENVIRONMENT`              |                         |
| `flushAt`         | `DARKHUNT_FLUSH_AT`                 | `20`                    |
| `flushIntervalMs` | `DARKHUNT_FLUSH_INTERVAL` (seconds) | `5000`                  |
| `timeoutMs`       | `DARKHUNT_TIMEOUT` (seconds)        | `10000`                 |

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

## Architecture

```
Your app
  -> DarkhuntTelemetry (single TracerProvider + DarkhuntSpanExporter)
    -> BatchSpanProcessor (batched async export)
      -> group spans by (tenantId, workspaceId, applicationId, assessmentRunId)
        -> POST /internal/t/{tenantId}/v1/traces (protobuf, per group)
          -> trace-hub
```

Each span carries `darkhunt.tenant_id`, `darkhunt.workspace_id`, `darkhunt.application_id`, and `darkhunt.assessment_run_id` attributes. The custom exporter reads these to route spans to the correct endpoint with the right headers (`X-Workspace-Id`, `X-Application-Id`).

Failed exports retry with exponential backoff for retryable HTTP statuses (429, 502, 503, 504): 1s → 2s → 4s, capped at 30s, with jitter.

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
