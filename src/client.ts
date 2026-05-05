import { trace as otTrace, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { DarkhuntSpanExporter } from './exporter.js';
import { Sanitizer, type CustomPattern } from './masking/index.js';
import { Trace, type TraceArgs } from './trace.js';

const LIB_NAME = 'darkhunt-telemetry';
const LIB_VERSION = '0.1.0';

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
   * When true, the exporter posts to trace-hub's `/internal/...` endpoint
   * (no auth) instead of the public `/otlp/...` endpoint. Use for in-cluster
   * service-to-service traffic. Also relaxes the apiKey requirement.
   * Defaults to `false`, or `DARKHUNT_INTERNAL=true` env if set.
   */
  internal?: boolean;
  /** Client-side data masking. Enabled by default. */
  mask?: MaskingOptions;
}

export class DarkhuntTelemetry {
  private readonly _enabled: boolean;
  private readonly _release?: string;
  private readonly _environment?: string;
  private readonly _sanitizer?: Sanitizer;
  private provider?: NodeTracerProvider;
  private tracer?: Tracer;

  constructor(options: DarkhuntTelemetryOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.DARKHUNT_BASE_URL ?? 'http://localhost:8080';
    const apiKey = options.apiKey ?? process.env.DARKHUNT_API_KEY ?? '';
    this._release = options.release ?? process.env.DARKHUNT_RELEASE;
    this._environment = options.environment ?? process.env.DARKHUNT_ENVIRONMENT;

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

  trace(args: TraceArgs): Trace {
    if (!this._enabled || !this.tracer) {
      return new Trace(otTrace.getTracer(LIB_NAME, LIB_VERSION), args, this._sanitizer);
    }
    return new Trace(
      this.tracer,
      {
        ...args,
        release: args.release ?? this._release,
        environment: args.environment ?? this._environment,
      },
      this._sanitizer
    );
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
