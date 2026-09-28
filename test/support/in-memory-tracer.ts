/** Shared by tests that inspect exported spans: an in-memory tracer and a lookup by name. */

import assert from 'node:assert/strict';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

export const ROUTING = { tenantId: 't1', workspaceId: 'ws1', applicationId: 'app1' };

export function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, tracer: provider.getTracer('test') };
}

export function spanByName(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  assert.ok(span, `expected an exported span named "${name}"`);
  return span;
}
