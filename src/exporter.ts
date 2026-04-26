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
  timeoutMs: number;
}

export class DarkhuntSpanExporter implements SpanExporter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private shutdownCalled = false;

  constructor(options: DarkhuntSpanExporterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
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

  async forceFlush(): Promise<void> {}

  private async exportAsync(spans: ReadableSpan[]): Promise<ExportResult> {
    const groups = new Map<string, { route: RouteKey; spans: ReadableSpan[] }>();

    for (const span of spans) {
      const a = span.attributes;
      const tenantId = stringAttr(a[ATTR.TENANT_ID]);
      const workspaceId = stringAttr(a[ATTR.WORKSPACE_ID]);
      const applicationId = stringAttr(a[ATTR.APPLICATION_ID]);
      const assessmentRunId = stringAttr(a[ATTR.ASSESSMENT_RUN_ID]);
      if (!tenantId || !workspaceId || !applicationId || !assessmentRunId) {
        continue;
      }
      const key = `${tenantId}|${workspaceId}|${applicationId}|${assessmentRunId}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = {
          route: { tenantId, workspaceId, applicationId, assessmentRunId },
          spans: [],
        };
        groups.set(key, entry);
      }
      entry.spans.push(span);
    }

    if (groups.size === 0) {
      return { code: ExportResultCode.SUCCESS };
    }

    let failed = false;
    for (const { route, spans: group } of groups.values()) {
      const body = ProtobufTraceSerializer.serializeRequest(group);
      if (!body) {
        continue;
      }
      const url = `${this.baseUrl}/internal/t/${encodeURIComponent(route.tenantId)}/v1/traces`;
      const ok = await this.sendWithRetry(url, body, route);
      if (!ok) failed = true;
    }

    return { code: failed ? ExportResultCode.FAILED : ExportResultCode.SUCCESS };
  }

  private async sendWithRetry(url: string, body: Uint8Array, route: RouteKey): Promise<boolean> {
    let backoff = INITIAL_BACKOFF_MS;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-protobuf',
            'X-Workspace-Id': route.workspaceId,
            'X-Application-Id': route.applicationId,
          },
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
