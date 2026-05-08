import {
  diag,
  context as otContext,
  trace as otTrace,
  SpanStatusCode,
  type Context,
  type Span as OtelSpan,
  type TimeInput,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR, GEN_AI } from './attributes.js';
import type { Sanitizer } from './masking/index.js';
import type { Trace } from './trace.js';
import type { Cost, Metadata, ObservationLevel, ObservationType, Usage } from './types.js';

/**
 * Serialize a value to JSON without crashing the caller on unserializable
 * types. Converts BigInt to string (the closest JSON has). Falls back to a
 * placeholder string with a deduped diag warning on any other throw — this
 * catches circular refs that slipped past Sanitizer's WeakSet (e.g. when
 * masking is disabled), unsupported types, or replacer-time errors.
 */
export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (err) {
    diag.warn('darkhunt-telemetry: failed to JSON.stringify value', err);
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

export function applyMetadataAttrs(
  span: OtelSpan,
  metadata: Metadata,
  sanitizer?: Sanitizer
): void {
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined || v === null) continue;
    // Sanitize the user-supplied key too — it ends up as part of the OTel
    // attribute name on the wire, so an email-as-key would leak otherwise.
    const safeKey = sanitizer ? sanitizer.sanitize(k) : k;
    const key = `${ATTR.METADATA_PREFIX}${safeKey}`;
    const value = sanitizer ? sanitizer.sanitizeUnknown(v) : v;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      span.setAttribute(key, value);
    } else {
      span.setAttribute(key, safeJsonStringify(value));
    }
  }
}

export interface SpanOptions {
  input?: unknown;
  output?: unknown;
  metadata?: Metadata;
  level?: ObservationLevel;
  statusMessage?: string;
  version?: string;
  observationType?: ObservationType;
  /**
   * Backdated span start. Use this when the span is opened *after* the work
   * it represents has already started — pass the wall-clock start of the
   * work (e.g. `Date.now()` captured before the await). Without it, the OTel
   * span starts at construction time and the recorded duration covers only
   * the bookkeeping, not the work.
   */
  startTime?: TimeInput;
}

/**
 * A single chat-style message: `{role: "user"|"assistant"|..., content: "..."}`.
 * Used for the OTel GenAI semantic-convention attributes
 * `gen_ai.input.messages` and `gen_ai.output.messages`. The receiving backend
 * (Darkhunt trace-hub or any OTLP-compatible consumer) typically renders
 * these as a structured conversation in its dashboard.
 */
export interface ChatMessage {
  role: string;
  content: string;
  [extra: string]: unknown;
}

export interface SpanUpdateOptions {
  name?: string;
  input?: unknown;
  output?: unknown;
  /**
   * Structured chat input — sets `gen_ai.input.messages` (JSON-encoded array).
   * Prefer this over `input` for LLM call spans so the dashboard can render
   * each role in its own bubble.
   */
  inputMessages?: ChatMessage[];
  /** Structured chat output — sets `gen_ai.output.messages` (JSON-encoded array). */
  outputMessages?: ChatMessage[];
  /**
   * System prompt for the LLM call — sets `gen_ai.system_instructions`.
   * Captured separately from `inputMessages` so it doesn't pollute the user
   * conversation flow in the dashboard.
   */
  systemInstructions?: string;
  metadata?: Metadata;
  level?: ObservationLevel;
  statusMessage?: string;
  version?: string;
}

export interface SpanEndOptions {
  output?: unknown;
  /** See {@link SpanUpdateOptions.outputMessages}. */
  outputMessages?: ChatMessage[];
  statusMessage?: string;
  level?: ObservationLevel;
  /**
   * Explicit span end time. Defaults to "now" when omitted. Use this only
   * when ending the span well after the work finished and you want the
   * recorded end to reflect the actual finish.
   */
  endTime?: TimeInput;
}

interface SpanCtorArgs {
  tracer: Tracer;
  trace: Trace;
  name: string;
  parentContext?: Context;
  options?: SpanOptions;
}

export class Span {
  protected readonly tracer: Tracer;
  protected readonly traceRef: Trace;
  protected readonly otelSpan: OtelSpan;
  protected readonly ctx: Context;
  protected ended = false;

  constructor(args: SpanCtorArgs) {
    this.tracer = args.tracer;
    this.traceRef = args.trace;
    const parentCtx = args.parentContext ?? otContext.active();
    const opts = args.options ?? {};
    // Mask the span name — it ends up on the wire via OTel verbatim, so
    // anything user-controlled (a prompt, a request id with embedded PII)
    // would otherwise leak.
    this.otelSpan = this.tracer.startSpan(
      this.traceRef.maskName(args.name),
      opts.startTime !== undefined ? { startTime: opts.startTime } : undefined,
      parentCtx
    );
    this.ctx = otTrace.setSpan(parentCtx, this.otelSpan);

    this.otelSpan.setAttribute(ATTR.OBSERVATION_TYPE, opts.observationType ?? 'span');
    this.applyTraceAttrs();
    if (opts.input !== undefined) this.setIo(ATTR.OBSERVATION_INPUT, opts.input);
    if (opts.output !== undefined) this.setIo(ATTR.OBSERVATION_OUTPUT, opts.output);
    if (opts.metadata) applyMetadataAttrs(this.otelSpan, opts.metadata, this.traceRef.sanitizer);
    if (opts.level) this.otelSpan.setAttribute(ATTR.OBSERVATION_LEVEL, opts.level);
    if (opts.statusMessage)
      this.otelSpan.setAttribute(ATTR.STATUS_MESSAGE, this.maskString(opts.statusMessage));
    if (opts.version) this.otelSpan.setAttribute(ATTR.VERSION, this.maskString(opts.version));
  }

  get context(): Context {
    return this.ctx;
  }

  get trace(): Trace {
    return this.traceRef;
  }

  span(name: string, options?: SpanOptions): Span {
    return new Span({
      tracer: this.tracer,
      trace: this.traceRef,
      name,
      parentContext: this.ctx,
      options,
    });
  }

  generation(name: string, options?: GenerationOptions): Generation {
    return new Generation({
      tracer: this.tracer,
      trace: this.traceRef,
      name,
      parentContext: this.ctx,
      options,
    });
  }

  event(name: string, options?: SpanOptions): void {
    const ev = new Span({
      tracer: this.tracer,
      trace: this.traceRef,
      name,
      parentContext: this.ctx,
      options: { ...options, observationType: 'event' },
    });
    ev.end();
  }

  update(options: SpanUpdateOptions): this {
    if (this.ended) {
      diag.warn('darkhunt-telemetry: update() called on an already-ended span; ignored');
      return this;
    }
    if (options.name !== undefined) this.otelSpan.updateName(this.traceRef.maskName(options.name));
    if (options.input !== undefined) this.setIo(ATTR.OBSERVATION_INPUT, options.input);
    if (options.output !== undefined) this.setIo(ATTR.OBSERVATION_OUTPUT, options.output);
    const sanitizer = this.traceRef.sanitizer;
    if (options.inputMessages !== undefined) {
      const masked = sanitizer
        ? sanitizer.sanitizeUnknown(options.inputMessages)
        : options.inputMessages;
      this.otelSpan.setAttribute(GEN_AI.INPUT_MESSAGES, safeJsonStringify(masked));
    }
    if (options.outputMessages !== undefined) {
      const masked = sanitizer
        ? sanitizer.sanitizeUnknown(options.outputMessages)
        : options.outputMessages;
      this.otelSpan.setAttribute(GEN_AI.OUTPUT_MESSAGES, safeJsonStringify(masked));
    }
    if (options.systemInstructions !== undefined) {
      this.otelSpan.setAttribute(
        GEN_AI.SYSTEM_INSTRUCTIONS,
        this.maskString(options.systemInstructions)
      );
    }
    if (options.metadata) applyMetadataAttrs(this.otelSpan, options.metadata, sanitizer);
    if (options.level) this.otelSpan.setAttribute(ATTR.OBSERVATION_LEVEL, options.level);
    if (options.statusMessage)
      this.otelSpan.setAttribute(ATTR.STATUS_MESSAGE, this.maskString(options.statusMessage));
    if (options.version) this.otelSpan.setAttribute(ATTR.VERSION, this.maskString(options.version));
    return this;
  }

  end(options: SpanEndOptions = {}): void {
    if (this.ended) return;
    this.ended = true;

    if (options.output !== undefined) this.setIo(ATTR.OBSERVATION_OUTPUT, options.output);
    if (options.outputMessages !== undefined) {
      const sanitizer = this.traceRef.sanitizer;
      const masked = sanitizer
        ? sanitizer.sanitizeUnknown(options.outputMessages)
        : options.outputMessages;
      this.otelSpan.setAttribute(GEN_AI.OUTPUT_MESSAGES, safeJsonStringify(masked));
    }
    const maskedStatus = options.statusMessage ? this.maskString(options.statusMessage) : undefined;
    if (maskedStatus !== undefined) this.otelSpan.setAttribute(ATTR.STATUS_MESSAGE, maskedStatus);
    if (options.level) this.otelSpan.setAttribute(ATTR.OBSERVATION_LEVEL, options.level);

    if (options.level === 'ERROR') {
      this.otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: maskedStatus });
    } else {
      this.otelSpan.setStatus({ code: SpanStatusCode.OK });
    }

    this.otelSpan.end(options.endTime);
  }

  protected setIo(key: string, value: unknown): void {
    if (value === null || value === undefined) return;
    const sanitizer = this.traceRef.sanitizer;
    const sanitized = sanitizer ? sanitizer.sanitizeUnknown(value) : value;
    if (typeof sanitized === 'string') {
      this.otelSpan.setAttribute(key, sanitized);
    } else {
      this.otelSpan.setAttribute(key, safeJsonStringify(sanitized));
    }
  }

  protected maskString(value: string): string {
    return this.traceRef.sanitizer ? this.traceRef.sanitizer.sanitize(value) : value;
  }

  private applyTraceAttrs(): void {
    const t = this.traceRef;
    this.otelSpan.setAttribute(ATTR.TENANT_ID, t.tenantId);
    this.otelSpan.setAttribute(ATTR.WORKSPACE_ID, t.workspaceId);
    this.otelSpan.setAttribute(ATTR.APPLICATION_ID, t.applicationId);
    this.otelSpan.setAttribute(ATTR.ASSESSMENT_RUN_ID, t.assessmentRunId);
    if (t.sessionId) this.otelSpan.setAttribute(ATTR.SESSION_ID, t.sessionId);
    if (t.userId) this.otelSpan.setAttribute(ATTR.USER_ID, t.userId);
    if (t.userEmail) this.otelSpan.setAttribute(ATTR.USER_EMAIL, t.userEmail);
    // Mask the inherited trace name on every child span — t.name returns the
    // raw stored value from Trace, so child spans would otherwise leak a
    // user-supplied secret in the parent name.
    if (t.name) this.otelSpan.setAttribute(ATTR.TRACE_NAME, t.maskName(t.name));
  }
}

export interface GenerationOptions extends SpanOptions {
  model?: string;
  modelParameters?: Record<string, unknown>;
  usage?: Usage;
  cost?: Cost;
  completionStartTime?: number;
  promptName?: string;
  promptVersion?: string;
}

export interface GenerationUpdateOptions extends SpanUpdateOptions {
  model?: string;
  modelParameters?: Record<string, unknown>;
  usage?: Usage;
  cost?: Cost;
  completionStartTime?: number;
  promptName?: string;
  promptVersion?: string;
}

export interface GenerationEndOptions extends SpanEndOptions {
  model?: string;
  usage?: Usage;
  cost?: Cost;
}

interface GenerationCtorArgs {
  tracer: Tracer;
  trace: Trace;
  name: string;
  parentContext?: Context;
  options?: GenerationOptions;
}

export class Generation extends Span {
  constructor(args: GenerationCtorArgs) {
    super({
      tracer: args.tracer,
      trace: args.trace,
      name: args.name,
      parentContext: args.parentContext,
      options: { ...args.options, observationType: 'generation' },
    });

    const opts = args.options ?? {};
    const sanitizer = this.traceRef.sanitizer;
    if (opts.model) this.setModel(opts.model);
    if (opts.modelParameters) {
      // Walk modelParameters through the sanitizer first — operators sometimes
      // tuck provider keys or webhook URLs in here for custom backends.
      const masked = sanitizer ? sanitizer.sanitizeUnknown(opts.modelParameters) : opts.modelParameters;
      this.otelSpan.setAttribute(ATTR.MODEL_PARAMETERS, safeJsonStringify(masked));
    }
    if (opts.usage) this.setUsage(opts.usage);
    if (opts.cost) this.setCost(opts.cost);
    if (opts.completionStartTime !== undefined) {
      this.otelSpan.setAttribute(
        ATTR.COMPLETION_START_TIME,
        Math.floor(opts.completionStartTime * 1e9)
      );
    }
    if (opts.promptName) this.otelSpan.setAttribute(ATTR.PROMPT_NAME, this.maskString(opts.promptName));
    if (opts.promptVersion)
      this.otelSpan.setAttribute(ATTR.PROMPT_VERSION, this.maskString(opts.promptVersion));
  }

  override update(options: GenerationUpdateOptions): this {
    super.update(options);
    const sanitizer = this.traceRef.sanitizer;
    if (options.model) this.setModel(options.model);
    if (options.modelParameters) {
      const masked = sanitizer ? sanitizer.sanitizeUnknown(options.modelParameters) : options.modelParameters;
      this.otelSpan.setAttribute(ATTR.MODEL_PARAMETERS, safeJsonStringify(masked));
    }
    if (options.usage) this.setUsage(options.usage);
    if (options.cost) this.setCost(options.cost);
    if (options.completionStartTime !== undefined) {
      this.otelSpan.setAttribute(
        ATTR.COMPLETION_START_TIME,
        Math.floor(options.completionStartTime * 1e9)
      );
    }
    if (options.promptName) this.otelSpan.setAttribute(ATTR.PROMPT_NAME, this.maskString(options.promptName));
    if (options.promptVersion)
      this.otelSpan.setAttribute(ATTR.PROMPT_VERSION, this.maskString(options.promptVersion));
    return this;
  }

  override end(options: GenerationEndOptions = {}): void {
    // Don't reapply model/usage/cost on an already-ended span — Span.end's
    // ended-flag guards super.end, but the setters above it would silently
    // try to setAttribute on a dead OTel span and emit noisy stack traces.
    if (this.ended) {
      super.end(options);
      return;
    }
    if (options.model) this.setModel(options.model);
    if (options.usage) this.setUsage(options.usage);
    if (options.cost) this.setCost(options.cost);
    super.end(options);
  }

  private setModel(model: string): void {
    this.otelSpan.setAttribute(ATTR.MODEL_NAME, model);
    this.otelSpan.setAttribute(GEN_AI.REQUEST_MODEL, model);
  }

  private setUsage(usage: Usage): void {
    this.otelSpan.setAttribute(ATTR.USAGE_DETAILS, safeJsonStringify(usage));
    if (usage.input_tokens !== undefined)
      this.otelSpan.setAttribute(GEN_AI.USAGE_INPUT_TOKENS, usage.input_tokens);
    if (usage.output_tokens !== undefined)
      this.otelSpan.setAttribute(GEN_AI.USAGE_OUTPUT_TOKENS, usage.output_tokens);
    if (usage.cache_read_tokens !== undefined)
      this.otelSpan.setAttribute(GEN_AI.USAGE_CACHE_READ_INPUT_TOKENS, usage.cache_read_tokens);
    if (usage.cache_creation_tokens !== undefined)
      this.otelSpan.setAttribute(
        GEN_AI.USAGE_CACHE_CREATION_INPUT_TOKENS,
        usage.cache_creation_tokens
      );
  }

  private setCost(cost: Cost): void {
    this.otelSpan.setAttribute(ATTR.COST_DETAILS, safeJsonStringify(cost));
    if (cost.total !== undefined) this.otelSpan.setAttribute(GEN_AI.USAGE_COST, cost.total);
  }
}
