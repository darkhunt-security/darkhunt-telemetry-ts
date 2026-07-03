---
name: Bug report
about: The SDK did something it shouldn't, or didn't do something it should
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- A clear, terse description. One paragraph. -->

## Expected behavior

<!-- What should have happened instead. -->

## Reproduction

The smallest standalone code that triggers the bug. If it requires real LLM calls or a running backend, mock those out — we should be able to copy-paste and run.

```ts
import { DarkhuntTelemetry } from '@darkhunt-security/telemetry';

const dh = new DarkhuntTelemetry({/* ... */});
// ...
```

Output / error message:

```
<paste here>
```

## Environment

- SDK version: <!-- e.g. 0.5.0-build.18 (run `npm ls @darkhunt-security/telemetry`) -->
- Node version: <!-- `node -v` -->
- OS: <!-- macOS 14, Ubuntu 22.04, etc. -->
- Backend you're sending to: <!-- Darkhunt trace-hub, self-hosted OTLP collector, Langfuse, etc. -->

## Additional context

<!-- Stack traces, screenshots, related issues, anything else useful. Delete this section if empty. -->
