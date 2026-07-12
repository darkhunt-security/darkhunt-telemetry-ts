/**
 * Tests for automatic root-span parenting under `handoffFrom[0]` (the SDK's
 * cross-service nesting). A downstream agent's trace must become a CHILD of its
 * caller's span — same traceId, parentSpanId == the upstream span's spanId — so
 * the platform can reconstruct the topology from the parentSpanId chain WITHOUT
 * any app-side `context.with(...)` wrapper. handoffFrom[0] is the parent edge AND
 * stays an `agent_handoff` link; handoffFrom[1..] and `links` remain links only.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { context as otContext, trace as otTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

import { Trace } from '../src/trace.js';
import { HANDOFF_LINK_KIND, LINK_KIND_ATTR } from '../src/span.js';
import { registerOtelContextGlobals } from '../src/otel-globals.js';

// The active-span helpers (Deliverable B) rely on a global context manager for
// `context.with(...)` to actually nest. Idempotent; safe to call here.
registerOtelContextGlobals();

const ROUTING = { tenantId: 't1', workspaceId: 'ws1', applicationId: 'app1' };

/** Fresh in-memory tracer per test (SimpleSpanProcessor → sync export on end). */
function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');
  return { exporter, tracer };
}

/** The exported (ended) span with the given name. */
function spanByName(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  assert.ok(span, `expected an exported span named "${name}"`);
  return span;
}

/** spanId of a Trace's root span, read from its OTel context. */
function rootSpanId(trace: Trace): string {
  const sc = otTrace.getSpanContext(trace.context);
  assert.ok(sc?.spanId, 'expected a resolvable root span context');
  return sc.spanId;
}
function rootTraceId(trace: Trace): string {
  const sc = otTrace.getSpanContext(trace.context);
  assert.ok(sc?.traceId, 'expected a resolvable root trace context');
  return sc.traceId;
}

describe('Trace auto-parenting under handoffFrom[0]', () => {
  it('nests the root under the upstream token: parentSpanId + shared traceId + link', () => {
    const { exporter, tracer } = setup();

    const upstream = new Trace(tracer, { ...ROUTING, name: 'up' });
    const token = upstream.handoffToken();

    const downstream = new Trace(tracer, { ...ROUTING, name: 'down', handoffFrom: [token] });
    downstream.end();
    upstream.end();

    const down = spanByName(exporter, 'down');
    // Parent edge: the downstream root is a child of the upstream root span.
    assert.equal(down.parentSpanContext?.spanId, rootSpanId(upstream), 'parentSpanId == upstream');
    assert.equal(down.spanContext().traceId, rootTraceId(upstream), 'shares upstream traceId');
    // …and the same upstream is STILL emitted as an agent_handoff link (kept for
    // marker-based reconstruction / existing assertions).
    assert.equal(down.links.length, 1, 'exactly one handoff link');
    assert.equal(down.links[0]?.context.spanId, rootSpanId(upstream));
    assert.equal(down.links[0]?.attributes?.[LINK_KIND_ATTR], HANDOFF_LINK_KIND);
  });

  it('accepts a raw OTel Context (not just a token) as handoffFrom[0]', () => {
    const { exporter, tracer } = setup();

    const upstream = new Trace(tracer, { ...ROUTING, name: 'up' });
    const downstream = new Trace(tracer, {
      ...ROUTING,
      name: 'down',
      handoffFrom: [upstream.context],
    });
    downstream.end();

    const down = spanByName(exporter, 'down');
    assert.equal(down.parentSpanContext?.spanId, rootSpanId(upstream));
    assert.equal(down.spanContext().traceId, rootTraceId(upstream));
  });

  it('fan-in: handoffFrom[0] is the parent; [1..] are links only', () => {
    const { exporter, tracer } = setup();

    const a = new Trace(tracer, { ...ROUTING, name: 'a' });
    const b = new Trace(tracer, { ...ROUTING, name: 'b' });

    const merged = new Trace(tracer, {
      ...ROUTING,
      name: 'merged',
      handoffFrom: [a.handoffToken(), b.handoffToken()],
    });
    merged.end();

    const span = spanByName(exporter, 'merged');
    // Parent is a (handoffFrom[0]); it shares a's trace.
    assert.equal(span.parentSpanContext?.spanId, rootSpanId(a), 'parent is handoffFrom[0]');
    assert.equal(span.spanContext().traceId, rootTraceId(a));
    // Both upstreams are links (fan-in) — a AND b.
    const linkedSpanIds = span.links.map((l) => l.context.spanId).sort();
    assert.deepEqual(linkedSpanIds, [rootSpanId(a), rootSpanId(b)].sort());
    for (const link of span.links) {
      assert.equal(link.attributes?.[LINK_KIND_ATTR], HANDOFF_LINK_KIND);
    }
  });

  it('no handoff: root is a fresh top-level span (behavior unchanged)', () => {
    const { exporter, tracer } = setup();

    const t = new Trace(tracer, { ...ROUTING, name: 'root' });
    t.end();

    const span = spanByName(exporter, 'root');
    assert.equal(span.parentSpanContext?.spanId, undefined, 'no parent → top-level root');
    assert.equal(span.links.length, 0, 'no links');
  });

  it('unresolvable handoffFrom token → unchanged (no parent, no link)', () => {
    const { exporter, tracer } = setup();

    const t = new Trace(tracer, { ...ROUTING, name: 'root', handoffFrom: ['not-a-traceparent'] });
    t.end();

    const span = spanByName(exporter, 'root');
    assert.equal(span.parentSpanContext?.spanId, undefined);
    assert.equal(span.links.length, 0);
  });

  it('links (never a parent) stay links only; handoffFrom[0] still parents', () => {
    const { exporter, tracer } = setup();

    const linked = new Trace(tracer, { ...ROUTING, name: 'linked' });
    const parent = new Trace(tracer, { ...ROUTING, name: 'parent' });

    const t = new Trace(tracer, {
      ...ROUTING,
      name: 'child',
      links: [linked.context],
      handoffFrom: [parent.handoffToken()],
    });
    t.end();

    const span = spanByName(exporter, 'child');
    // handoffFrom[0] parents; the `links` entry never becomes a parent.
    assert.equal(span.parentSpanContext?.spanId, rootSpanId(parent));
    const linkedSpanIds = span.links.map((l) => l.context.spanId).sort();
    assert.deepEqual(linkedSpanIds, [rootSpanId(linked), rootSpanId(parent)].sort());
  });
});

describe('startActiveSpan / startActiveGeneration (active-context helpers)', () => {
  it('runs the callback with the child span ACTIVE in the ambient context', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: 'root' });

    let activeInside: string | undefined;
    const result = trace.startActiveSpan('work', (span) => {
      // The child span is the active span → auto-instrumentation / bare
      // tracer.startSpan would nest under it.
      activeInside = otTrace.getSpanContext(otContext.active())?.spanId;
      const childId = otTrace.getSpanContext(span.context)?.spanId;
      assert.equal(activeInside, childId, 'child is the active span inside fn');
      return 42;
    });

    assert.equal(result, 42, 'returns the callback value');
    // Context is restored after the call.
    assert.equal(otTrace.getSpanContext(otContext.active())?.spanId, undefined);
    // The child span was auto-ended (exported).
    const work = spanByName(exporter, 'work');
    assert.equal(work.parentSpanContext?.spanId, rootSpanId(trace), 'child nests under root');
  });

  it('a bare tracer.startSpan inside the callback nests under the active span', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: 'root' });

    trace.startActiveSpan('outer', () => {
      // No explicit parent — relies on the active context set by startActiveSpan.
      const inner = tracer.startSpan('inner-auto');
      inner.end();
    });

    const outer = spanByName(exporter, 'outer');
    const inner = spanByName(exporter, 'inner-auto');
    assert.equal(inner.parentSpanContext?.spanId, outer.spanContext().spanId, 'auto span nests');
  });

  it('awaits a promise-returning callback and ends the span after it settles', async () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: 'root' });

    const value = await trace.startActiveSpan('async-work', async (span) => {
      // Not yet ended while the promise is in flight.
      assert.equal(exporter.getFinishedSpans().length, 0);
      span.update({ output: 'done' });
      return 'ok';
    });

    assert.equal(value, 'ok');
    const span = spanByName(exporter, 'async-work');
    assert.ok(span, 'span ended after the promise settled');
  });

  it('marks the span ERROR and re-throws when the callback throws', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: 'root' });

    assert.throws(
      () =>
        trace.startActiveSpan('boom', () => {
          throw new Error('kaboom');
        }),
      /kaboom/
    );
    const span = spanByName(exporter, 'boom');
    // OTel SpanStatusCode.ERROR === 2.
    assert.equal(span.status.code, 2, 'ERROR status set');
    assert.equal(span.status.message, 'kaboom');
  });

  it('passes options through and supports the options overload', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: 'root' });

    trace.startActiveSpan('tool-call', { observationType: 'tool', toolName: 'lookup' }, () => {});

    const span = spanByName(exporter, 'tool-call');
    assert.equal(span.attributes['darkhunt.observation.type'], 'tool');
    assert.equal(span.attributes['gen_ai.tool.name'], 'lookup');
  });

  it('startActiveGeneration nests a generation and lets the callback record usage', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: 'root' });

    trace.startActiveGeneration('llm', { model: 'gpt-x' }, (gen) => {
      gen.end({ usage: { input_tokens: 3, output_tokens: 5 } });
    });

    const gen = spanByName(exporter, 'llm');
    assert.equal(gen.attributes['darkhunt.observation.type'], 'generation');
    assert.equal(gen.attributes['gen_ai.usage.input_tokens'], 3);
    assert.equal(gen.parentSpanContext?.spanId, rootSpanId(trace));
  });

  it('Span.startActiveSpan nests under the span, not the trace root', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: 'root' });
    const parent = trace.span('parent');

    parent.startActiveSpan('child', () => {});
    parent.end();

    const child = spanByName(exporter, 'child');
    assert.equal(child.parentSpanContext?.spanId, otTrace.getSpanContext(parent.context)?.spanId);
  });
});
