/**
 * Tests for the dependency-free transport helpers that carry a handoff token
 * across a service boundary. The token IS a W3C `traceparent`, so the helpers are
 * thin — these assert the round-trips hold and the reads are liberal about the
 * shapes real transports hand back:
 *   - HTTP: token → headers → token, case-insensitive read, WHATWG Headers,
 *     repeated-header arrays, missing header → undefined, non-mutating merge.
 *   - Queue: token → meta → token under the namespaced key, bytes/SQS-wrapper
 *     value coercion, and the fan-in array (order-preserving, de-duplicating).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TRACEPARENT_HEADER,
  handoffToHttpHeaders,
  handoffFromHttpHeaders,
  HANDOFF_MESSAGE_META_KEY,
  handoffToMessageMeta,
  handoffFromMessageMeta,
  handoffsFromMessages,
} from '../src/transports/index.js';

const TOKEN = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const TOKEN2 = '00-1111111111111111111111111111aaaa-2222222222bbbb33-01';

describe('HTTP transport helpers', () => {
  it('round-trips a token through traceparent headers', () => {
    const headers = handoffToHttpHeaders(TOKEN);
    assert.equal(headers[TRACEPARENT_HEADER], TOKEN);
    assert.equal(handoffFromHttpHeaders(headers), TOKEN);
  });

  it('merges onto existing headers without mutating the input', () => {
    const base = { authorization: 'Bearer x' };
    const merged = handoffToHttpHeaders(TOKEN, base);
    assert.deepEqual(base, { authorization: 'Bearer x' }, 'input must not be mutated');
    assert.equal(merged.authorization, 'Bearer x');
    assert.equal(merged[TRACEPARENT_HEADER], TOKEN);
  });

  it('reads case-insensitively (Node lower-cases, some proxies do not)', () => {
    assert.equal(handoffFromHttpHeaders({ TraceParent: TOKEN }), TOKEN);
    assert.equal(handoffFromHttpHeaders({ TRACEPARENT: TOKEN }), TOKEN);
  });

  it('reads from a WHATWG Headers instance (its .get is case-insensitive)', () => {
    const h = new Headers();
    h.set('traceparent', TOKEN);
    assert.equal(handoffFromHttpHeaders(h), TOKEN);
  });

  it('takes the first value of a repeated (array) header', () => {
    assert.equal(handoffFromHttpHeaders({ traceparent: [TOKEN, TOKEN2] }), TOKEN);
  });

  it('returns undefined when the header is absent or empty', () => {
    assert.equal(handoffFromHttpHeaders({}), undefined);
    assert.equal(handoffFromHttpHeaders({ authorization: 'Bearer x' }), undefined);
    assert.equal(handoffFromHttpHeaders({ traceparent: '' }), undefined);
    assert.equal(handoffFromHttpHeaders(new Headers()), undefined);
  });
});

describe('Queue transport helpers', () => {
  it('round-trips a token through message metadata under the namespaced key', () => {
    const meta = handoffToMessageMeta(TOKEN);
    assert.equal(meta[HANDOFF_MESSAGE_META_KEY], TOKEN);
    assert.equal(handoffFromMessageMeta(meta), TOKEN);
  });

  it('merges onto existing metadata without mutating the input', () => {
    const base = { 'content-type': 'application/json' };
    const merged = handoffToMessageMeta(TOKEN, base);
    assert.deepEqual(base, { 'content-type': 'application/json' });
    assert.equal(merged['content-type'], 'application/json');
    assert.equal(merged[HANDOFF_MESSAGE_META_KEY], TOKEN);
  });

  it('coerces a bytes value (Kafka header buffer) back to a string', () => {
    const meta = { [HANDOFF_MESSAGE_META_KEY]: new TextEncoder().encode(TOKEN) };
    assert.equal(handoffFromMessageMeta(meta), TOKEN);
  });

  it('coerces an SQS-style { StringValue } attribute wrapper', () => {
    const meta = { [HANDOFF_MESSAGE_META_KEY]: { DataType: 'String', StringValue: TOKEN } };
    assert.equal(handoffFromMessageMeta(meta), TOKEN);
  });

  it('reads the key case-insensitively', () => {
    assert.equal(handoffFromMessageMeta({ 'Darkhunt-Handoff': TOKEN }), TOKEN);
  });

  it('returns undefined for missing / empty / undefined metadata', () => {
    assert.equal(handoffFromMessageMeta(undefined), undefined);
    assert.equal(handoffFromMessageMeta({}), undefined);
    assert.equal(handoffFromMessageMeta({ other: 'x' }), undefined);
    assert.equal(handoffFromMessageMeta({ [HANDOFF_MESSAGE_META_KEY]: '' }), undefined);
  });

  it('fan-in: collects tokens across messages, order-preserving + de-duplicated', () => {
    const metas = [
      handoffToMessageMeta(TOKEN),
      { other: 'no-handoff-here' },
      undefined,
      handoffToMessageMeta(TOKEN2),
      handoffToMessageMeta(TOKEN), // duplicate of the first
    ];
    assert.deepEqual(handoffsFromMessages(metas), [TOKEN, TOKEN2]);
  });

  it('fan-in: empty input → empty array', () => {
    assert.deepEqual(handoffsFromMessages([]), []);
    assert.deepEqual(handoffsFromMessages([undefined, {}]), []);
  });
});
