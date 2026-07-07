import {
  diag,
  context as otContext,
  trace as otTrace,
  SpanStatusCode,
  type Context,
  type Link,
  type Span as OtelSpan,
  type SpanOptions as OtelSpanOptions,
  type TimeInput,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR, GEN_AI } from './attributes.js';
import type { Sanitizer } from './masking/index.js';
import type { Trace } from './trace.js';
import type { Cost, Metadata, ObservationLevel, ObservationType, Usage } from './types.js';

/**
 * JSON.stringify wrapper that converts BigInt → string (the closest JSON has)
 * and returns a placeholder rather than throwing on circular refs or other
 * unserializable values — caller is a span-attribute setter on a hot path
 * and must not fail.
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
    // Keys land in the OTel attribute name verbatim; mask them too.
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
   * OTel span links to related spans. Use for multi-agent handoffs when an
   * orchestrator owns the trace: the causal DAG (agent A → agent B) lives in
   * links rather than the parent chain. Pass each upstream span's `.context`.
   * Supports fan-in — several upstreams linking into one span (e.g. a judge
   * that read both a bull and a bear analyst).
   */
  links?: Context[];
  /**
   * Tool name for `tool`-type observations (e.g. "geocode"). Emitted as
   * `gen_ai.tool.name` — the backend reads it as the observation's tool name
   * and the dashboard uses it as the span title (otherwise it falls back to the
   * generic type "tool"). Set this whenever `observationType: 'tool'`.
   */
  toolName?: string;
  /** Tool-call id (e.g. the provider's `tool_call.id`). Emitted as `gen_ai.tool.call.id`. */
  toolCallId?: string;
  /** Tool-call arguments. Emitted (masked) as `gen_ai.tool.call.arguments`. */
  toolArguments?: unknown;
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
  /** See {@link SpanOptions.toolName}. */
  toolName?: string;
  /** See {@link SpanOptions.toolCallId}. */
  toolCallId?: string;
  /** See {@link SpanOptions.toolArguments}. */
  toolArguments?: unknown;
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

/** Link attribute key + value marking a span link as an agent handoff, so a
 *  topology consumer can tell handoffs apart from any other use of OTel links
 *  (batch fan-out, retries, "followed-from", …) rather than inferring it. */
export const LINK_KIND_ATTR = 'darkhunt.link.kind';
export const HANDOFF_LINK_KIND = 'agent_handoff';

/** Resolve caller-supplied contexts into OTel span links (valid ones only), each
 *  tagged as an agent handoff. Accepts both live span contexts (`span.context`)
 *  and remote contexts extracted from a W3C `traceparent` — the common shape for
 *  a cross-process agent handoff. */
export function toOtelLinks(contexts?: Context[]): Link[] {
  if (!contexts?.length) return [];
  const links: Link[] = [];
  for (const c of contexts) {
    const sc = otTrace.getSpanContext(c);
    if (sc?.spanId && sc.traceId) {
      links.push({ context: sc, attributes: { [LINK_KIND_ATTR]: HANDOFF_LINK_KIND } });
    }
  }
  return links;
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
    const otelOptions: OtelSpanOptions = {};
    if (opts.startTime !== undefined) otelOptions.startTime = opts.startTime;
    const links = toOtelLinks(opts.links);
    if (links.length > 0) otelOptions.links = links;
    // Span name lands on the wire verbatim — mask in case user-controlled.
    this.otelSpan = this.tracer.startSpan(
      this.traceRef.maskName(args.name),
      Object.keys(otelOptions).length > 0 ? otelOptions : undefined,
      parentCtx
    );
    this.ctx = otTrace.setSpan(parentCtx, this.otelSpan);

    this.otelSpan.setAttribute(ATTR.OBSERVATION_TYPE, opts.observationType ?? 'span');
    this.applyTraceAttrs();
    if (opts.input !== undefined) this.setIo(ATTR.OBSERVATION_INPUT, opts.input);
    if (opts.output !== undefined) this.setIo(ATTR.OBSERVATION_OUTPUT, opts.output);
    if (opts.metadata) applyMetadataAttrs(this.otelSpan, opts.metadata, this.traceRef.sanitizer);
    if (opts.level) this.otelSpan.setAttribute(ATTR.OBSERVATION_LEVEL, opts.level);
    this.setMaskedStringAttr(ATTR.STATUS_MESSAGE, opts.statusMessage);
    this.setMaskedStringAttr(ATTR.VERSION, opts.version);
    this.setToolAttrs(opts);
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
    this.setMaskedJsonAttr(GEN_AI.INPUT_MESSAGES, options.inputMessages);
    this.setMaskedJsonAttr(GEN_AI.OUTPUT_MESSAGES, options.outputMessages);
    if (options.systemInstructions !== undefined) {
      this.otelSpan.setAttribute(
        GEN_AI.SYSTEM_INSTRUCTIONS,
        this.maskString(options.systemInstructions)
      );
    }
    if (options.metadata)
      applyMetadataAttrs(this.otelSpan, options.metadata, this.traceRef.sanitizer);
    if (options.level) this.otelSpan.setAttribute(ATTR.OBSERVATION_LEVEL, options.level);
    this.setMaskedStringAttr(ATTR.STATUS_MESSAGE, options.statusMessage);
    this.setMaskedStringAttr(ATTR.VERSION, options.version);
    this.setToolAttrs(options);
    return this;
  }

  end(options: SpanEndOptions = {}): void {
    if (this.ended) return;
    this.ended = true;

    if (options.output !== undefined) this.setIo(ATTR.OBSERVATION_OUTPUT, options.output);
    this.setMaskedJsonAttr(GEN_AI.OUTPUT_MESSAGES, options.outputMessages);
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

  protected setMaskedStringAttr(key: string, value: string | undefined): void {
    if (value) this.otelSpan.setAttribute(key, this.maskString(value));
  }

  /** Emit `gen_ai.tool.*` attributes for tool observations (name/callId/arguments). */
  protected setToolAttrs(opts: {
    toolName?: string;
    toolCallId?: string;
    toolArguments?: unknown;
  }): void {
    this.setMaskedStringAttr(GEN_AI.TOOL_NAME, opts.toolName);
    this.setMaskedStringAttr(GEN_AI.TOOL_CALL_ID, opts.toolCallId);
    if (opts.toolArguments !== undefined)
      this.setIo(GEN_AI.TOOL_CALL_ARGUMENTS, opts.toolArguments);
  }

  protected setMaskedJsonAttr(key: string, value: unknown): void {
    if (value === undefined) return;
    const sanitizer = this.traceRef.sanitizer;
    const masked = sanitizer ? sanitizer.sanitizeUnknown(value) : value;
    this.otelSpan.setAttribute(key, safeJsonStringify(masked));
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
    // t.name is the raw stored value — mask on every child span attribute.
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
    if (opts.model) this.setModel(opts.model);
    // Walk modelParameters: operators sometimes tuck provider keys or webhook
    // URLs in here for custom backends.
    this.setMaskedJsonAttr(ATTR.MODEL_PARAMETERS, opts.modelParameters);
    if (opts.usage) this.setUsage(opts.usage);
    if (opts.cost) this.setCost(opts.cost);
    if (opts.completionStartTime !== undefined) {
      this.otelSpan.setAttribute(
        ATTR.COMPLETION_START_TIME,
        Math.floor(opts.completionStartTime * 1e9)
      );
    }
    this.setMaskedStringAttr(ATTR.PROMPT_NAME, opts.promptName);
    this.setMaskedStringAttr(ATTR.PROMPT_VERSION, opts.promptVersion);
  }

  override update(options: GenerationUpdateOptions): this {
    super.update(options);
    if (options.model) this.setModel(options.model);
    this.setMaskedJsonAttr(ATTR.MODEL_PARAMETERS, options.modelParameters);
    if (options.usage) this.setUsage(options.usage);
    if (options.cost) this.setCost(options.cost);
    if (options.completionStartTime !== undefined) {
      this.otelSpan.setAttribute(
        ATTR.COMPLETION_START_TIME,
        Math.floor(options.completionStartTime * 1e9)
      );
    }
    this.setMaskedStringAttr(ATTR.PROMPT_NAME, options.promptName);
    this.setMaskedStringAttr(ATTR.PROMPT_VERSION, options.promptVersion);
    return this;
  }

  override end(options: GenerationEndOptions = {}): void {
    // Skip the model/usage/cost setters when already ended — OTel logs a
    // diag.warn per setAttribute on a dead span.
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
