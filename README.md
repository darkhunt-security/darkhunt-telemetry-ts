# Darkhunt telemetry for JS/TS

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/darkhunt-security/darkhunt-telemetry-ts/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/darkhunt-security/darkhunt-telemetry-ts/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=coverage)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=darkhunt-security_darkhunt-telemetry-ts&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=darkhunt-security_darkhunt-telemetry-ts)
[![Known Vulnerabilities](https://snyk.io/test/github/darkhunt-security/darkhunt-telemetry-ts/badge.svg)](https://snyk.io/test/github/darkhunt-security/darkhunt-telemetry-ts)

TypeScript SDK for sending LLM traces, generations, and observations to the [Darkhunt platform](https://app.darkhunt.ai) for persistence and security data enrichment. Built on OpenTelemetry primitives, with built-in client-side data masking that redacts secrets and PII before payloads leave the process.

> 🤖 **Skip the manual wiring** — if you use Claude Code, install the Darkhunt plugin once:
>
> ```
> /plugin marketplace add darkhunt-security/darkhunt-telemetry-ts
> /plugin install darkhunt-telemetry@darkhunt
> ```
>
> Then tell Claude _"add Darkhunt telemetry to this service"_ and the [`darkhunt-telemetry-integration`](https://github.com/darkhunt-security/darkhunt-telemetry-ts/blob/main/plugins/darkhunt-telemetry/skills/darkhunt-telemetry-integration/SKILL.md) skill auto-invokes and does steps 1–5 below for you.

---

## Get started

**Prerequisite — set up your project in Darkhunt.** Open the [Get started page](https://app.darkhunt.ai/get-started?flow=tool) in the Darkhunt dashboard to copy your `tenantId`, `workspaceId`, and `applicationId`, then create an API key (`dh-...`) by following [Creating an API key](https://docs.darkhunt.ai/darkhunt-ai-security/api-keys#creating-an-api-key). Set them in the environment as `DARKHUNT_TENANT_ID`, `DARKHUNT_WORKSPACE_ID`, `DARKHUNT_APPLICATION_ID`, and `DARKHUNT_API_KEY` — the SDK reads them automatically.

### 1. Install

```bash
npm install @darkhunt-security/telemetry
```

> Requires Node `^18.19.0 || >=20.6.0` and an ESM project (`"type": "module"` in `package.json`). For CommonJS consumers, use dynamic `import()` or migrate to ESM.

### 2. Create a singleton module

The SDK holds a global `TracerProvider`, so instantiate it **exactly once** per process. Put it in a dedicated module that the rest of your app imports.

```ts
// src/telemetry.ts
import { DarkhuntTelemetry } from '@darkhunt-security/telemetry';

// Reads DARKHUNT_API_KEY, DARKHUNT_TENANT_ID, DARKHUNT_WORKSPACE_ID,
// and DARKHUNT_APPLICATION_ID from the environment.
export const dh = new DarkhuntTelemetry();
```

Pass options explicitly if you need to override any of these (e.g. multi-tenant routing where `tenantId` varies per request — see [Common patterns](#common-patterns)).

Import `dh` wherever you need to open a trace. Don't `new DarkhuntTelemetry()` again — a second provider will silently shadow the first.

### 3. Wrap your LLM calls

The SDK has two concepts you'll use:

- **`trace`** — one user-facing operation (a request, a chat session, a job). Open it at the entry point.
- **`generation`** — one LLM call inside a trace. Records model, input, output, token usage, cost.

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

The three _routing fields_ — `tenantId`, `workspaceId`, `applicationId` — are how the platform partitions data. They're set once on the client in step 2 and inherited by every trace. If any is missing when `dh.trace()` is called, it throws — fail-fast is the design.

> **⚠️ Set `sessionId` and `userId` on every trace.** They're not technically required (the SDK won't throw without them), but the platform's two main value-adds depend on them:
>
> - **Visualization** — traces sharing a `sessionId` render as one conversation timeline in the dashboard. Without it, every turn of a multi-turn chat appears as a disconnected trace and the conversation view is unusable.
> - **Guardrails & anomaly detection** — Darkhunt's policies key off `userId` to attribute behavior to a specific end-user (rate limits, abuse detection, per-user policy decisions). Without it, guardrails can only operate at the application level and lose the per-user signal.
>
> Pick the right identifier for each:
>
> - **`sessionId`** — the _same_ value across every turn of one logical conversation. A browser session cookie, a chat thread ID, a conversation UUID created at session start. **Not** a fresh-per-request UUID — that fragments the conversation into one-trace "sessions" and defeats the purpose.
> - **`userId`** — stable per end-user. The authenticated account ID, email, or auth subject claim. Stays the same across sessions for the same person.

### 4. Drain the buffer on shutdown

Telemetry is batched in memory and exported asynchronously. If your process exits with a full buffer, those traces are lost. The constructor handles natural process exit automatically, but **long-running servers must wire up signal handlers**:

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

### 5. Verify it worked

Run your service, exercise the path that opens a trace, then open **[app.darkhunt.ai/tracing](https://app.darkhunt.ai/tracing)** — incoming traces appear in the timeline. The default flush interval is `5s`, so wait a few seconds (or trigger graceful shutdown) if you don't see them immediately.

If nothing shows up, the most common causes are: missing `DARKHUNT_API_KEY` in the runtime env, wrong `tenantId` / `workspaceId` / `applicationId` (data lands in the wrong scope), or the process killed with `SIGKILL` before the buffer flushed.

---

## Common patterns

| If you're building...    | You'll want...                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Multi-turn chat**      | One trace per session, one `generation()` per turn — keeps the conversation rendered as a single timeline        |
| **Streaming responses**  | Set `completionStartTime` via `gen.update()` when the first token arrives — backend splits TTFT vs stream time   |
| **Multi-tenant routing** | Leave routing fields off the client, pass them per-trace from the request context                                |
| **Recording errors**     | Pass `level: 'ERROR'` and `statusMessage` to `gen.end()` — the dashboard surfaces failures and reliability stats |

Worked examples for each: [full SDK guide](https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript#examples).

## Configuration

Every option resolves as **constructor argument > env var > default**. The most common subset:

| Option            | Env var                                       | Default                             |
| ----------------- | --------------------------------------------- | ----------------------------------- |
| `apiKey`          | `DARKHUNT_API_KEY`                            | _(required)_                        |
| `baseUrl`         | `DARKHUNT_BASE_URL`                           | `https://api.darkhunt.ai/trace-hub` |
| `serviceName`     | `DARKHUNT_SERVICE_NAME` / `OTEL_SERVICE_NAME` | library name                        |
| `enabled`         | `DARKHUNT_ENABLED`                            | `true`                              |
| `flushAt`         | `DARKHUNT_FLUSH_AT`                           | `20` records                        |
| `flushIntervalMs` | `DARKHUNT_FLUSH_INTERVAL`                     | `5s`                                |
| `mask.enabled`    | —                                             | `true`                              |

> **Setting `baseUrl` for a non-prod environment.** It must be the **ingest API
> host**, not the dashboard, **and include the `/trace-hub` path** — the SDK posts
> to `{baseUrl}/otlp/t/{tenantId}/v1/traces`, and the gateway routes the
> `/trace-hub` prefix to the ingest service. Use `api…darkhunt.ai/trace-hub`, not
> `app…darkhunt.ai`:
>
> - ✅ `https://api.darkhunt.ai/trace-hub` (prod, the default)
> - ✅ `https://api-<env>.darkhunt.ai/trace-hub` (e.g. `https://api-seth-dev.darkhunt.ai/trace-hub`)
> - ❌ `https://app.darkhunt.ai` — the dashboard host redirects POSTs (→ 405)
> - ❌ `https://api-<env>.darkhunt.ai` — missing `/trace-hub` → **404**

> **Identifying services / agents.** `serviceName` sets the OTel Resource
> `service.name`, the standard way to identify which producer emitted a span.
> In a multi-service or multi-agent system, give **each process its own**
> `serviceName` (e.g. `weather.coordinator`, `weather.geodata`) — the platform
> records it per span so you can distinguish, group, and filter by service.
> Since the Resource is per-`TracerProvider` (i.e. per client/process), distinct
> names require distinct processes/clients, not a single shared instance.

Full table, all routing-field env vars, and per-option behavior: [docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript#configuration](https://docs.darkhunt.ai/darkhunt-ai-security/sdks/typescript#configuration).

## Data masking (default-on)

The SDK redacts secrets and PII _before_ data leaves your process — 66 rules covering AWS/OpenAI/Stripe/GitHub-shape API keys, JWTs, PEM blocks, emails, credit cards (Luhn-validated), IBANs (mod-97), crypto addresses (Base58Check / EIP-55), and more. Server-side masking runs again as defense-in-depth.

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
- [Tracing dashboard](https://docs.darkhunt.ai/darkhunt-ai-security/tracing) — what the traces you ship look like in the Darkhunt UI

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
