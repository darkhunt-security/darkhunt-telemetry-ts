export { DarkhuntTelemetry, type DarkhuntTelemetryOptions, type MaskingOptions } from './client.js';
export { registerOtelContextGlobals } from './otel-globals.js';
export { Sanitizer, type CustomPattern } from './masking/index.js';
export { Trace, type TraceArgs, type TraceUpdateArgs, type HandoffToken } from './trace.js';
export {
  Span,
  Generation,
  type ChatMessage,
  type SpanOptions,
  type SpanUpdateOptions,
  type SpanEndOptions,
  type GenerationOptions,
  type GenerationUpdateOptions,
  type GenerationEndOptions,
} from './span.js';
export type { ObservationType, ObservationLevel, Usage, Cost, Metadata } from './types.js';
// Dependency-free transport helpers for carrying a handoff token across a service
// boundary (HTTP `traceparent` header / queue message metadata). Also available at
// the `./transports` subpath. The optional Temporal interceptors live at the
// separate `./temporal` subpath and are intentionally NOT re-exported here, so the
// core entry loads with zero Temporal packages installed.
export {
  TRACEPARENT_HEADER,
  handoffToHttpHeaders,
  handoffFromHttpHeaders,
  type HttpHeadersLike,
  HANDOFF_MESSAGE_META_KEY,
  handoffToMessageMeta,
  handoffFromMessageMeta,
  handoffsFromMessages,
  type MessageMeta,
  type MessageMetaValue,
} from './transports/index.js';
