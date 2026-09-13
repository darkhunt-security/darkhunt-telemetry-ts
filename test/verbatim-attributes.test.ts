/**
 * The SDK writes caller-supplied content to span attributes unchanged — names,
 * tags, metadata, inputs/outputs, chat messages, system instructions and status
 * messages. PII masking happens server-side in the Darkhunt platform on ingest,
 * so nothing here should be rewritten on the client.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

import { ATTR, GEN_AI } from '../src/attributes.js';
import { safeJsonStringify } from '../src/span.js';
import { Trace } from '../src/trace.js';

const ROUTING = { tenantId: 't1', workspaceId: 'ws1', applicationId: 'app1' };
const EMAIL = 'john@example.com';

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

describe('attributes are emitted verbatim', () => {
  it('trace root: name, tags, metadata, input and output', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, {
      ...ROUTING,
      name: `run for ${EMAIL}`,
      tags: [EMAIL, 'beta'],
      metadata: { [EMAIL]: EMAIL, account: 4111111111111111 },
      input: `question from ${EMAIL}`,
    });
    trace.update({ output: { answer: EMAIL } });
    trace.end();

    const attrs = spanByName(exporter, `run for ${EMAIL}`).attributes;
    assert.equal(attrs[ATTR.TRACE_NAME], `run for ${EMAIL}`);
    assert.equal(attrs[ATTR.TRACE_TAGS], `${EMAIL},beta`);
    assert.equal(attrs[`${ATTR.METADATA_PREFIX}${EMAIL}`], EMAIL);
    assert.equal(attrs[`${ATTR.METADATA_PREFIX}account`], 4111111111111111);
    assert.equal(attrs[ATTR.OBSERVATION_INPUT], `question from ${EMAIL}`);
    assert.equal(attrs[ATTR.OBSERVATION_OUTPUT], JSON.stringify({ answer: EMAIL }));
  });

  it('span and generation: messages, system instructions, parameters and status', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: EMAIL });
    const input = [{ role: 'user', content: `mail ${EMAIL}` }];
    const output = [{ role: 'assistant', content: `sent to ${EMAIL}` }];

    const gen = trace.generation(`llm ${EMAIL}`, {
      model: 'gpt-4o',
      modelParameters: { user: EMAIL },
      promptName: EMAIL,
      version: EMAIL,
    });
    gen.update({ inputMessages: input, systemInstructions: `never email ${EMAIL}` });
    gen.end({ outputMessages: output, level: 'ERROR', statusMessage: `bounced ${EMAIL}` });

    const s = spanByName(exporter, `llm ${EMAIL}`);
    const attrs = s.attributes;
    assert.equal(attrs[ATTR.TRACE_NAME], EMAIL);
    assert.equal(attrs[GEN_AI.INPUT_MESSAGES], JSON.stringify(input));
    assert.equal(attrs[GEN_AI.OUTPUT_MESSAGES], JSON.stringify(output));
    assert.equal(attrs[GEN_AI.SYSTEM_INSTRUCTIONS], `never email ${EMAIL}`);
    assert.equal(attrs[ATTR.MODEL_PARAMETERS], JSON.stringify({ user: EMAIL }));
    assert.equal(attrs[ATTR.PROMPT_NAME], EMAIL);
    assert.equal(attrs[ATTR.VERSION], EMAIL);
    assert.equal(attrs[ATTR.STATUS_MESSAGE], `bounced ${EMAIL}`);
    assert.equal(s.status.code, SpanStatusCode.ERROR);
    assert.equal(s.status.message, `bounced ${EMAIL}`);
  });

  it('span renamed via update() keeps the new name as given', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, ROUTING);
    trace
      .span('placeholder')
      .update({ name: `for ${EMAIL}` })
      .end();
    spanByName(exporter, `for ${EMAIL}`);
  });
});

describe('safeJsonStringify', () => {
  it('converts BigInt to a string', () => {
    assert.equal(safeJsonStringify({ n: 10n }), '{"n":"10"}');
  });

  it('replaces a circular reference and keeps the rest of the value', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    assert.equal(safeJsonStringify(value), '{"a":1,"self":"[circular]"}');
  });

  it('serializes a shared, non-circular reference each time it appears', () => {
    const shared = { x: 1 };
    assert.equal(safeJsonStringify({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
  });
});
