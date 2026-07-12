// Temporal ACTIVITY-side reader for the handoff token carried in a Temporal Header.
//
// The workflow propagates the handoff into a Temporal Header on the activity call
// (see the workflow interceptors); this activity interceptor reads it back and
// exposes it to the activity function via {@link currentHandoff} — an
// AsyncLocalStorage, valid because activities are NOT sandboxed. Activities then
// pass `handoffFrom: currentHandoff()` to `client.trace({ ... })`.
//
// Runs on the WORKER (Node) side: imports `@temporalio/worker` +
// `@temporalio/common` (OPTIONAL peer dependencies) and `node:async_hooks`. Do NOT
// import this from workflow code — use `@darkhunt-security/telemetry/temporal/workflow`
// there instead.

import { AsyncLocalStorage } from 'node:async_hooks';
import { defaultPayloadConverter } from '@temporalio/common';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptors,
  Next,
} from '@temporalio/worker';
import { HANDOFF_HEADER } from './handoff-header.js';

const store = new AsyncLocalStorage<string[]>();

/**
 * The upstream handoff token(s) this activity should nest under, read from the
 * Temporal Header the workflow propagated. Returns `undefined` outside an
 * activity, or when no handoff was propagated. Pass it straight to
 * `client.trace({ handoffFrom: currentHandoff() })`.
 */
export function currentHandoff(): string[] | undefined {
  return store.getStore();
}

/**
 * Worker activity-interceptor factory: read the handoff Header into the
 * AsyncLocalStorage exposed by {@link currentHandoff} for the duration of the
 * activity. Register it on the worker's `interceptors.activity` list. A malformed
 * or absent header is ignored (the activity simply sees no current handoff).
 */
export function handoffActivityInterceptors(): ActivityInterceptors {
  const inbound: ActivityInboundCallsInterceptor = {
    execute(
      input: ActivityExecuteInput,
      next: Next<ActivityInboundCallsInterceptor, 'execute'>
    ): Promise<unknown> {
      const p = input.headers[HANDOFF_HEADER];
      let handoff: string[] | undefined;
      if (p) {
        try {
          const v = defaultPayloadConverter.fromPayload(p);
          if (Array.isArray(v)) handoff = v as string[];
        } catch {
          /* ignore malformed header */
        }
      }
      return handoff ? store.run(handoff, () => next(input)) : next(input);
    },
  };
  return { inbound };
}
