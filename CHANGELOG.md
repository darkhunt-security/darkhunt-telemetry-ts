# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Configurable `service.name`.** New `serviceName` option (resolves
  `serviceName` > `DARKHUNT_SERVICE_NAME` > `OTEL_SERVICE_NAME` > library name)
  sets the OTel Resource `service.name`, which the backend records per span.
  Give each process/agent its own value to distinguish producers in a
  multi-service / multi-agent system. Previously hardcoded to the library name.
- **Tool observation fields.** New `toolName` / `toolCallId` / `toolArguments`
  span options emit `gen_ai.tool.name` / `gen_ai.tool.call.id` /
  `gen_ai.tool.call.arguments`, so `tool`-type spans surface the actual tool
  (e.g. "geocode") instead of the generic type.
- **Span links + agent handoffs.** `trace.handoffToken()` returns a serialisable
  `HandoffToken` (a W3C `traceparent`) for the trace's root/entry span, and
  `dh.trace({ handoffFrom })` / `.span({ links })` attach OTel span links to upstream
  agents — the basis for multi-agent **topology** reconstruction (who handed off to
  whom). Supports fan-in; links are auto-tagged `darkhunt.link.kind = "agent_handoff"`
  so consumers can tell handoffs apart from other uses of OTel links.

### Documentation

- **`baseUrl` default corrected in the README config table and both integration
  skills** to `https://api.darkhunt.ai/trace-hub` — they still showed the old
  `https://app.darkhunt.ai` after the 0.5.3 default flip. Added explicit guidance
  for overriding `DARKHUNT_BASE_URL` in non-prod environments: use the `api…`
  ingest host **with** the `/trace-hub` path (e.g.
  `https://api-seth-dev.darkhunt.ai/trace-hub`). Dropping `/trace-hub` returns
  404; the `app…` dashboard host returns 405.

## [0.5.3] — 2026-05-08

Bug-fix release driven by an external QA pass on 0.5.2. No public API
changes; all existing consumers should upgrade.

### Fixed

- **Masking coverage extended** from ~6 channels to ~11. The sanitizer now
  also runs on `span` / `generation` / `event` names, trace tags,
  `modelParameters`, `promptName`, `promptVersion`, `version`, and metadata
  KEYS — channels that previously reached the wire verbatim.
- **BigInt and circular references** in metadata or input/output no longer
  crash the span. BigInts serialize as strings (closest JSON has); cycles
  render as the placeholder `"[circular]"`.
- **Zero-width-space splice bypass** closed. A secret split with `U+200B`,
  `U+200C`, `U+200D`, or `U+FEFF` is stripped before the masking regex, so
  `sk-proj-<ZWS>1234…` still matches the OpenAI key pattern.
- **ReDoS guard for custom patterns**: `customPatterns` whose regex source
  contains a known catastrophic-backtracking shape (`(.+)+`, `(\w+)+`,
  `(\d*)+`, `(.*)+`, `(\S+)*`, `(a|a)*`) is rejected at constructor time
  with an actionable error.
- **`flush()` and `shutdown()` always resolve.** `BatchSpanProcessor` rejects
  with `undefined` on persistent export failure (surfacing to callers as
  "uncaught (in promise): undefined"); both methods now swallow and
  re-surface the error via `diag.warn`.
- **`update()` / `end()` after `end()`** no longer spray OTel-internal stack
  traces; one clean `diag.warn` is emitted instead.
- **`MaxListenersExceededWarning`** when constructing >10 SDK instances in
  one process (test runners, multi-tenant servers). Per-instance
  `process.once('beforeExit', …)` handlers replaced with a single shared
  handler that iterates an `activeInstances` Set; the listener is removed
  when the Set goes idle.
- **Trailing sleep on the final retry attempt** removed. Saves up to ~4 s
  per terminally-failed batch.
- **Inherited trace name on child spans** is now masked. A trace whose
  `name` contained a secret previously leaked the raw value via
  `darkhunt.trace.name` on every child span.

### Changed

- **Default `baseUrl` flipped** from `https://app.darkhunt.ai` (dashboard
  host, returns 405 after redirecting to `/auth/login`) to
  `https://api.darkhunt.ai/trace-hub` (the actual ingest endpoint).
  Anyone relying on the old default was already getting silent export
  failures.
- **`engines.node` widened** from `^24.4.1` to `>=24.4.1`. Resolves the
  spurious `EBADENGINE` warning when installing on Node 25.x; the SDK
  already runs cleanly there.
- **Span/generation/event names are sanitized.** Names that match a masking
  rule are replaced by the rule's marker before reaching the wire. This is
  a behavior change for anyone deliberately putting rule-matching IDs in
  names; documented here as part of the masking coverage extension above.
- **Number leaves in metadata** are considered for masking when their
  stringified form falls in the 7–19 digit range (plausible
  SSN/phone/CC/account-number lengths). Smaller and larger numbers
  bypass the rule loop.

### Documentation

- Added a JSDoc note on `TraceArgs.sessionId` / `userId` / `userEmail`
  clarifying that these are routing identifiers and **are not run through
  the masking sanitizer** — they round-trip verbatim because the dashboard
  groups, filters, and de-duplicates by exact match. Hash PII-bearing
  identifiers on the caller side before passing them in.

[0.5.3]: https://github.com/darkhunt-security/darkhunt-telemetry-ts/releases/tag/v0.5.3
[0.5.2]: https://github.com/darkhunt-security/darkhunt-telemetry-ts/releases/tag/v0.5.2
