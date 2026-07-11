import {
  ROOT_CONTEXT,
  context as otContext,
  propagation,
  trace as otTrace,
  type Context,
  type Span as OtelSpan,
  type SpanOptions as OtelSpanOptions,
  type TimeInput,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR } from './attributes.js';
import type { Sanitizer } from './masking/index.js';
import {
  applyMetadataAttrs,
  Generation,
  safeJsonStringify,
  Span,
  spanContextToToken,
  toOtelLinks,
  type GenerationOptions,
  type SpanOptions,
} from './span.js';
import type { Metadata, ObservationType } from './types.js';

/**
 * Opaque, serializable handle to an agent's entry (root) span — a W3C `traceparent`
 * under the hood. Produce one with {@link Trace.handoffToken} and pass it to a
 * downstream agent's {@link TraceArgs.handoffFrom} to record the A→B handoff.
 */
export type HandoffToken = string;

/** Parse a {@link HandoffToken} back into an OTel context carrying its span context —
 *  via the global propagator (`propagation.extract`), symmetric with the inject on the
 *  producing side. Falls back to direct parsing only if no global propagator is set. */
function tokenToContext(token: HandoffToken): Context | undefined {
  const ctx = propagation.extract(ROOT_CONTEXT, { traceparent: token });
  const sc = otTrace.getSpanContext(ctx);
  if (sc?.traceId && sc?.spanId) return ctx;
  const parts = token.split('-');
  if (parts.length < 4) return undefined;
  const [, traceId, spanId, flags] = parts;
  if (!traceId || !spanId) return undefined;
  return otTrace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags ?? '01', 16) || 1,
    isRemote: true,
  });
}

/** Normalize `handoffFrom` entries (tokens or contexts) into OTel contexts. */
function toHandoffContexts(handoffFrom?: Array<HandoffToken | Context>): Context[] {
  if (!handoffFrom?.length) return [];
  const out: Context[] = [];
  for (const h of handoffFrom) {
    const ctx = typeof h === 'string' ? tokenToContext(h) : h;
    if (ctx) out.push(ctx);
  }
  return out;
}

export interface TraceArgs {
  name?: string;
  /**
   * Routing fields. Required for spans to actually be routed and ingested.
   * Optional here because {@link DarkhuntTelemetry.trace} merges in defaults
   * from the {@code DarkhuntTelemetry} constructor / environment before
   * constructing the trace, and throws if any field is still missing after
   * the merge. If you construct {@link Trace} directly without going through
   * the client, the exporter will drop spans that lack these.
   */
  tenantId?: string;
  workspaceId?: string;
  applicationId?: string;
  assessmentRunId?: string;
  /**
   * Routing identifiers. **Not run through the masking sanitizer** — they are
   * sent verbatim because the dashboard groups, filters, and de-duplicates by
   * exact match. Do not put free-form text or user-controlled content (chat
   * input, prompts, query strings) here; anything you pass will round-trip
   * unmodified to the trace-hub. For PII-bearing identifiers, hash on the
   * caller side first.
   */
  sessionId?: string;
  /** See {@link TraceArgs.sessionId} — not masked, sent verbatim. */
  userId?: string;
  /** See {@link TraceArgs.sessionId} — not masked, sent verbatim. */
  userEmail?: string;
  tags?: string[];
  metadata?: Metadata;
  release?: string;
  environment?: string;
  /**
   * OTel span links on the trace **root span** — the upstream agents that handed
   * off to this one (multi-agent DAG). Pass each upstream span's `.context`, or a
   * remote context extracted from its `traceparent`. Supports fan-in.
   */
  links?: Context[];
  /**
   * Upstream agents that handed off to this one — the ergonomic front door for
   * multi-agent handoff links. Accepts each upstream's {@link Trace.handoffToken}
   * (a serializable string) or a raw {@link Context}; both become `agent_handoff`
   * span links on the root span. Supports fan-in. Sugar over {@link TraceArgs.links}.
   */
  handoffFrom?: Array<HandoffToken | Context>;
  /**
   * Observation type of the trace **root span**. Defaults to `'agent'` — the
   * root represents the agent/service turn this trace covers. Pass `'attack'`
   * for red-team traces. (Previously this was hardcoded to `'attack'`.)
   */
  observationType?: ObservationType;
  /**
   * Input the trace represents — e.g. the task/request the agent received.
   * Masked and emitted as `darkhunt.observation.input`, so the root span carries
   * real content instead of being an empty container (which lets the backend
   * keep it and surfaces it in the timeline). Set the result via `output`,
   * {@link Trace.update}, or leave it and set it at the end.
   */
  input?: unknown;
  /** Output the trace produced — the agent's result. Masked; emitted as
   *  `darkhunt.observation.output`. Can also be set later via {@link Trace.update}. */
  output?: unknown;
  /**
   * Backdated trace start. Pass the wall-clock start of the work the trace
   * represents (typically `Date.now()` captured before any awaited LLM call)
   * when the trace is opened *after* the work has already begun. Without it,
   * the recorded duration covers only the bookkeeping.
   */
  startTime?: TimeInput;
}

export interface TraceUpdateArgs {
  name?: string;
  tenantId?: string;
  workspaceId?: string;
  applicationId?: string;
  assessmentRunId?: string;
  /** See {@link TraceArgs.sessionId} — not masked, sent verbatim. */
  sessionId?: string;
  /** See {@link TraceArgs.sessionId} — not masked, sent verbatim. */
  userId?: string;
  /** See {@link TraceArgs.sessionId} — not masked, sent verbatim. */
  userEmail?: string;
  tags?: string[];
  metadata?: Metadata;
  release?: string;
  environment?: string;
  observationType?: ObservationType;
  /** Output the trace produced. Masked; emitted as `darkhunt.observation.output`. */
  output?: unknown;
}

export class Trace {
  private readonly tracer: Tracer;
  private readonly rootSpan: OtelSpan;
  private readonly rootContext: Context;
  private readonly _sanitizer?: Sanitizer;
  private _name?: string;
  private _tenantId: string;
  private _workspaceId: string;
  private _applicationId: string;
  private _assessmentRunId: string;
  private _sessionId?: string;
  private _userId?: string;
  private _userEmail?: string;
  private _tags?: string[];
  private _metadata?: Metadata;
  private _release?: string;
  private _environment?: string;
  private _observationType: ObservationType;
  private _input?: unknown;
  private _output?: unknown;

  constructor(tracer: Tracer, args: TraceArgs, sanitizer?: Sanitizer) {
    this.tracer = tracer;
    this._sanitizer = sanitizer;
    this._name = args.name;
    // Routing fields are validated upstream by DarkhuntTelemetry.trace(). Direct
    // Trace construction without them will silent-drop at the exporter (which
    // warns about missing routing attributes).
    this._tenantId = args.tenantId ?? '';
    this._workspaceId = args.workspaceId ?? '';
    this._applicationId = args.applicationId ?? '';
    this._assessmentRunId = args.assessmentRunId ?? '';
    this._sessionId = args.sessionId;
    this._userId = args.userId;
    this._userEmail = args.userEmail;
    this._tags = args.tags;
    this._metadata = args.metadata;
    this._release = args.release;
    this._environment = args.environment;
    this._observationType = args.observationType ?? 'agent';
    this._input = args.input;
    this._output = args.output;

    const rootOptions: OtelSpanOptions = {};
    if (args.startTime !== undefined) rootOptions.startTime = args.startTime;
    const rootLinks = toOtelLinks([...(args.links ?? []), ...toHandoffContexts(args.handoffFrom)]);
    if (rootLinks.length > 0) rootOptions.links = rootLinks;
    this.rootSpan = tracer.startSpan(
      this.maskName(args.name ?? 'trace'),
      Object.keys(rootOptions).length > 0 ? rootOptions : undefined
    );
    this.rootContext = otTrace.setSpan(otContext.active(), this.rootSpan);
    this.applyTraceAttrs(this.rootSpan);
  }

  /**
   * Sanitize a span/trace name. Names land on the wire verbatim via
   * `tracer.startSpan(name)`, so user-controlled values can leak; identifying
   * fields like `userId` / `model` are intentionally not masked, names are.
   */
  maskName(name: string): string {
    return this._sanitizer ? this._sanitizer.sanitize(name) : name;
  }

  get name(): string | undefined {
    return this._name;
  }
  /** OTel context of the trace's root span — inject as a `traceparent` to let a
   *  downstream agent link back to this one (a handoff edge). The root span is
   *  always exported, so the link target is guaranteed resolvable. */
  get context(): Context {
    return this.rootContext;
  }
  /**
   * A serializable {@link HandoffToken} for this agent's entry span. Pass it to a
   * downstream agent's {@link TraceArgs.handoffFrom} to record the handoff as an
   * `agent_handoff` span link. The root span is always exported, so it resolves.
   */
  handoffToken(): HandoffToken {
    return spanContextToToken(otTrace.getSpanContext(this.rootContext));
  }
  get tenantId(): string {
    return this._tenantId;
  }
  get workspaceId(): string {
    return this._workspaceId;
  }
  get applicationId(): string {
    return this._applicationId;
  }
  get assessmentRunId(): string {
    return this._assessmentRunId;
  }
  get sessionId(): string | undefined {
    return this._sessionId;
  }
  get userId(): string | undefined {
    return this._userId;
  }
  get userEmail(): string | undefined {
    return this._userEmail;
  }
  /** Shared sanitizer applied at the Span choke points; undefined when masking is disabled. */
  get sanitizer(): Sanitizer | undefined {
    return this._sanitizer;
  }

  span(name: string, options?: SpanOptions): Span {
    return new Span({
      tracer: this.tracer,
      trace: this,
      name,
      parentContext: this.rootContext,
      options,
    });
  }

  generation(name: string, options?: GenerationOptions): Generation {
    return new Generation({
      tracer: this.tracer,
      trace: this,
      name,
      parentContext: this.rootContext,
      options,
    });
  }

  event(name: string, options?: SpanOptions): void {
    const ev = new Span({
      tracer: this.tracer,
      trace: this,
      name,
      parentContext: this.rootContext,
      options: { ...options, observationType: 'event' },
    });
    ev.end();
  }

  update(args: TraceUpdateArgs): this {
    if (args.name !== undefined) this._name = args.name;
    if (args.tenantId !== undefined) this._tenantId = args.tenantId;
    if (args.workspaceId !== undefined) this._workspaceId = args.workspaceId;
    if (args.applicationId !== undefined) this._applicationId = args.applicationId;
    if (args.assessmentRunId !== undefined) this._assessmentRunId = args.assessmentRunId;
    if (args.sessionId !== undefined) this._sessionId = args.sessionId;
    if (args.userId !== undefined) this._userId = args.userId;
    if (args.userEmail !== undefined) this._userEmail = args.userEmail;
    if (args.tags !== undefined) this._tags = args.tags;
    if (args.metadata !== undefined) this._metadata = args.metadata;
    if (args.release !== undefined) this._release = args.release;
    if (args.environment !== undefined) this._environment = args.environment;
    if (args.observationType !== undefined) this._observationType = args.observationType;
    if (args.output !== undefined) this._output = args.output;
    this.applyTraceAttrs(this.rootSpan);
    return this;
  }

  end(endTime?: TimeInput): void {
    this.rootSpan.end(endTime);
  }

  /** Mask + emit an input/output attribute on the root span (mirrors Span.setIo). */
  private setIo(span: OtelSpan, key: string, value: unknown): void {
    if (value === null || value === undefined) return;
    const sanitized = this._sanitizer ? this._sanitizer.sanitizeUnknown(value) : value;
    span.setAttribute(
      key,
      typeof sanitized === 'string' ? sanitized : safeJsonStringify(sanitized)
    );
  }

  private applyTraceAttrs(span: OtelSpan): void {
    span.setAttribute(ATTR.OBSERVATION_TYPE, this._observationType);
    span.setAttribute(ATTR.TENANT_ID, this._tenantId);
    span.setAttribute(ATTR.WORKSPACE_ID, this._workspaceId);
    span.setAttribute(ATTR.APPLICATION_ID, this._applicationId);
    span.setAttribute(ATTR.ASSESSMENT_RUN_ID, this._assessmentRunId);
    if (this._name) span.setAttribute(ATTR.TRACE_NAME, this.maskName(this._name));
    if (this._sessionId) span.setAttribute(ATTR.SESSION_ID, this._sessionId);
    if (this._userId) span.setAttribute(ATTR.USER_ID, this._userId);
    if (this._userEmail) span.setAttribute(ATTR.USER_EMAIL, this._userEmail);
    if (this._tags && this._tags.length > 0) {
      const sanitizer = this._sanitizer;
      const tags = sanitizer ? this._tags.map((t) => sanitizer.sanitize(t)) : this._tags;
      span.setAttribute(ATTR.TRACE_TAGS, tags.join(','));
    }
    if (this._release) span.setAttribute(ATTR.RELEASE, this._release);
    if (this._environment) span.setAttribute(ATTR.ENVIRONMENT, this._environment);
    if (this._metadata) applyMetadataAttrs(span, this._metadata, this._sanitizer);
    this.setIo(span, ATTR.OBSERVATION_INPUT, this._input);
    this.setIo(span, ATTR.OBSERVATION_OUTPUT, this._output);
  }
}
