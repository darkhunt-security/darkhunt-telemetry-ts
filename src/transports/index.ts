// Official, dependency-free transport helpers for carrying a Darkhunt handoff
// token across a service boundary — so consuming apps stop re-implementing the
// "carry the token across the wire" glue by hand. HTTP uses the standard W3C
// `traceparent` header; queue transports use out-of-band message metadata that
// keeps the token out of the business payload. Both are importable without any
// Temporal packages installed (see `@darkhunt-security/telemetry/temporal` for
// the optional Temporal interceptors).

export {
  TRACEPARENT_HEADER,
  handoffToHttpHeaders,
  handoffFromHttpHeaders,
  type HttpHeadersLike,
} from './http.js';
export {
  HANDOFF_MESSAGE_META_KEY,
  handoffToMessageMeta,
  handoffFromMessageMeta,
  handoffsFromMessages,
  type MessageMeta,
  type MessageMetaValue,
} from './queue.js';
