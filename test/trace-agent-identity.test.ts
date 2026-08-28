/**
 * Tests for `TraceArgs.agent` — per-agent topology node identity from a single
 * client / TracerProvider / Resource.
 *
 * Two things have to hold together, and the second is what makes the first safe:
 *
 *  1. `service.name` is emitted as a SPAN attribute on the root and on every child
 *     span, so the backend (which resolves a trace group's identity from merged
 *     attributes, where span attributes outrank the Resource) sees the agent rather
 *     than the process.
 *  2. An agent-scoped trace is always a fresh ROOT — never parented under
 *     handoffFrom[0], never under an ambient active span. Identity is resolved once
 *     per trace id, so two agents sharing a trace would collapse onto whichever name
 *     merged first. Upstreams stay `agent_handoff` links, which is what topology
 *     reconstruction resolves the edge from.
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
import { ATTR } from '../src/attributes.js';
import { HANDOFF_LINK_KIND, LINK_KIND_ATTR } from '../src/span.js';
import { registerOtelContextGlobals } from '../src/otel-globals.js';

registerOtelContextGlobals();

const ROUTING = { tenantId: 't1', workspaceId: 'ws1', applicationId: 'app1' };

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, tracer: provider.getTracer('test') };
}

function spanByName(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  assert.ok(span, `expected an exported span named "${name}"`);
  return span;
}

function traceIdOf(trace: Trace): string {
  const sc = otTrace.getSpanContext(trace.context);
  assert.ok(sc?.traceId, 'expected a resolvable root context');
  return sc.traceId;
}

function spanIdOf(trace: Trace): string {
  const sc = otTrace.getSpanContext(trace.context);
  assert.ok(sc?.spanId, 'expected a resolvable root context');
  return sc.spanId;
}

describe('TraceArgs.agent — span-level service.name', () => {
  it('stamps service.name on the trace root', () => {
    const { exporter, tracer } = setup();
    const t = new Trace(tracer, { ...ROUTING, name: 'research.run', agent: 'research' });
    t.end();

    assert.equal(spanByName(exporter, 'research.run').attributes[ATTR.SERVICE_NAME], 'research');
  });

  it('stamps service.name on EVERY child span, not just the root', () => {
    const { exporter, tracer } = setup();
    const t = new Trace(tracer, { ...ROUTING, name: 'research.run', agent: 'research' });
    t.span('load-filings').end();
    t.generation('summarise').end();
    t.end();

    // A root-only value would move the root to the agent's node and strand the
    // subtree on the Resource's node — an empty agent card beside the real work.
    for (const name of ['research.run', 'load-filings', 'summarise']) {
      assert.equal(
        spanByName(exporter, name).attributes[ATTR.SERVICE_NAME],
        'research',
        `${name} must carry the agent identity`
      );
    }
  });

  it('emits no service.name span attribute when agent is unset', () => {
    const { exporter, tracer } = setup();
    const t = new Trace(tracer, { ...ROUTING, name: 'plain.run' });
    t.span('child').end();
    t.end();

    // Falls through to the Resource service.name configured on the client.
    for (const name of ['plain.run', 'child']) {
      assert.equal(spanByName(exporter, name).attributes[ATTR.SERVICE_NAME], undefined);
    }
  });
});

describe('TraceArgs.agent — one agent per trace id', () => {
  it('starts a new trace instead of nesting under handoffFrom[0]', () => {
    const { tracer } = setup();
    const research = new Trace(tracer, { ...ROUTING, name: 'research.run', agent: 'research' });
    const scoring = new Trace(tracer, {
      ...ROUTING,
      name: 'score.deal',
      agent: 'deal-scoring',
      handoffFrom: [research.handoffToken()],
    });

    assert.notEqual(
      traceIdOf(scoring),
      traceIdOf(research),
      'an agent-scoped trace must not share a trace id with its upstream'
    );
  });

  it('keeps the upstream as an agent_handoff link — the edge survives', () => {
    const { exporter, tracer } = setup();
    const research = new Trace(tracer, { ...ROUTING, name: 'research.run', agent: 'research' });
    const researchRootId = spanIdOf(research);
    const scoring = new Trace(tracer, {
      ...ROUTING,
      name: 'score.deal',
      agent: 'deal-scoring',
      handoffFrom: [research.handoffToken()],
    });
    scoring.end();
    research.end();

    const root = spanByName(exporter, 'score.deal');
    assert.equal(root.links.length, 1, 'expected exactly one handoff link');
    assert.equal(root.links[0]?.context.spanId, researchRootId);
    assert.equal(root.links[0]?.attributes?.[LINK_KIND_ATTR], HANDOFF_LINK_KIND);
  });

  it('ignores an ambient active span so co-hosted agents never merge', async () => {
    const { tracer } = setup();
    // Stands in for a shared HTTP/server span both agents run beneath — the exact
    // case that would otherwise pull two agents into one trace id.
    const serverSpan = tracer.startSpan('POST /deals');
    const serverCtx = otTrace.setSpan(otContext.active(), serverSpan);

    const { research, scoring } = await otContext.with(serverCtx, async () => ({
      research: new Trace(tracer, { ...ROUTING, name: 'research.run', agent: 'research' }),
      scoring: new Trace(tracer, { ...ROUTING, name: 'score.deal', agent: 'deal-scoring' }),
    }));

    const serverTraceId = serverSpan.spanContext().traceId;
    assert.notEqual(traceIdOf(research), serverTraceId);
    assert.notEqual(traceIdOf(scoring), serverTraceId);
    assert.notEqual(traceIdOf(research), traceIdOf(scoring));
  });

  it('still nests under handoffFrom[0] when agent is unset', () => {
    const { tracer } = setup();
    const upstream = new Trace(tracer, { ...ROUTING, name: 'caller' });
    const downstream = new Trace(tracer, {
      ...ROUTING,
      name: 'callee',
      handoffFrom: [upstream.handoffToken()],
    });

    // Existing behaviour must be untouched for every caller that does not opt in.
    assert.equal(traceIdOf(downstream), traceIdOf(upstream));
  });
});
