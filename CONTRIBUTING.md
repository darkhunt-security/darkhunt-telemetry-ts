# Contributing

Thanks for your interest in contributing. This guide covers the basics.

## Quick start

```bash
git clone https://github.com/darkhunt-security/darkhunt-telemetry-ts
cd darkhunt-telemetry-ts
npm install        # `prepare` hook generates src/masking/rules/rules.json from the YAML
npm run typecheck
npm test
```

That's the full local loop. If those three commands pass, your environment is set up.

## What we accept

| Welcome                                                                                                                          | Out of scope                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Bug fixes with a regression test                                                                                                 | Reformatting / re-styling unrelated code (use a separate PR)                                       |
| New masking rules in `src/masking/rules/data-masking-rules.yaml` (must include `examples:` — the data-driven test enforces this) | New backends — the SDK speaks vanilla OTLP; backend-specific extensions belong in adapter packages |
| New validators in `src/masking/validators/` (one file per validator, pure function, full test coverage)                          | Sweeping refactors without a discussed motivation — file an issue first                            |
| Documentation improvements                                                                                                       | Adding heavyweight runtime dependencies (each new dep affects every consumer's bundle)             |
| Performance fixes with before/after measurements                                                                                 | Removing tests to make CI green                                                                    |

For anything non-trivial, **open an issue first** to discuss the approach. Saves both sides effort if the answer is "we're going a different direction."

## Pull request checklist

Before pushing:

```bash
npm run format:check    # Prettier
npm run lint            # ESLint
npm run typecheck       # tsc --noEmit
npm test                # Node test runner — 239+ tests, must all pass
npm run test:coverage   # generates coverage/lcov.info — Sonar check on PR
```

Your PR template (`.github/PULL_REQUEST_TEMPLATE.md`) has the full checklist.

## Commit signing — DCO

We use the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). It's a one-line attestation that you wrote the code (or have permission to contribute it) — much lighter than a CLA, no paperwork.

To sign your commits:

```bash
git commit -s -m "your message"
```

The `-s` flag adds a `Signed-off-by: Your Name <your.email@example.com>` trailer. CI rejects unsigned commits.

To sign every commit by default:

```bash
git config --global commit.gpgsign false   # if you have GPG signing on; DCO is separate
git config alias.cs "commit -s"
# then use `git cs ...` instead of `git commit ...`
```

To retroactively sign an existing branch:

```bash
git rebase -i HEAD~N --signoff
```

## Code style

- **TypeScript strict mode** — `strict: true` + `noUncheckedIndexedAccess` are on. No `any` without a comment explaining why.
- **No comments that just restate code** — the code says what; comments say _why_.
- **Tests live next to the thing they test** — `src/masking/validators/luhn.ts` → `test/masking/validators.test.ts` (grouped by category).
- **One validator per file** under `src/masking/validators/`; one test per validator with positive + negative cases.
- **No emojis in source files or commit messages** unless the situation genuinely calls for one.

## Adding a new masking rule

The masking ruleset lives in `src/masking/rules/data-masking-rules.yaml`. To add a rule:

1. Append a new entry under `rules:` with `name`, `description`, `marker`, `pattern`, optional `validation`, and at least one `examples:` entry.
2. The `examples` array is **required** by the data-driven coverage test (`test/masking/rule-coverage.test.ts`) — every example must match its rule's pattern AND get redacted to its declared marker.
3. If your rule needs a new validator (e.g. a checksum), add it under `src/masking/validators/`, register it in `validators/index.ts`'s `VALIDATORS` map, and reference it via `validation: <name>` in the YAML.
4. `npm test` will regenerate `rules.json` and run the full suite, including coverage assertions for your new rule.

## Releasing (maintainers only)

CI handles publishing. Push to `main` → workflow publishes `@darkhunt-security/telemetry@<base>-build.<run_number>`.

To bump the base version, edit `package.json`'s `version` field on a PR.

## Reporting security issues

**Don't open a public issue for security vulnerabilities.** See [`SECURITY.md`](./SECURITY.md) for the disclosure policy.

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Be kind, be patient, assume good faith.
