/**
 * Trace tags, release, environment and metadata reach every span, not only the
 * root. The root ends after its children, so it is usually exported in a later
 * batch, and a root-only value never reaches the children on the backend.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ATTR } from '../src/attributes.js';
import { Trace } from '../src/trace.js';
import { ROUTING, setup, spanByName } from './support/in-memory-tracer.js';

describe('trace context on child spans', () => {
  it('copies tags, release, environment and metadata onto every span', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, {
      ...ROUTING,
      name: 'draft',
      tags: ['sales', 'outbound'],
      release: 'guidance-v7',
      environment: 'production',
      metadata: { run_id: 'r-1', shared: 'trace' },
    });
    const step = trace.span('step', { metadata: { shared: 'span' } });
    const answer = step.generation('answer', { model: 'claude-sonnet-5' });
    answer.end();
    step.end();
    trace.end();

    for (const name of ['step', 'answer']) {
      const attrs = spanByName(exporter, name).attributes;
      assert.equal(attrs[ATTR.TRACE_TAGS], 'sales,outbound');
      assert.equal(attrs[ATTR.RELEASE], 'guidance-v7');
      assert.equal(attrs[ATTR.ENVIRONMENT], 'production');
      assert.equal(attrs[`${ATTR.METADATA_PREFIX}run_id`], 'r-1');
    }
    // The span's own metadata wins on a shared key.
    assert.equal(spanByName(exporter, 'step').attributes[`${ATTR.METADATA_PREFIX}shared`], 'span');
    assert.equal(
      spanByName(exporter, 'answer').attributes[`${ATTR.METADATA_PREFIX}shared`],
      'trace'
    );
  });

  it('adds nothing when the trace sets none of them', () => {
    const { exporter, tracer } = setup();
    const trace = new Trace(tracer, { ...ROUTING, name: 'bare' });
    trace.span('step').end();
    trace.end();

    const attrs = spanByName(exporter, 'step').attributes;
    for (const key of [ATTR.TRACE_TAGS, ATTR.RELEASE, ATTR.ENVIRONMENT]) {
      assert.equal(attrs[key], undefined);
    }
    assert.ok(!Object.keys(attrs).some((k) => k.startsWith(ATTR.METADATA_PREFIX)));
  });
});
