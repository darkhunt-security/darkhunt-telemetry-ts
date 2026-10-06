import { context as otContext, createContextKey } from '@opentelemetry/api';
import type { Span } from './span.js';
import type { Trace } from './trace.js';

/**
 * The Darkhunt observation (a {@link Trace} or {@link Span}) that owns the active OTel
 * context. Every `Trace` / `Span` stores itself under this key in its own `.context`, so
 * whatever made that context active — `startActiveSpan`, `startActiveGeneration`,
 * `trace.activate(...)` — also makes it the current run. Code deep in a call stack (a
 * guarded tool) reads the run from here instead of having it passed through.
 */
export const OBSERVATION_KEY = createContextKey('darkhunt.observation');

/** The current Darkhunt observation, or `undefined` outside any run. */
export function currentObservation(): Trace | Span | undefined {
  return otContext.active().getValue(OBSERVATION_KEY) as Trace | Span | undefined;
}
