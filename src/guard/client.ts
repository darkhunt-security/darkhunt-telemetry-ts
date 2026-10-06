/**
 * The guardrail manager's `/verify` over HTTP. One request per check and no
 * retries: a retry would double the latency of the call being guarded. Every
 * failure — timeout, network, non-2xx, unreadable body — comes back as a verdict
 * with no decision and an `error`; nothing is thrown into the tool.
 */

import type { GuardConfig } from './config.js';
import { Verdict, type RuleMatch, type Stage } from './verdict.js';

interface VerifyResponse {
  decision?: string;
  matchedRules?: RuleMatch[] | null;
  observedRules?: RuleMatch[] | null;
  failed?: boolean;
}

export async function verify(
  config: GuardConfig,
  tenantId: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<Verdict> {
  const tool = (body.tool as { name?: string } | undefined)?.name ?? 'tool';
  const stage = body.stage as Stage;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...config.headers };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const started = performance.now();
  const latency = () => performance.now() - started;
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/t/${encodeURIComponent(tenantId)}/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const error = name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : name;
    return new Verdict(tool, stage, undefined, [], [], false, error, latency());
  }
  if (!response.ok) {
    return new Verdict(tool, stage, undefined, [], [], false, `HTTP ${response.status}`, latency());
  }
  let data: VerifyResponse;
  try {
    data = (await response.json()) as VerifyResponse;
  } catch {
    return new Verdict(tool, stage, undefined, [], [], false, 'unreadable response', latency());
  }
  return new Verdict(
    tool,
    stage,
    data.decision,
    data.matchedRules ?? [],
    data.observedRules ?? [],
    data.failed ?? false,
    undefined,
    latency()
  );
}
