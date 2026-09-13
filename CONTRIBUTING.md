# Contributing

Thanks for your interest in contributing. This guide covers the basics.

## Quick start

```bash
git clone https://github.com/darkhunt-security/darkhunt-telemetry-ts
cd darkhunt-telemetry-ts
npm install
npm run typecheck
npm test
```

That's the full local loop. If those three commands pass, your environment is set up.

## What we accept

| Welcome                                          | Out of scope                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Bug fixes with a regression test                 | Reformatting / re-styling unrelated code (use a separate PR)                                       |
| Documentation improvements                       | New backends — the SDK speaks vanilla OTLP; backend-specific extensions belong in adapter packages |
| Performance fixes with before/after measurements | Sweeping refactors without a discussed motivation — file an issue first                            |
|                                                  | Adding heavyweight runtime dependencies (each new dep affects every consumer's bundle)             |
|                                                  | Removing tests to make CI green                                                                    |
|                                                  | Client-side data masking — PII is masked server-side in the Darkhunt platform on ingest            |

For anything non-trivial, **open an issue first** to discuss the approach. Saves both sides effort if the answer is "we're going a different direction."

## Pull request checklist

Before pushing:

```bash
npm run format:check    # Prettier
npm run lint            # ESLint
npm run typecheck       # tsc --noEmit
npm test                # Node test runner — must all pass
npm run test:coverage   # generates coverage/lcov.info — Sonar check on PR
```

Your PR template (`.github/PULL_REQUEST_TEMPLATE.md`) has the full checklist.

## Code style

- **TypeScript strict mode** — `strict: true` + `noUncheckedIndexedAccess` are on. No `any` without a comment explaining why.
- **No comments that just restate code** — the code says what; comments say _why_.
- **Tests are named after the behaviour they cover** — e.g. `src/transports/http.ts` → `test/transports.test.ts` (grouped by area).
- **No emojis in source files or commit messages** unless the situation genuinely calls for one.

## Releasing (maintainers only)

CI handles publishing. Push to `main` → workflow publishes `@darkhunt-security/telemetry@<base>-build.<run_number>`.

To bump the base version, edit `package.json`'s `version` field on a PR.

## Reporting security issues

**Don't open a public issue for security vulnerabilities.** See [`SECURITY.md`](./SECURITY.md) for the disclosure policy.

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Be kind, be patient, assume good faith.
