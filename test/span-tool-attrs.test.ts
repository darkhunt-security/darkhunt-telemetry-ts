/**
 * Tests for the tool-observation attributes (`gen_ai.tool.*`) emitted by
 * Span.setToolAttrs, both at construction and via update(). The masking layer
 * is central to this SDK's contract, so these assert that:
 *   - toolName / toolCallId round-trip through the masked-string choke point,
 *   - toolArguments are sanitized via setIo/sanitizeUnknown when a sanitizer is
 *     configured (secrets/PII redacted before they hit the wire),
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
import { Sanitizer } from '../src/masking/sanitizer.js';
import { GEN_AI } from '../src/attributes.js';

const ROUTING = { tenantId: 't1', workspaceId: 'ws1', applicationId: 'app1' };

/** Fresh in-memory tracer + Trace (masking on) per test, to isolate exports. */
function setup(withSanitizer = true) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');
  const trace = new Trace(tracer, ROUTING, withSanitizer ? new Sanitizer() : undefined);
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
    // Object arguments are JSON-stringified after sanitization.
    assert.equal(attrs[GEN_AI.TOOL_CALL_ARGUMENTS], JSON.stringify({ query: 'weather' }));
  });

  it('sanitizes secrets/PII in structured toolArguments', () => {
    const { exporter, trace } = setup();
    trace
      .span('call', {
        observationType: 'tool',
        // Split so this fixture does not itself trip secret scanners; the
        // openai_key rule still matches the concatenated value.
        toolArguments: { email: 'john@example.com', apiKey: 'sk-' + 'A'.repeat(24) },
      })
      .end();

    const raw = toolSpan(exporter).attributes[GEN_AI.TOOL_CALL_ARGUMENTS];
    assert.equal(typeof raw, 'string');
    const args = JSON.parse(raw as string);
    assert.equal(args.email, '[EMAIL]');
    assert.equal(args.apiKey, '[SECRET]');
  });

  it('masks a secret embedded in a string toolArguments value', () => {
    const { exporter, trace } = setup();
    trace
      .span('call', {
        observationType: 'tool',
        toolArguments: 'contact john@example.com',
      })
      .end();

    // String arguments stay a string (not JSON-wrapped) after sanitization.
    assert.equal(toolSpan(exporter).attributes[GEN_AI.TOOL_CALL_ARGUMENTS], 'contact [EMAIL]');
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

  it('leaves tool attributes verbatim when masking is disabled', () => {
    const { exporter, trace } = setup(false);
    trace
      .span('call', {
        observationType: 'tool',
        toolName: 'web_search',
        toolArguments: 'contact john@example.com',
      })
      .end();

    const attrs = toolSpan(exporter).attributes;
    assert.equal(attrs[GEN_AI.TOOL_NAME], 'web_search');
    assert.equal(attrs[GEN_AI.TOOL_CALL_ARGUMENTS], 'contact john@example.com');
  });
});
