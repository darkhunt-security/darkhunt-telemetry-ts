import { context, propagation, diag } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

let registered = false;

/**
 * Register the global OTel **context manager** + **W3C propagator** for this process.
 *
 * Why the SDK needs this: it builds its OWN `TracerProvider` and deliberately does
 * NOT register it as the global tracer provider (so it never hijacks a host app's
 * OpenTelemetry setup). But without a global *context manager*, `context.with(...)`
 * is a silent no-op — so every trace starts a fresh root and cross-service spans
 * never nest (agent-topology reconstruction breaks: nodes render as disconnected
 * islands). This installs just the context plumbing — not a tracer provider — so
 * `context.with()` works and `traceparent` extract/inject can nest spans.
 *
 * Safe + idempotent:
 *  - runs at most once per process (guarded);
 *  - `setGlobalContextManager` will NOT override a context manager the host already
 *    registered — in that case we leave the host's in place and do nothing.
 *
 * Called automatically by the {@link DarkhuntTelemetry} constructor unless you pass
 * `registerContextManager: false` (or set `DARKHUNT_REGISTER_CONTEXT_MANAGER=false`)
 * — disable it only if your app already registers an OTel context manager itself.
 *
 * @returns `true` if this call registered the context manager, `false` if it was
 *          skipped (already registered here, or a global one was already present).
 */
export function registerOtelContextGlobals(): boolean {
  if (registered) return false;
  registered = true;

  const setCtx = context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  // W3C is OTel's default propagator; set it so traceparent inject/extract works
  // even if the host never configured one. Won't override an existing global.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  if (!setCtx) {
    diag.debug(
      'darkhunt-telemetry: a global OTel ContextManager was already registered; ' +
        'leaving the existing one in place.'
    );
  }
  return setCtx;
}
