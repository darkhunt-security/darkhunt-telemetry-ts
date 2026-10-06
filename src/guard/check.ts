/**
 * One check against `/verify`: build the request from the current run, ask, and record
 * the verdict as a `guardrail` span. Shared by {@link guard} and the AGT plug-in.
 */

import { Span, safeJsonStringify } from '../span.js';
import type { Trace } from '../trace.js';
import type { Metadata } from '../types.js';
import { verify } from './client.js';
import type { GuardConfig } from './config.js';
import { Verdict, type Stage } from './verdict.js';

const warned = new Set<string>();

/** Emit a Node warning once per `key` (misconfiguration that silently weakens checks). */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.emitWarning(message, { code: 'DARKHUNT_GUARD' });
}

/** The trace a host belongs to: a Span's trace, or the Trace itself. */
export function traceOf(host: Trace | Span | undefined): Trace | undefined {
  if (host === undefined) return undefined;
  return host instanceof Span ? host.trace : host;
}

/** `value` as plain JSON, via the SDK's lenient encoder. */
export function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(safeJsonStringify(value)) as unknown;
}

/** `value` as JSON, or its first `limit` bytes as text when it is larger. */
export function capped(value: unknown, limit: number): unknown {
  const encoded = safeJsonStringify(value === undefined ? null : value);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes <= limit) return JSON.parse(encoded) as unknown;
  // Too big to send whole: send the beginning and say so. A rule on content sees
  // the first `limit` bytes; one on the tool name is unaffected.
  const head = Buffer.from(encoded, 'utf8').subarray(0, limit).toString('utf8');
  return { truncated: true, bytes, head };
}

/** Whether a verdict stops the call under this configuration. */
export function blocks(config: GuardConfig, verdict: Verdict): boolean {
  if (config.mode !== 'enforce') return false;
  if (verdict.unanswered) return config.fail === 'closed';
  return verdict.denied;
}

export interface CheckRequest {
  config: GuardConfig;
  /** The current run (for routing, session and user), if any. */
  host: Trace | Span | undefined;
  /** Where to record the check; a `tool` span is also marked when the check blocks. */
  recordUnder: Trace | Span | undefined;
  stage: Stage;
  tool: string;
  callId: string;
  args: unknown;
  result?: unknown;
  /** Overrides taken from outside the run (e.g. an AGT snapshot envelope). */
  sessionId?: string;
  userId?: string;
  source?: string;
  tenantId?: string;
}

export async function check(request: CheckRequest): Promise<Verdict> {
  const { config, stage, tool } = request;
  const trace = traceOf(request.host);
  const tenant = request.tenantId || trace?.tenantId || config.tenantId;
  const toolBody: Record<string, unknown> = {
    name: tool,
    callId: request.callId,
    arguments: request.args ?? {},
  };
  if (stage === 'TOOL_RESULT') toolBody.result = capped(request.result, config.maxResultBytes);
  const body: Record<string, unknown> = {
    stage,
    workspaceId: trace?.workspaceId || config.workspaceId,
    applicationId: trace?.applicationId || config.applicationId,
    sessionId: request.sessionId ?? trace?.sessionId,
    userId: request.userId ?? trace?.userId,
    userEmail: trace?.userEmail,
    source: config.source ?? request.source ?? trace?.agent,
    tool: toolBody,
  };
  for (const key of Object.keys(body)) if (!body[key]) delete body[key];

  if (request.host === undefined) {
    warnOnce(
      'no-run',
      `darkhunt guard: ${tool} was called outside an active trace, so its checks carry no ` +
        'session — rules over a session’s history cannot apply. Run the agent inside ' +
        '`trace.activate(() => ...)`.'
    );
  }
  const g = request.recordUnder?.span(`darkhunt.guard.${stage.toLowerCase()}`, {
    observationType: 'guardrail',
  });
  let verdict: Verdict;
  if (!tenant) {
    warnOnce('no-tenant', 'darkhunt guard: no tenant id (DARKHUNT_TENANT_ID); checks are skipped');
    verdict = new Verdict(tool, stage, undefined, [], [], false, 'no tenant configured');
  } else {
    const timeout = stage === 'TOOL_CALL' ? config.callTimeoutMs : config.resultTimeoutMs;
    verdict = await verify(config, tenant, body, timeout);
  }
  verdict = verdict.with({
    mode: config.mode,
    blocked: blocks(config, verdict),
    sessionId: body.sessionId as string | undefined,
  });
  recordVerdict(g, request.recordUnder, verdict);
  if (config.onVerdict) {
    try {
      config.onVerdict(verdict);
    } catch (err) {
      warnOnce('hook', `darkhunt guard: onVerdict threw: ${String(err)}`);
    }
  }
  return verdict;
}

/** Write one check onto its `guardrail` span and, when it blocked, mark the tool span. */
export function recordVerdict(
  g: Span | undefined,
  host: Trace | Span | undefined,
  v: Verdict
): void {
  if (g === undefined) return;
  const meta: Metadata = {
    'guard.stage': v.stage,
    'guard.decision': v.decision ?? 'NONE',
    'guard.blocked': v.blocked,
    'guard.mode': v.mode,
    'guard.latency_ms': Math.round(v.latencyMs * 10) / 10,
  };
  const first = v.matchedRules[0];
  if (first) {
    meta['guard.rule_id'] = first.ruleId;
    meta['guard.rule_name'] = first.ruleName;
    meta['guard.matched_rules'] = v.matchedRules.map((r) => r.ruleName);
  }
  if (v.observedRules.length > 0)
    meta['guard.observed_rules'] = v.observedRules.map((r) => r.ruleName);
  if (v.failed) meta['guard.failed'] = true;
  if (v.error) meta['guard.error'] = v.error;
  g.update({
    metadata: meta,
    output: Object.fromEntries(Object.entries(meta).map(([k, val]) => [k.slice(6), val])),
  });
  const flagged = v.denied || v.failed || v.unanswered || v.observedRules.length > 0;
  let status: string | undefined;
  if (v.blocked) status = `Blocked: ${v.reason}`;
  else if (v.denied) status = `Would block (${v.mode}): ${v.reason}`;
  else if (v.observedRules[0]) status = `Observed: ${v.observedRules[0].ruleName}`;
  else if (v.unanswered) status = v.reason;
  g.end({ level: flagged ? 'WARNING' : undefined, statusMessage: status });
  if (v.blocked && host instanceof Span && host.observationType === 'tool') {
    host.update({
      level: 'WARNING',
      statusMessage: status,
      metadata: { 'guard.blocked_at': v.stage, 'guard.executed': v.stage !== 'TOOL_CALL' },
    });
  }
}
