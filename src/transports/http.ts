// Carry a Darkhunt handoff token across an HTTP boundary in the standard W3C
// `traceparent` request header. A {@link HandoffToken} already IS a `traceparent`
// string, so these helpers are thin — their job is to name the intent and
// centralize the header convention so every consuming app stops re-deriving it.
//
// Producing side (caller): merge the token onto the outbound request headers with
// {@link handoffToHttpHeaders}. Consuming side (callee): read it back with
// {@link handoffFromHttpHeaders} and pass it to `client.trace({ handoffFrom: [token] })`.
//
// Dependency-free: the only import is a type (erased at compile time), so this
// module is safe to load without any OTel runtime.

import type { HandoffToken } from '../trace.js';

/** The standard W3C Trace Context header the handoff token travels in. */
export const TRACEPARENT_HEADER = 'traceparent';

/**
 * A read-only view over inbound HTTP headers. Accepts either a plain object
 * (Node's `req.headers`, a fetch `HeadersInit` record) — where a value may be a
 * string, a repeated-header array, or missing — or a WHATWG {@link Headers}
 * instance (its own `.get` is already case-insensitive).
 */
export type HttpHeadersLike =
  Record<string, string | string[] | undefined> | { get(name: string): string | null };

function hasGet(headers: HttpHeadersLike): headers is { get(name: string): string | null } {
  return typeof (headers as { get?: unknown }).get === 'function';
}

/**
 * Merge a handoff token onto outbound request headers as `traceparent`, returning
 * a new headers object (the input, if any, is not mutated). Pass the callee's
 * result — `req.headers` / a fetch `HeadersInit` record — as `headers` to preserve
 * existing entries.
 *
 * @example
 *   await fetch(url, { headers: handoffToHttpHeaders(trace.handoffToken(), baseHeaders) });
 */
export function handoffToHttpHeaders(
  token: HandoffToken,
  headers?: Record<string, string>
): Record<string, string> {
  return { ...(headers ?? {}), [TRACEPARENT_HEADER]: token };
}

/**
 * Read a handoff token back out of inbound request headers — a case-insensitive
 * lookup of `traceparent`. Returns `undefined` when the header is absent or empty.
 * A repeated header (array value) resolves to its first entry. Feed the result to
 * `client.trace({ handoffFrom: [token] })` to nest this agent's trace under its caller.
 */
export function handoffFromHttpHeaders(headers: HttpHeadersLike): HandoffToken | undefined {
  if (hasGet(headers)) {
    return headers.get(TRACEPARENT_HEADER) ?? undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== TRACEPARENT_HEADER) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    return raw ? raw : undefined;
  }
  return undefined;
}
