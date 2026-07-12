// Carry a Darkhunt handoff token across a QUEUE boundary in the message's
// out-of-band metadata — Kafka record headers, SQS message attributes, a Redis
// Stream field, etc. — keeping the token OUT of the business payload so the
// downstream consumer's message schema is untouched.
//
// Producing side: attach the token with {@link handoffToMessageMeta} onto the
// transport's header/attribute map. Consuming side: read it back with
// {@link handoffFromMessageMeta}, or — for a fan-in worker draining several
// upstream messages into one downstream trace — collect the tokens from all of
// them with {@link handoffsFromMessages} and pass the array straight to
// `client.trace({ handoffFrom: tokens })`.
//
// Dependency-free: the only import is a type (erased at compile time).

import type { HandoffToken } from '../trace.js';

/**
 * Stable, namespaced metadata key the handoff token travels under. Lower-case and
 * limited to `[a-z0-9-]` so it is a legal key across Kafka header names, SQS
 * message-attribute names, and Redis Stream field names alike.
 */
export const HANDOFF_MESSAGE_META_KEY = 'darkhunt-handoff';

/**
 * A queue message's metadata value as seen on the consuming side. Transports
 * hand these back in different shapes — a plain string, raw bytes (Kafka header
 * buffers), or an object wrapper (SQS `{ StringValue }`) — so the readers below
 * accept them all and coerce to a string.
 */
export type MessageMetaValue = string | Uint8Array | { StringValue?: string } | null | undefined;

/** A queue message's metadata map (Kafka `headers`, SQS `MessageAttributes`, …). */
export type MessageMeta = Record<string, MessageMetaValue>;

/** Best-effort coercion of a transport-specific metadata value to a string. */
function metaValueToString(value: MessageMetaValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (value instanceof Uint8Array) {
    const s = new TextDecoder().decode(value);
    return s || undefined;
  }
  // SQS-style `{ DataType: 'String', StringValue: '...' }` attribute wrapper.
  const sv = value.StringValue;
  return typeof sv === 'string' && sv ? sv : undefined;
}

/** Case-insensitive lookup of the handoff key in a metadata map. */
function readHandoffKey(meta: MessageMeta): MessageMetaValue {
  const direct = meta[HANDOFF_MESSAGE_META_KEY];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(meta)) {
    if (key.toLowerCase() === HANDOFF_MESSAGE_META_KEY) return value;
  }
  return undefined;
}

/**
 * Merge a handoff token onto a message's metadata under {@link HANDOFF_MESSAGE_META_KEY},
 * returning a new metadata object (the input, if any, is not mutated). The value is a
 * plain string — Kafka accepts string header values directly; for SQS wrap it as
 * `{ DataType: 'String', StringValue: meta[HANDOFF_MESSAGE_META_KEY] }` at publish time.
 */
export function handoffToMessageMeta(
  token: HandoffToken,
  meta?: Record<string, string>
): Record<string, string> {
  return { ...meta, [HANDOFF_MESSAGE_META_KEY]: token };
}

/**
 * Read a single handoff token back out of one message's metadata. Returns
 * `undefined` when the key is absent or empty. Feed the result to
 * `client.trace({ handoffFrom: [token] })` to nest under the producing agent.
 */
export function handoffFromMessageMeta(meta: MessageMeta | undefined): HandoffToken | undefined {
  if (!meta) return undefined;
  return metaValueToString(readHandoffKey(meta));
}

/**
 * Fan-in variant: collect the handoff tokens from several upstream messages'
 * metadata (skipping any without one), preserving order and de-duplicating.
 * Pass the result straight to `client.trace({ handoffFrom: tokens })` so a worker
 * draining a batch records a handoff link back to every producer that fed it.
 */
export function handoffsFromMessages(metas: Array<MessageMeta | undefined>): HandoffToken[] {
  const seen = new Set<HandoffToken>();
  for (const meta of metas) {
    const token = handoffFromMessageMeta(meta);
    if (token) seen.add(token);
  }
  return [...seen];
}
