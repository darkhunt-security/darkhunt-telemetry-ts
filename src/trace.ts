import {
  context as otContext,
  trace as otTrace,
  type Context,
  type Span as OtelSpan,
  type TimeInput,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR } from './attributes.js';
import type { Sanitizer } from './masking/index.js';
import {
  applyMetadataAttrs,
  Generation,
  Span,
  type GenerationOptions,
  type SpanOptions,
} from './span.js';
import type { Metadata } from './types.js';

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

    this.rootSpan = tracer.startSpan(
      this.maskName(args.name ?? 'trace'),
      args.startTime !== undefined ? { startTime: args.startTime } : undefined
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
    this.applyTraceAttrs(this.rootSpan);
    return this;
  }

  end(endTime?: TimeInput): void {
    this.rootSpan.end(endTime);
  }

  private applyTraceAttrs(span: OtelSpan): void {
    span.setAttribute(ATTR.OBSERVATION_TYPE, 'attack');
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
  }
}
