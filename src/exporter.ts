import { diag } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR } from './attributes.js';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

interface RouteKey {
  tenantId: string;
  workspaceId: string;
  applicationId: string;
  assessmentRunId: string;
}

export interface DarkhuntSpanExporterOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /**
   * When true, post to `/internal/t/{tenantId}/v1/traces` (no auth required)
   * instead of the public `/otlp/t/{tenantId}/v1/traces` path. For in-cluster
   * service-to-service traffic where the upstream `X-Auth-User` header is
   * not present.
   */
  internal?: boolean;
}

export class DarkhuntSpanExporter implements SpanExporter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly internal: boolean;
  private shutdownCalled = false;
  /** Dedupe drop warnings — log once per (missing-fields, span-name) pair. */
  private readonly droppedWarned = new Set<string>();

  constructor(options: DarkhuntSpanExporterOptions) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.internal = options.internal ?? false;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.shutdownCalled) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    void this.exportAsync(spans).then(resultCallback, () =>
      resultCallback({ code: ExportResultCode.FAILED })
    );
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }

  /**
   * No-op: this exporter has no internal buffer. The {@code BatchSpanProcessor}
   * upstream already calls {@link export} synchronously when it flushes, so by
   * the time forceFlush returns there's nothing for us to drain.
   * Required by the {@code SpanExporter} interface.
   */
  async forceFlush(): Promise<void> {
    return;
  }

  /**
   * Log a one-line warning when a span is dropped for missing routing fields.
   * Deduped on (span name, missing fields) so a chronic misconfig produces one
   * line per call site, not one line per span.
   */
  private warnDroppedSpan(spanName: string, missing: string[]): void {
    const key = `${spanName}::${missing.join(',')}`;
    if (this.droppedWarned.has(key)) return;
    this.droppedWarned.add(key);
    diag.warn(
      `DarkhuntSpanExporter: dropping span "${spanName}" — missing required ` +
        `routing attribute(s): ${missing.join(', ')}. The exporter requires ` +
        `tenantId, workspaceId, applicationId, and assessmentRunId on every ` +
        `trace; spans without all four cannot be routed and are silently ` +
        `discarded. Verify the caller passed them to client.trace({...}).`
    );
  }

  private async exportAsync(spans: ReadableSpan[]): Promise<ExportResult> {
    const groups = this.groupByRoute(spans);
    if (groups.size === 0) {
      return { code: ExportResultCode.SUCCESS };
    }

    let failed = false;
    for (const { route, spans: group } of groups.values()) {
      const ok = await this.exportGroup(route, group);
      if (!ok) failed = true;
    }
    return { code: failed ? ExportResultCode.FAILED : ExportResultCode.SUCCESS };
  }

  /**
   * Bucket spans by their (tenant, workspace, application, assessmentRun) tuple
   * so each bucket can be POSTed to its own tenant-scoped endpoint. Spans
   * missing any of the four routing attributes are logged and dropped.
   */
  private groupByRoute(
    spans: ReadableSpan[]
  ): Map<string, { route: RouteKey; spans: ReadableSpan[] }> {
    const groups = new Map<string, { route: RouteKey; spans: ReadableSpan[] }>();
    for (const span of spans) {
      const route = this.extractRoute(span);
      if (!route) continue;
      const key = `${route.tenantId}|${route.workspaceId}|${route.applicationId}|${route.assessmentRunId}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { route, spans: [] };
        groups.set(key, entry);
      }
      entry.spans.push(span);
    }
    return groups;
  }

  /**
   * Pull the four routing attributes off a span. Returns null and logs a
   * deduped warning when any attribute is missing.
   */
  private extractRoute(span: ReadableSpan): RouteKey | null {
    const a = span.attributes;
    const tenantId = stringAttr(a[ATTR.TENANT_ID]);
    const workspaceId = stringAttr(a[ATTR.WORKSPACE_ID]);
    const applicationId = stringAttr(a[ATTR.APPLICATION_ID]);
    const assessmentRunId = stringAttr(a[ATTR.ASSESSMENT_RUN_ID]);
    if (tenantId && workspaceId && applicationId && assessmentRunId) {
      return { tenantId, workspaceId, applicationId, assessmentRunId };
    }
    const missing: string[] = [];
    if (!tenantId) missing.push('tenantId');
    if (!workspaceId) missing.push('workspaceId');
    if (!applicationId) missing.push('applicationId');
    if (!assessmentRunId) missing.push('assessmentRunId');
    this.warnDroppedSpan(span.name, missing);
    return null;
  }

  /** Serialize one route's spans and POST them. */
  private async exportGroup(route: RouteKey, spans: ReadableSpan[]): Promise<boolean> {
    const body = ProtobufTraceSerializer.serializeRequest(spans);
    if (!body) return true;
    return this.sendWithRetry(this.buildUrl(route), body, route);
  }

  private buildUrl(route: RouteKey): string {
    const pathPrefix = this.internal ? 'internal' : 'otlp';
    return `${this.baseUrl}/${pathPrefix}/t/${encodeURIComponent(route.tenantId)}/v1/traces`;
  }

  private async sendWithRetry(url: string, body: Uint8Array, route: RouteKey): Promise<boolean> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-protobuf',
      'X-Workspace-Id': route.workspaceId,
      'X-Application-Id': route.applicationId,
    };
    // Internal endpoint is permitAll; the bearer header would be ignored. Skip
    // it so we don't attach a stale/empty token to in-cluster requests.
    if (!this.internal) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let backoff = INITIAL_BACKOFF_MS;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (resp.ok) return true;
        if (!RETRYABLE_STATUS.has(resp.status)) return false;
      } catch {
        // network/timeout — retry
      }
      const jitter = Math.random() * backoff * 0.5;
      await sleep(backoff + jitter);
      backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    }
    return false;
  }
}

function stringAttr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Trim every trailing `/` from the URL. Plain string ops instead of a regex
 * so static analyzers don't flag the call as a potential ReDoS vector
 * (the equivalent regex `/\/+$/` is in fact linear, but Sonar/CodeQL
 * conservatively warn on any quantifier in a constructor input).
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === url.length ? url : url.slice(0, end);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
