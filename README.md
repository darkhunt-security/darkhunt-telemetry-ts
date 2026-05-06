# darkhunt-telemetry-ts

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/darkhunt-security/darkhunt-telemetry-ts/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/darkhunt-security/darkhunt-telemetry-ts/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=coverage)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Known Vulnerabilities](https://snyk.io/test/github/darkhunt-security/darkhunt-telemetry-ts/badge.svg)](https://snyk.io/test/github/darkhunt-security/darkhunt-telemetry-ts)

TypeScript SDK for shipping LLM traces, generations, and observations to [Darkhunt trace-hub](https://darkhunt.ai). Built on OpenTelemetry primitives, with built-in client-side data masking that redacts secrets and PII before payloads leave the process.

> 🤖 **Skip the manual wiring** — if you use [Claude Code](https://claude.com/claude-code), tell it _"add Darkhunt telemetry to this service"_ and the [`darkhunt-telemetry-integration`](https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript) skill auto-invokes and does steps 1–4 below for you.

---

## Integrate in 4 steps

### 1. Install

```bash
npm install @darkhunt-security/telemetry
```

### 2. Create a singleton module

The SDK holds a global `TracerProvider`, so instantiate it **exactly once** per process. Put it in a dedicated module that the rest of your app imports.

```ts
// src/telemetry.ts
import { DarkhuntTelemetry } from '@darkhunt-security/telemetry';

export const dh = new DarkhuntTelemetry({
  apiKey: process.env.DH_API_KEY,
  // Routing fields constant for this process — set once here:
  tenantId: process.env.DH_TENANT_ID,
  workspaceId: process.env.DH_WORKSPACE_ID,
  applicationId: process.env.DH_APPLICATION_ID,
  environment: process.env.NODE_ENV,
});
```

Import `dh` wherever you need to open a trace. Don't `new DarkhuntTelemetry()` again — a second provider will silently shadow the first.

### 3. Wrap your LLM calls

The SDK has three concepts you'll use:

- **`trace`** — one user-facing operation (a request, a chat session, a job). Open it at the entry point.
- **`generation`** — one LLM call inside a trace. Records model, input, output, token usage, cost.
- **`span`** — anything else inside a trace (retrieval, tool calls, guardrails, etc.). Categorize via `observationType`.

```ts
// src/handlers/chat.ts
import { dh } from '../telemetry.js';

export async function handleChat(req, res) {
  const trace = dh.trace({
    name: 'chat',
    sessionId: req.sessionId,
    userId: req.user.email,
  });

  const gen = trace.generation('answer', {
    model: 'claude-opus-4',
    input: [{ role: 'user', content: req.body.message }],
  });

  try {
    const reply = await yourLlmCall(req.body.message); // your existing client
    gen.end({ output: reply.content, usage: reply.usage });
    res.json({ reply: reply.content });
  } catch (err) {
    gen.end({ level: 'ERROR', statusMessage: String(err) });
    throw err;
  } finally {
    trace.end();
  }
}
```

The three _routing fields_ — `tenantId`, `workspaceId`, `applicationId` — are how trace-hub partitions data. They're set once on the client in step 2 and inherited by every trace. If any is missing when `dh.trace()` is called, it throws — fail-fast is the design. Per-trace fields like `name`, `sessionId`, and `userId` are optional metadata for filtering in the dashboard.

### 4. Drain the buffer on shutdown

Spans are batched in memory and exported asynchronously. If your process exits with a full buffer, those spans are lost. The constructor handles natural process exit automatically, but **long-running servers must wire up signal handlers**:

```ts
// src/index.ts
import { dh } from './telemetry.js';

const server = app.listen(3000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    server.close();
    await dh.shutdown(); // flushes, then tears down
    process.exit(0);
  });
}
```

For one-shot scripts (CLI tools, cron jobs), `await dh.flush()` before returning is enough — the auto-registered `beforeExit` hook handles teardown.

---

## Common patterns

| If you're building...    | You'll want...                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Multi-turn chat**      | One trace per session, one `generation()` per turn — keeps the conversation rendered as a single timeline                |
| **RAG pipeline**         | A `retriever` span around the vector search + a `generation` for the answer — so latency splits cleanly                  |
| **Tool-using agent**     | Nested spans: `trace.generation()` for the LLM turn, `parent.span(name, { observationType: 'tool' })` for each tool call |
| **Streaming responses**  | Set `completionStartTime` via `gen.update()` when the first token arrives — backend splits TTFT vs stream time           |
| **Guarded inputs**       | A `guardrail` span before the model call, tag the trace `'blocked'` if the verdict is reject                             |
| **Multi-tenant routing** | Leave routing fields off the client, pass them per-trace from the request context                                        |

Each has a worked example in the [full SDK guide](https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript#examples).

## Configuration

Every option resolves as **constructor argument > env var > default**. The most common subset:

| Option            | Env var                   | Default                   |
| ----------------- | ------------------------- | ------------------------- |
| `apiKey`          | `DARKHUNT_API_KEY`        | _(required)_              |
| `baseUrl`         | `DARKHUNT_BASE_URL`       | `https://app.darkhunt.ai` |
| `enabled`         | `DARKHUNT_ENABLED`        | `true`                    |
| `flushAt`         | `DARKHUNT_FLUSH_AT`       | `20` spans                |
| `flushIntervalMs` | `DARKHUNT_FLUSH_INTERVAL` | `5s`                      |
| `mask.enabled`    | —                         | `true`                    |

Full table, all routing-field env vars, and per-option behavior: [docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript#configuration](https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript#configuration).

## Data masking (default-on)

The SDK redacts secrets and PII _before_ spans leave your process — 66 rules covering AWS/OpenAI/Stripe/GitHub-shape API keys, JWTs, PEM blocks, emails, credit cards (Luhn-validated), IBANs (mod-97), crypto addresses (Base58Check / EIP-55), and more. Server-side masking runs again as defense-in-depth.

```ts
// Add site-specific patterns on top of the defaults:
new DarkhuntTelemetry({
  mask: {
    customPatterns: [{ name: 'ticket', regex: 'PROJ-\\d+', marker: '[TICKET]' }],
  },
});
```

Full ruleset, validators, and the phone-number rationale: [docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript#data-masking](https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript#data-masking).

## Documentation

- **[Full SDK guide](https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript)** — configuration, lifecycle, API reference, 8 worked examples, architecture, masking ruleset
- [Tracing dashboard](https://docs.darkhunt.ai/darkhunt-ai-security/tracing) — what the spans you ship look like in the Darkhunt UI

## Development

```bash
npm install
npm run dev          # tsx watch src/index.ts
npm run typecheck    # tsc --noEmit
npm run test         # node --import tsx --test
npm run lint         # eslint
npm run build        # tsc → dist/
```

## Contributing

All changes go through pull request — no direct pushes to `main`. Before opening a PR:

1. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the local dev loop, what's in/out of scope, the PR checklist, and DCO commit-signing requirements.
2. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). Report unacceptable behavior to `conduct@darkhunt.ai`.
3. Security vulnerabilities go through the private channel in [`SECURITY.md`](./SECURITY.md), **not** a public issue or PR.

## Releasing

Releases are cut by maintainers when a PR is merged to `main`. CI publishes `@darkhunt-security/telemetry@<base>-build.<run_number>` to npm — the base version lives in `package.json` and CI appends `-build.N` per run. Bumping the base (for breaking changes) is itself a PR.

## License

Apache 2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for third-party attributions.
