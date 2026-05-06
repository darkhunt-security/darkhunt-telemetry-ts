# Open-sourcing checklist — `darkhunt-telemetry-ts` under Apache 2.0

Working document. Strike items as they land. Estimated total effort: **1–2 days**.

---

## Phase 0 — Decisions (do first, blocks the rest)

These choices change everything downstream. Lock them before touching code.

- [ ] **Package name**: keep `@darkhunt-security/telemetry` (org-scoped, like Sentry/Langfuse) or rename to a neutral org. **Recommended: keep.**
- [ ] **Class name**: keep `DarkhuntTelemetry` (matches naming convention of similar SDKs). **Recommended: keep.**
- [ ] **Attribute namespace**: keep `darkhunt.observation.*` (every OTel-based SDK has its own namespace) or rename to `llmobs.*`. **Recommended: keep — it's the trace-hub wire contract.**
- [ ] **Masking schema strategy** (the only blocker): pick one
  - [ ] **A. Open-source `@darkhunt-security/masking-schema` too** (public npm + Maven Central + PyPI). Cleanest, preserves cross-language single source of truth.
  - [ ] **B. Vendor the YAML inline.** Drop the artifact dep, embed at build time. Loses cross-language sharing but eliminates the dep.
  - [ ] **C. Make masking opt-in and lazy-load the schema package.** Punts the access problem.

  **Recommended: A** — same effort as B but keeps the architecture intact.

---

## Phase 1 — Licensing (must-have)

### 1.1 Add `LICENSE` file

Create `/LICENSE` containing the [Apache 2.0 full text](https://www.apache.org/licenses/LICENSE-2.0.txt). Header line: `Copyright 2026 Darkhunt Security, Inc.`

### 1.2 Add `NOTICE` file

Required by Apache 2.0 §4(d) when redistributing. Minimal contents:

```
darkhunt-telemetry
Copyright 2026 Darkhunt Security, Inc.

This product includes software developed by:
  - The OpenTelemetry Authors (Apache 2.0)
  - Paul Miller (@noble/hashes, MIT)
```

### 1.3 Update `package.json`

```json
{
  "license": "Apache-2.0",
  "publishConfig": {
    "registry": "https://registry.npmjs.org",
    "access": "public"
  }
}
```

Currently:

- `license` field is **missing** entirely
- `publishConfig.registry` points to `npm.pkg.github.com` (private)
- `publishConfig.access` is `"restricted"`

### 1.4 Optional: SPDX headers in source files

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Darkhunt Security, Inc.
```

Add to all `src/**/*.ts` and `test/**/*.ts`. Optional but conventional for Apache projects.

---

## Phase 2 — Masking schema (the blocker)

Following the **Option A** path:

### 2.1 In `api-contract` repo

- [ ] Add `LICENSE` (Apache 2.0) at repo root
- [ ] Add `NOTICE` referencing third-party tooling (jsonschema2pojo, datamodel-codegen, json-schema-to-typescript)
- [ ] Update `contracts/schemas/masking/MaskingRule.json` and `MaskingRulesFile.json` — no licensing changes needed in the JSON itself, but a top-level note in the YAML header would help:
  ```yaml
  # data-masking-rules.yaml
  # SPDX-License-Identifier: Apache-2.0
  # Copyright 2026 Darkhunt Security, Inc.
  version: '2026.5.6'
  ```
- [ ] Modify `scripts/publish-schema-npm.sh`:
  - Switch `publishConfig.registry` → `https://registry.npmjs.org`
  - Set `"access": "public"`
  - Add `"license": "Apache-2.0"` to the generated `package.json`
- [ ] Modify `scripts/publish-pypi.sh` and the generated `pyproject.toml`:
  - Add `license = "Apache-2.0"` and `license-files = ["LICENSE"]`
  - Switch publish target from Nexus to public PyPI
- [ ] Modify `generate.sh`'s `generate_schema_pom`:
  - Add `<licenses><license><name>Apache-2.0</name>...</license></licenses>` block
  - Switch `<distributionManagement>` to Sonatype Central (or keep GitHub Packages public)
- [ ] Bump version (e.g. `2026.5.7`) and republish all three artifacts

### 2.2 In `darkhunt-telemetry-ts`

- [ ] Update dep range to the new public version
- [ ] Verify `npm install` works without GitHub PAT auth

---

## Phase 3 — Strip internal references

### 3.1 Source code (3 files with internal context in comments)

| File                | Line | What to do                                                                                                 |
| ------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `src/span.ts`       | 53   | "trace-hub" → soften to "the receiving backend"                                                            |
| `src/client.ts`     | 39   | "trace-hub's `/internal/...` endpoint" → describe as a generic dual-endpoint pattern                       |
| `src/attributes.ts` | 11   | Reference to `trace-hub/mappings/darkhunt.yaml` → describe the convention without naming the internal file |

### 3.2 README (heavily branded)

| Line(s)                 | Issue                                            | Fix                                                                                                                           |
| ----------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1                       | Title `darkhunt-telemetry-ts`                    | Keep                                                                                                                          |
| 3                       | "LLM observability SDK for DarkHunt trace-hub"   | Lead with the problem ("Send LLM call traces to any OTLP-compatible backend") then mention trace-hub as the reference backend |
| 5                       | Python sibling link                              | Keep but ensure the Python repo is also OS'd or note "(internal)"                                                             |
| 12-16                   | Install instructions require Darkhunt GitHub PAT | Replace with vanilla `npm install @darkhunt-security/telemetry`                                                               |
| 24                      | Hardcoded `https://app.darkhunt.ai` example      | Use `https://your-backend.example.com` placeholder + a one-line note about Darkhunt's hosted instance                         |
| 102                     | `https://seth-dev.darkhunt.ai`                   | Replace with placeholder                                                                                                      |
| 110                     | "This is also how the [`darkhunt-cli`]…"         | Drop the internal reference or move to a "Used by" section at the bottom                                                      |
| 213, 241, 290, 312, 354 | Various "trace-hub" mentions in examples         | Soften to "the dashboard" / "the receiving backend"                                                                           |

---

## Phase 4 — Standard OS hygiene files

All currently missing.

### 4.1 `CONTRIBUTING.md`

Standard skeleton:

```markdown
# Contributing

We welcome PRs. Please:

1. File an issue first for non-trivial changes
2. Run `npm run typecheck && npm test && npm run lint` before pushing
3. Sign your commits (DCO or CLA — pick one and document)
4. Update CHANGELOG.md under "Unreleased"
```

**Decision needed**: DCO (lighter, just `git commit -s`) or CLA (heavier, but legal protection). Most modern OSS uses DCO.

### 4.2 `CODE_OF_CONDUCT.md`

Adopt [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). One-line file:

```markdown
This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Report issues to security@darkhunt.ai.
```

### 4.3 `SECURITY.md`

**Especially important** since this is a security-adjacent SDK:

```markdown
# Security Policy

## Reporting a vulnerability

Email security@darkhunt.ai. Do NOT open a public issue.
We aim to acknowledge within 48h and ship a fix within 14 days for high-severity issues.

## Scope

- Vulnerabilities in the SDK code itself (data leaks, misuse of crypto primitives, etc.)
- Vulnerabilities in the bundled masking ruleset (false-negatives that leak sensitive data)
- Out of scope: vulnerabilities in trace-hub or other Darkhunt backends (report separately)

## Supported versions

Latest minor only. Older versions get fixes only at our discretion.
```

### 4.4 `CHANGELOG.md`

[Keep-a-changelog](https://keepachangelog.com/) format. Backfill from git tags:

```markdown
# Changelog

## [Unreleased]

## [0.5.0] — 2026-05-05

### Added

- Client-side data masking enabled by default (`mask` option on `DarkhuntTelemetryOptions`)
- 7 validators: luhn, credit_card, aba, iban_mod97, base58check, bech32, eip55
- Data-driven rule coverage tests
- Built on `@darkhunt-security/masking-schema` shared artifact

## [0.4.0] — earlier

- Initial OTLP exporter, span/trace/generation classes
```

### 4.5 `.github/`

- `ISSUE_TEMPLATE/bug_report.md` and `feature_request.md` (GitHub's defaults are fine)
- `PULL_REQUEST_TEMPLATE.md` — checklist for tests + changelog
- `workflows/ci.yml` — currently private; move to public Actions on the open repo

---

## Phase 5 — Pluggable exporter (optional but valuable)

The current `DarkhuntSpanExporter` hardcodes the URL template `${baseUrl}/otlp/t/{tenantId}/v1/traces` and the auth header (`Authorization: Bearer <apiKey>`). For OS adoption beyond Darkhunt's own backend:

### 5.1 Parameterize URL template

```ts
export interface DarkhuntTelemetryOptions {
  // ...
  /** URL template; `{tenantId}` is replaced per-trace. Default: trace-hub format. */
  pathTemplate?: string; // default: '/otlp/t/{tenantId}/v1/traces'
}
```

### 5.2 Allow custom auth

Either: (a) accept a `headers?: Record<string, string>` option, or (b) accept an `authProvider?: () => string` for dynamic tokens. Drops the hardcoded `Bearer` assumption.

### 5.3 Document Backends section in README

- Darkhunt trace-hub (default config)
- Self-hosted trace-hub
- Langfuse via OTLP endpoint (with `pathTemplate: '/api/public/otel/v1/traces'` and Basic auth)
- Generic OTLP collector

This single change unlocks the SDK for the broader OTel ecosystem.

---

## Phase 6 — Pre-launch dry run

- [ ] `npm pack` the SDK locally; install the tarball into a fresh empty project; verify `npm install` resolves all transitive deps from public registries only (no GitHub Packages)
- [ ] Run all tests (`npm test`) to confirm nothing depends on private state
- [ ] Confirm `dist/` ships cleanly with no source map references to absolute local paths
- [ ] Check `npm publish --dry-run` for any registry warnings
- [ ] One human pair-of-eyes scan for "darkhunt-internal" / "TODO" / "FIXME" / "private" comments

---

## Phase 7 — Launch

- [ ] Create new public GitHub repo (or move existing repo to public)
- [ ] First public release: tag, push, CI publishes to npm
- [ ] Announce: blog post, HN, OTel community Slack
- [ ] Watch GitHub issues for the first week

---

## Things explicitly NOT changing

- **OpenTelemetry SDK foundation** — already Apache-2.0, integrates cleanly
- **Wire format** (OTLP protobuf) — open standard, no licensing concerns
- **Test framework** (Node's built-in `node:test`) — no licensing, no extra deps
- **Build tooling** (`tsc`, `tsx`) — Apache/MIT, fine

---

## Risks & open questions

1. **Trademark**: "Darkhunt" is presumably a registered name. If we keep `DarkhuntTelemetry` / `@darkhunt-security/...`, we should add a trademark notice in NOTICE explicitly granting use of the name in documentation but reserving rights for forks/derivatives.
2. **Patent grant**: Apache 2.0 §3 includes a patent grant. Verify with legal that we're comfortable extending this for the masking validators (Luhn, IBAN, etc. are all public-domain algorithms, so no real risk).
3. **Compliance frameworks**: if customers use Darkhunt for SOC 2 / HIPAA / etc. evidence, OS'ing the SDK doesn't change their compliance posture — but make this explicit in README so no one panics.
4. **Support expectations**: OS-ing creates an implicit support burden. Decide upfront whether GitHub issues are best-effort or have an SLA.
