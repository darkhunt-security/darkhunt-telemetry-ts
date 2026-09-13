/**
 * Tests for the tool-observation attributes (`gen_ai.tool.*`) emitted by
 * Span.setToolAttrs, both at construction and via update(). These assert that:
 *   - toolName / toolCallId round-trip unchanged,
 *   - toolArguments are emitted verbatim (strings as-is, objects as JSON),
 *   - toolCallId / toolName set through update()-after-construction survive.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

import { Trace } from '../src/trace.js';
import { GEN_AI } from '../src/attributes.js';

const ROUTING = { tenantId: 't1', workspaceId: 'ws1', applicationId: 'app1' };

/** Fresh in-memory tracer + Trace per test, to isolate exports. */
function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');
  const trace = new Trace(tracer, ROUTING);
  return { exporter, trace };
}

/** The single tool span we ended (the trace root is never ended in these tests). */
function toolSpan(exporter: InMemorySpanExporter): ReadableSpan {
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1, 'expected exactly one finished (ended) span');
  return spans[0]!;
}

describe('Span tool attributes (gen_ai.tool.*)', () => {
  it('emits toolName / toolCallId / toolArguments set at construction', () => {
    const { exporter, trace } = setup();
    trace
      .span('search', {
        observationType: 'tool',
        toolName: 'web_search',
        toolCallId: 'call_123',
        toolArguments: { query: 'weather' },
      })
      .end();

    const attrs = toolSpan(exporter).attributes;
    assert.equal(attrs[GEN_AI.TOOL_NAME], 'web_search');
    assert.equal(attrs[GEN_AI.TOOL_CALL_ID], 'call_123');
    // Object arguments are JSON-stringified.
    assert.equal(attrs[GEN_AI.TOOL_CALL_ARGUMENTS], JSON.stringify({ query: 'weather' }));
  });

  it('emits structured toolArguments verbatim', () => {
    const { exporter, trace } = setup();
    trace
      .span('call', {
        observationType: 'tool',
        toolArguments: { email: 'john@example.com', limit: 10 },
      })
      .end();

    const raw = toolSpan(exporter).attributes[GEN_AI.TOOL_CALL_ARGUMENTS];
    assert.equal(typeof raw, 'string');
    assert.deepEqual(JSON.parse(raw as string), { email: 'john@example.com', limit: 10 });
  });

  it('emits a string toolArguments value as-is', () => {
    const { exporter, trace } = setup();
    trace
      .span('call', {
        observationType: 'tool',
        toolArguments: 'contact john@example.com',
      })
      .end();

    // String arguments stay a string (not JSON-wrapped).
    assert.equal(
      toolSpan(exporter).attributes[GEN_AI.TOOL_CALL_ARGUMENTS],
      'contact john@example.com'
    );
  });

  it('preserves toolName / toolCallId set via update()-after-construction', () => {
    const { exporter, trace } = setup();
    const span = trace.span('call', { observationType: 'tool' });
    span.update({ toolName: 'lookup', toolCallId: 'call_456' });
    span.end();

    const attrs = toolSpan(exporter).attributes;
    assert.equal(attrs[GEN_AI.TOOL_NAME], 'lookup');
    assert.equal(attrs[GEN_AI.TOOL_CALL_ID], 'call_456');
  });
});
