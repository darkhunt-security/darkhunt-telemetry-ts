# darkhunt-telemetry-ts

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/darkhunt-security/darkhunt-telemetry-ts/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/darkhunt-security/darkhunt-telemetry-ts/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=coverage)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Known Vulnerabilities](https://snyk.io/test/github/darkhunt-security/darkhunt-telemetry-ts/badge.svg)](https://snyk.io/test/github/darkhunt-security/darkhunt-telemetry-ts)

OpenTelemetry-based SDK for sending LLM traces, generations, and observations to any OTLP-compatible backend. Built-in client-side data masking redacts secrets and PII before payloads leave the process.

The reference backend is [Darkhunt trace-hub](https://darkhunt.ai), but the SDK speaks vanilla OTLP/protobuf so any OTLP-compatible receiver works.

TypeScript companion to [`darkhunt-telemetry`](https://github.com/darkhunt-security/darkhunt-telemetry) (Python) — same wire format, same routing semantics, same masking ruleset.

Apache 2.0 licensed.

## Install

```bash
npm install @darkhunt-security/telemetry
```

## Quick start

```ts
import { DarkhuntTelemetry } from '@darkhunt-security/telemetry';

// Set routing fields once at the client level — every trace inherits them
const dh = new DarkhuntTelemetry({
  // baseUrl defaults to https://app.darkhunt.ai (Darkhunt's hosted backend);
  // override for self-hosted or any OTLP-compatible receiver
  apiKey: process.env.DH_API_KEY,
  tenantId: 'my-tenant',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
});

// Per-trace, only what's actually variable per request:
const trace = dh.trace({
  name: 'chat',
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

| Option                | Env var                      | Default                                    |
| --------------------- | ---------------------------- | ------------------------------------------ |
| `baseUrl`             | `DARKHUNT_BASE_URL`          | `https://app.darkhunt.ai`                  |
| `apiKey`              | `DARKHUNT_API_KEY`           | _(required)_                               |
| `enabled`             | `DARKHUNT_ENABLED`           | `true`                                     |
| `release`             | `DARKHUNT_RELEASE`           |                                            |
| `environment`         | `DARKHUNT_ENVIRONMENT`       |                                            |
| `flushAt`             | `DARKHUNT_FLUSH_AT`          | `20` spans                                 |
| `flushIntervalMs`     | `DARKHUNT_FLUSH_INTERVAL`    | `5s`                                       |
| `timeoutMs`           | `DARKHUNT_TIMEOUT`           | `10s`                                      |
| `tenantId`            | `DARKHUNT_TENANT_ID`         | — (see [Routing fields](#routing-fields))  |
| `workspaceId`         | `DARKHUNT_WORKSPACE_ID`      | — (see [Routing fields](#routing-fields))  |
| `applicationId`       | `DARKHUNT_APPLICATION_ID`    | — (see [Routing fields](#routing-fields))  |
| `assessmentRunId`     | `DARKHUNT_ASSESSMENT_RUN_ID` | — (see [Routing fields](#routing-fields))  |
| `mask.enabled`        | —                            | `true` (see [Data masking](#data-masking)) |
| `mask.customPatterns` | —                            | `[]`                                       |

> Constructor options ending in `Ms` take **milliseconds**; the matching env vars take **seconds** (the SDK converts them). Defaults above show the effective value.

`apiKey` is a Darkhunt API token (`dh-...`). It's sent as `Authorization: Bearer <apiKey>` to the public OTLP ingestion endpoint (`POST /otlp/t/{tenantId}/v1/traces`). The constructor throws if `enabled` is `true` and no key is provided.

Precedence for every option: **constructor argument > env var > default**. Pass options explicitly to override anything coming from the environment:

```ts
// 1. All from env
const dh = new DarkhuntTelemetry();

// 2. Explicit options take priority over env
const dh = new DarkhuntTelemetry({
  baseUrl: 'https://app.darkhunt.ai', // explicit form of the default
  apiKey: devKey,
});

// 3. Mix — explicit option overrides only that field
const dh = new DarkhuntTelemetry({ apiKey: someKey }); // baseUrl from env (or default)
```

A wrapper CLI or framework can adopt its own env-var prefix (e.g. `DH_API_KEY` / `DH_API_BASE_URL`) and forward them as explicit options, so end users don't need to set the `DARKHUNT_*` vars directly.

### Routing fields

`tenantId`, `workspaceId`, `applicationId`, and `assessmentRunId` are how the backend routes spans. They're **required somewhere** — constructor option, env var, or per-trace argument — and `dh.trace()` throws a clear error if any is still missing after merging.

The expected pattern: set whatever's constant for the process at the client level, and pass only the variable bits per trace.

```ts
// Single-tenant app: set tenant/workspace/app once, vary assessmentRunId per trace
const dh = new DarkhuntTelemetry({
  apiKey: process.env.DH_API_KEY,
  tenantId: 't1',
  workspaceId: 'ws-1',
  applicationId: 'app-1',
});

dh.trace({ assessmentRunId: 'run-' + Date.now() }); // tenant/workspace/app inherited

// Multi-tenant app: leave them off the client and route per request
const dh = new DarkhuntTelemetry({ apiKey: process.env.DH_API_KEY });
dh.trace({
  tenantId: req.tenantId,
  workspaceId: req.wsId,
  applicationId: 'shared',
  assessmentRunId: 'r',
});

// Per-trace args always win over client defaults
const dh = new DarkhuntTelemetry({ tenantId: 'default' /* ... */ });
dh.trace({ tenantId: 'override' /* ... */ }); // → 'override'
```

Optional trace-level parameters (`sessionId`, `userId`, `tags`, `metadata`) are propagated to all child spans.

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

A single user-facing interaction is one trace. Each model round-trip is a generation under it. This is what makes a conversation show up as one timeline in the dashboard instead of N disconnected calls.

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

When the model calls a tool, capture both sides. Nesting matters — `parent.span(...)` makes the tool call a child of the LLM turn that requested it, so the backend renders it inside the right step.

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

`completionStartTime` (seconds since epoch, fractional) lets the backend split latency into "wait for first token" vs "stream the rest" — the standard way to see whether a slow response is the model thinking or the model talking.

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

Mark failed work with `level: 'ERROR'` and a `statusMessage`. The backend uses these to surface failures and compute reliability metrics — don't silently swallow exceptions.

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

Show how an input check fits in front of the model. Tag the trace so you can later filter for "blocked" runs in the dashboard.

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
          -> OTLP-compatible backend (Darkhunt trace-hub by default)
```

Each span carries `darkhunt.tenant_id`, `darkhunt.workspace_id`, `darkhunt.application_id`, and `darkhunt.assessment_run_id` attributes. The custom exporter reads these to route spans to the correct endpoint with the right headers (`X-Workspace-Id`, `X-Application-Id`).

Failed exports retry with exponential backoff for retryable HTTP statuses (429, 502, 503, 504): 1s → 2s → 4s, capped at 30s, with jitter.

## What gets sent

Every span shipped to the backend carries:

- **Routing/identity attributes** — `tenantId`, `workspaceId`, `applicationId`, `assessmentRunId` (required), plus optional `sessionId`, `userId`, `userEmail`, `release`, `environment`, `tags`. Sent verbatim; not subject to masking (these are intentionally identifying).
- **Observation payloads** — anything you pass as `input`, `output`, `inputMessages`, `outputMessages`, `systemInstructions`, `statusMessage`, or `metadata`. Strings are passed through the [data-masking layer](#data-masking) before serialization; objects are walked recursively so string leaves get redacted in place.
- **Generation extras** — `model`, `modelParameters`, `usage` (token counts), `cost`, `promptName`, `promptVersion`.
- **OTel envelope** — span name, start/end timestamps, status, parent/child relationships, and resource attributes (`service.name=darkhunt-telemetry`, `service.version`).

Transport is HTTPS to `baseUrl` with `Authorization: Bearer <apiKey>`.

## Data masking

The SDK ships a default-on data-masking layer that runs at the call site, before spans leave your process. Built-in coverage includes ~60 patterns for common secrets (API keys for AWS, OpenAI, Stripe, GitHub, etc.; bearer tokens; PEM private keys) and PII (emails, IBANs, credit cards with Luhn + IIN validation, SSNs, IPs, MAC addresses, crypto addresses with checksum validation). Rules ship as a versioned artifact (`@darkhunt-security/masking-schema`) shared with the trace-hub server, so client- and server-side use identical patterns.

**Masked fields**: `input`, `output`, `inputMessages[].content`, `outputMessages[].content`, `systemInstructions`, `metadata` values, `statusMessage`. Identification fields (`tenantId`, `userId`, `userEmail`, model name, etc.) are explicitly **not** masked.

```ts
const dh = new DarkhuntTelemetry({
  baseUrl: '...',
  apiKey: '...',
  // Default — masking on, no custom rules:
  mask: { enabled: true },
});

// Disable for local dev with synthetic data:
const dh = new DarkhuntTelemetry({ mask: { enabled: false } });

// Add site-specific rules on top of defaults:
const dh = new DarkhuntTelemetry({
  mask: {
    customPatterns: [
      { name: 'ticket', regex: 'PROJ-\\d+', marker: '[TICKET]' },
      { regex: 'INT-[A-Z0-9]{8}', marker: '[INTERNAL_ID]', caseSensitive: false },
    ],
  },
});
```

**Validators**: rules tagged with a `validation` (`luhn`, `credit_card`, `aba`, `iban_mod97`, `base58check`, `bech32`, `eip55`) require the post-match check to pass before the marker substitutes. So a 16-digit number that isn't Luhn-valid stays untouched, an IBAN with a bad mod-97 checksum stays untouched, etc. Validators are implemented in pure TS via `@noble/hashes` for the crypto-address ones.

**Phone numbers**: masked server-side only — there's no phone rule in the YAML and no `[PHONE]` matcher in the SDK. We deliberately skipped a regex-only phone rule (would over-match — IDs, timestamps, ISBNs, and lots of bare digit sequences look phone-shaped) and skipped bundling `libphonenumber-js` (~145KB to the SDK install). trace-hub catches phones server-side via the JVM-native `libphonenumber`, which validates against actual numbering plans before substituting `[PHONE]`, so phones that arrive unmasked are still redacted before the span lands in NATS. The post-sanitize counter on the server treats `[PHONE]` like any other marker, so dashboard counts are accurate. If you want client-side coverage too, ask us — an optional `libphonenumber-js` integration is the cleanest path.

**Defense in depth**: trace-hub also runs the same ruleset server-side. The two passes are idempotent — markers like `[EMAIL]` don't match any rule — so output is correct, and the server backstop catches third-party OTel SDKs, old SDK versions, `mask: { enabled: false }` opt-outs, and (as above) phone numbers.

To inspect or extend programmatically, the `Sanitizer` class is exported:

```ts
import { Sanitizer } from '@darkhunt-security/telemetry';

const s = new Sanitizer();
console.log(s.rulesetVersion); // e.g. "2026.5.6"
console.log(s.sanitize('reach me at john@example.com')); // "reach me at [EMAIL]"
```

### Built-in rules

66 rules across 5 categories, plus `[PHONE]` (server-side libphonenumber) — 13 distinct markers total. Source: [`data-masking-rules.yaml`](https://github.com/darkhunt-security/api-contract/blob/master/contracts/schemas/masking/data-masking-rules.yaml) in `api-contract`.

**Secrets & tokens — `[SECRET]`** (52 rules, ~80% of total)

| Group               | Examples                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud providers     | `aws_key`, `azure_storage_key`, `azure_sas_token`, `google_api_key`, `digitalocean_token`, `heroku_api_key`, `databricks_token`, `vercel_token`, `netlify_token`, `planetscale_token`, `supabase_key`, `cloudant_key`, `ibm_cloud_iam`, `softlayer_key` |
| Source control / CI | `github_token`, `gitlab_token`, `circleci_token`                                                                                                                                                                                                        |
| LLM / AI            | `openai_key`, `anthropic_key`, `huggingface_key`                                                                                                                                                                                                        |
| Communication       | `slack_token`, `discord_bot_token`, `telegram_bot_token`, `twilio_key`, `sendgrid_key`, `mailchimp_key`                                                                                                                                                 |
| Payments / commerce | `stripe_key`, `square_oauth`, `shopify_token`                                                                                                                                                                                                           |
| Observability       | `datadog_api_key`, `grafana_token`, `newrelic_key`, `sentry_dsn`, `darkhunt_api_key`                                                                                                                                                                    |
| Infra / SaaS        | `hashicorp_vault_token`, `okta_token`, `linear_api_key`, `algolia_key`, `postman_api_key`, `mapbox_token`, `figma_token`, `contentful_token`                                                                                                            |
| Package registries  | `npm_token`, `pypi_token`, `artifactory_token`                                                                                                                                                                                                          |
| Generic             | `jwt`, `bearer_token`, `private_key_block`, `private_key`, `password_assignment`, `connection_string_secret`, `basic_auth_url`                                                                                                                          |

**Financial / identity / network** (validated)

| Rule               | Marker          | Validator                   |
| ------------------ | --------------- | --------------------------- |
| `iban`             | `[IBAN]`        | mod-97 checksum             |
| `aba_routing`      | `[ABA_ROUTING]` | weighted mod-10             |
| `bitcoin_legacy`   | `[CRYPTO]`      | Base58Check (double-sha256) |
| `bitcoin_bech32`   | `[CRYPTO]`      | BIP-173/350 polymod         |
| `ethereum_address` | `[CRYPTO]`      | EIP-55 keccak256 mixed-case |
| `us_passport`      | `[US_PASSPORT]` | regex only                  |
| `ipv6`             | `[IP]`          | regex only                  |
| `mac_address`      | `[MAC_ADDRESS]` | regex only                  |

**Common PII**

| Rule           | Marker          | Validator                                           |
| -------------- | --------------- | --------------------------------------------------- |
| `email`        | `[EMAIL]`       | regex only                                          |
| `ssn`          | `[SSN]`         | regex only (excludes SSA-invalid area/group/serial) |
| `credit_card`  | `[CREDIT_CARD]` | Luhn + IIN range check                              |
| `ip`           | `[IP]`          | regex only                                          |
| `imei`         | `[IMEI]`        | Luhn                                                |
| `canadian_sin` | `[SIN]`         | Luhn                                                |
| `(phones)`     | `[PHONE]`       | server-side libphonenumber, not in YAML             |

Most rules collapse to `[SECRET]` by design — secrets all carry the same blast radius. The 13 distinct markers exist so the dashboard can break down "what kind of PII was redacted" per span.

## Development

```bash
npm install
npm run dev          # tsx watch src/index.ts
npm run typecheck    # tsc --noEmit
npm run test         # node --import tsx --test
npm run lint         # eslint
npm run format       # prettier --write
npm run build        # tsc → dist/
```

Test coverage includes per-validator unit tests plus a data-driven `rule-coverage.test.ts` that walks every rule in the bundled YAML and asserts each `example` is redacted to its declared marker — adding a new rule to `@darkhunt-security/masking-schema` automatically extends coverage; no per-rule test to write.

## Releasing

Push to `main`. CI publishes `@darkhunt-security/telemetry@<base>-build.<run_number>` to npm. The base version lives in `package.json` (`0.5.0`); CI appends `-build.N` per run.

To bump the base (for breaking changes), edit `package.json` on a PR and merge.

## Tech stack

- [Node.js 24](https://nodejs.org/) + ESM
- [@opentelemetry/api](https://opentelemetry.io/) — span/tracer interfaces (Apache 2.0)
- [@opentelemetry/sdk-trace-node](https://opentelemetry.io/) — TracerProvider + BatchSpanProcessor (Apache 2.0)
- [@opentelemetry/otlp-transformer](https://opentelemetry.io/) — protobuf serialization (Apache 2.0)
- [@darkhunt-security/masking-schema](https://github.com/darkhunt-security/api-contract) — versioned masking ruleset, shared across SDKs and the Darkhunt backend (Apache 2.0)
- [@noble/hashes](https://github.com/paulmillr/noble-hashes) — pure-JS sha256 + keccak256 for the `base58check` and `eip55` validators (MIT)

## License

Apache 2.0. See [`LICENSE`](./LICENSE) for the full text and [`NOTICE`](./NOTICE) for third-party attributions.
