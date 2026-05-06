import { trace as otTrace, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import pkg from '../package.json' with { type: 'json' };
import { DarkhuntSpanExporter } from './exporter.js';
import { Sanitizer, type CustomPattern } from './masking/index.js';
import { Trace, type TraceArgs } from './trace.js';

const LIB_NAME = 'darkhunt-telemetry';
const LIB_VERSION = pkg.version;

export interface MaskingOptions {
  /**
   * Enable client-side data masking on inputs, outputs, messages, system
   * prompts, metadata values, and status messages before they leave this
   * process. Defaults to true — turning it off is rarely the right call,
   * but available for local dev with synthetic data.
   */
  enabled?: boolean;
  /**
   * Operator-defined extra rules merged after the bundled defaults. The
   * defaults already cover common secrets (API keys, tokens) and PII
   * (emails, IBANs, credit cards, etc.) — use this only for site-specific
   * patterns like internal ticket IDs.
   */
  customPatterns?: readonly CustomPattern[];
}

export interface DarkhuntTelemetryOptions {
  baseUrl?: string;
  apiKey?: string;
  flushAt?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  release?: string;
  environment?: string;
  enabled?: boolean;
  /**
   * When true, the exporter posts to the backend's permitAll `/internal/...`
   * path instead of the auth-required `/otlp/...` path. Use for in-cluster
   * service-to-service traffic where pod-to-pod requests don't carry the
   * upstream auth header. Also relaxes the `apiKey` requirement.
   * Defaults to `false`, or `DARKHUNT_INTERNAL=true` env if set.
   */
  internal?: boolean;
  /** Client-side data masking. Enabled by default. */
  mask?: MaskingOptions;
  /**
   * Default routing fields applied to every trace from this client. Set them
   * once here and {@link DarkhuntTelemetry.trace} calls only need to pass
   * what's actually variable (typically just `assessmentRunId`, `sessionId`,
   * `userId`, etc.). Per-trace args still win when explicitly provided.
   *
   * Each field also reads from a `DARKHUNT_*_ID` env var as a fallback:
   *   - `tenantId`        → `DARKHUNT_TENANT_ID`
   *   - `workspaceId`     → `DARKHUNT_WORKSPACE_ID`
   *   - `applicationId`   → `DARKHUNT_APPLICATION_ID`
   *   - `assessmentRunId` → `DARKHUNT_ASSESSMENT_RUN_ID`
   *
   * The four routing fields are required *somewhere* (constructor, env, or
   * per-trace). {@link DarkhuntTelemetry.trace} throws if any is still
   * missing after merging.
   */
  tenantId?: string;
  workspaceId?: string;
  applicationId?: string;
  assessmentRunId?: string;
}

export class DarkhuntTelemetry {
  private readonly _enabled: boolean;
  private readonly _release?: string;
  private readonly _environment?: string;
  private readonly _sanitizer?: Sanitizer;
  private readonly _tenantId?: string;
  private readonly _workspaceId?: string;
  private readonly _applicationId?: string;
  private readonly _assessmentRunId?: string;
  private provider?: NodeTracerProvider;
  private tracer?: Tracer;

  constructor(options: DarkhuntTelemetryOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.DARKHUNT_BASE_URL ?? 'https://app.darkhunt.ai';
    const apiKey = options.apiKey ?? process.env.DARKHUNT_API_KEY ?? '';
    this._release = options.release ?? process.env.DARKHUNT_RELEASE;
    this._environment = options.environment ?? process.env.DARKHUNT_ENVIRONMENT;
    this._tenantId = options.tenantId ?? process.env.DARKHUNT_TENANT_ID;
    this._workspaceId = options.workspaceId ?? process.env.DARKHUNT_WORKSPACE_ID;
    this._applicationId = options.applicationId ?? process.env.DARKHUNT_APPLICATION_ID;
    this._assessmentRunId = options.assessmentRunId ?? process.env.DARKHUNT_ASSESSMENT_RUN_ID;

    const enabledEnv = process.env.DARKHUNT_ENABLED ?? 'true';
    this._enabled = options.enabled ?? enabledEnv.toLowerCase() === 'true';

    const internal =
      options.internal ?? (process.env.DARKHUNT_INTERNAL ?? 'false').toLowerCase() === 'true';

    // Internal endpoint is permitAll; no apiKey needed. Public endpoint requires one.
    if (this._enabled && !internal && !apiKey) {
      throw new Error(
        'DarkhuntTelemetry: apiKey is required for the public endpoint ' +
          '(pass via options, set DARKHUNT_API_KEY, or use internal: true)'
      );
    }

    const maskingEnabled = options.mask?.enabled ?? true;
    if (this._enabled && maskingEnabled) {
      this._sanitizer = new Sanitizer(undefined, options.mask?.customPatterns ?? []);
    }

    if (this._enabled) {
      this.setupProvider({
        baseUrl,
        apiKey,
        internal,
        flushAt: options.flushAt ?? toInt(process.env.DARKHUNT_FLUSH_AT, 20),
        flushIntervalMs:
          options.flushIntervalMs ?? toFloat(process.env.DARKHUNT_FLUSH_INTERVAL, 5) * 1000,
        timeoutMs: options.timeoutMs ?? toFloat(process.env.DARKHUNT_TIMEOUT, 10) * 1000,
      });
      process.once('beforeExit', () => {
        void this.shutdown();
      });
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  trace(args: TraceArgs = {}): Trace {
    const merged: TraceArgs = {
      ...args,
      tenantId: args.tenantId ?? this._tenantId,
      workspaceId: args.workspaceId ?? this._workspaceId,
      applicationId: args.applicationId ?? this._applicationId,
      assessmentRunId: args.assessmentRunId ?? this._assessmentRunId,
      release: args.release ?? this._release,
      environment: args.environment ?? this._environment,
    };

    requireField(merged.tenantId, 'tenantId', 'DARKHUNT_TENANT_ID');
    requireField(merged.workspaceId, 'workspaceId', 'DARKHUNT_WORKSPACE_ID');
    requireField(merged.applicationId, 'applicationId', 'DARKHUNT_APPLICATION_ID');
    // assessmentRunId is optional — used internally by Darkhunt assessment
    // workflows. Production tracing does not need to set it.

    const tracer =
      this._enabled && this.tracer ? this.tracer : otTrace.getTracer(LIB_NAME, LIB_VERSION);
    return new Trace(tracer, merged, this._sanitizer);
  }

  async flush(): Promise<void> {
    if (this.provider) {
      await this.provider.forceFlush();
    }
  }

  async shutdown(): Promise<void> {
    if (this.provider) {
      await this.provider.shutdown();
      this.provider = undefined;
      this.tracer = undefined;
    }
  }

  private setupProvider(opts: {
    baseUrl: string;
    apiKey: string;
    internal: boolean;
    flushAt: number;
    flushIntervalMs: number;
    timeoutMs: number;
  }): void {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: LIB_NAME,
      [ATTR_SERVICE_VERSION]: LIB_VERSION,
    });

    const exporter = new DarkhuntSpanExporter({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      internal: opts.internal,
    });

    this.provider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          maxExportBatchSize: opts.flushAt,
          scheduledDelayMillis: opts.flushIntervalMs,
        }),
      ],
    });

    this.tracer = this.provider.getTracer(LIB_NAME, LIB_VERSION);
  }
}

function requireField(
  value: string | undefined,
  optionName: string,
  envVarName: string
): asserts value is string {
  if (!value) {
    throw new Error(
      `DarkhuntTelemetry: ${optionName} is required. ` +
        `Pass it on dh.trace({ ${optionName}: ... }), set it as a default on ` +
        `new DarkhuntTelemetry({ ${optionName}: ... }), or set the ${envVarName} env var.`
    );
  }
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}
