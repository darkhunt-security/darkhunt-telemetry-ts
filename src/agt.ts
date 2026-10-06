/**
 * Darkhunt as the policy behind Microsoft's Agent Governance Toolkit (AGT).
 *
 * AGT's Agent Control Specification (ACS) runtime stops an agent at intervention points
 * — before and after each tool call, on the run's input and output — and asks a policy
 * for a verdict. {@link DarkhuntPolicy} is that policy for a manifest entry of
 * `type: custom, adapter: darkhunt`: it asks Darkhunt's `/verify`, so an agent governed
 * by AGT is held to the rules in the Darkhunt dashboard, lands in the same enforcement
 * log, and records the same `guardrail` spans as one wrapped with `guard()`.
 *
 *     policies:
 *       darkhunt: {type: custom, adapter: darkhunt}
 *     intervention_points:
 *       pre_tool_call:  {policy: {id: darkhunt}, policy_target: $.tool_call.args}
 *       post_tool_call: {policy: {id: darkhunt}, policy_target: $.tool_result}
 *
 *     const control = AgentControl.fromPath('agt.yaml', undefined, new DarkhuntPolicy());
 *
 * {@link agtTool} puts a tool function behind such a control, {@link runGoverned} a call
 * dispatched by name, and {@link checkToolPoint} answers allow/deny hooks.
 *
 * AGT is optional: `npm install agent-control-specification@0.3.1-beta.0` (the version in
 * AGT's latest official release, v4.1.0). Nothing else in this SDK loads it, and this
 * module only uses it through the control you pass in.
 */

import { randomUUID } from 'node:crypto';
import { currentObservation } from './current.js';
import { check, jsonSafe, traceOf, warnOnce } from './guard/check.js';
import { getGuardConfig, type GuardConfig } from './guard/config.js';
import { defaultArguments, type OnDeny } from './guard/guard.js';
import type { Stage, Verdict } from './guard/verdict.js';
import type { Span } from './span.js';
import type { Trace } from './trace.js';

/** The ACS intervention points that have a `/verify` stage; the rest are allowed through. */
export const STAGES: Readonly<Record<string, Stage>> = Object.freeze({
  pre_tool_call: 'TOOL_CALL',
  post_tool_call: 'TOOL_RESULT',
});

/** An ACS verdict, as a policy dispatcher returns it. */
export interface AcsVerdict extends Record<string, string> {
  decision: 'allow' | 'deny' | 'warn';
}

/** The part of AGT's `AgentControl` this module uses (kept structural: AGT is optional). */
export interface AgtControl {
  runTool(
    toolName: string,
    args: unknown,
    execute: (args: unknown) => unknown,
    options?: { toolCallId?: string; snapshot?: Record<string, unknown> }
  ): Promise<{ value: unknown }>;
  evaluateInterventionPoint(
    interventionPoint: never,
    snapshot: Record<string, unknown>,
    mode?: never
  ): Promise<{ verdict: { decision: string; reason?: string | null; message?: string | null } }>;
}

/** A control, a function returning one, or nothing (AGT switched off: tools just run). */
export type ControlSource = AgtControl | (() => AgtControl | null | undefined) | null | undefined;

/** AGT's `AgentControlBlockedError`, matched by shape so this module never imports AGT. */
interface BlockedError extends Error {
  interventionPoint: string;
  result: { verdict: { reason?: string | null; message?: string | null } };
}

function isBlocked(err: unknown): err is BlockedError {
  return (
    err instanceof Error && err.name === 'AgentControlBlockedError' && 'interventionPoint' in err
  );
}

function resolveControl(control: ControlSource): AgtControl | null | undefined {
  return typeof control === 'function' ? control() : control;
}

function acsVerdict(v: Verdict): AcsVerdict {
  const rule = v.matchedRules[0];
  if (v.blocked) {
    return {
      decision: 'deny',
      reason: rule ? `darkhunt:${rule.ruleId}` : 'darkhunt:unavailable',
      message: v.reason,
    };
  }
  if (v.denied) {
    return {
      decision: 'warn',
      reason: 'darkhunt:not_enforced',
      message: `Would block (${v.mode}): ${v.reason}`,
    };
  }
  if (v.observedRules[0]) {
    return { decision: 'warn', reason: 'darkhunt:observed', message: v.observedRules[0].ruleName };
  }
  if (v.unanswered) return { decision: 'warn', reason: 'darkhunt:unavailable', message: v.reason };
  return { decision: 'allow' };
}

// The run each in-flight tool call belongs to, by the call id handed to AGT. ACS calls
// the policy back from its native runtime, where the caller's async context is gone, so
// the policy cannot read the current run itself.
const runs = new Map<string, Trace | Span | undefined>();

type Snapshot = {
  envelope?: {
    session?: { id?: string };
    agent?: { id?: string };
    user?: { id?: string };
    tenant?: string;
  };
  tool_call?: { name?: string; args?: unknown; id?: string };
  tool_result?: unknown;
};

/**
 * ACS policy dispatcher that decides with Darkhunt's `/verify`.
 *
 * Uses the guard configuration (`DARKHUNT_GUARD_*` / `configureGuard`) unless `config`
 * is given. It never rejects: ACS turns a dispatcher error into a deny, so an
 * unreachable Darkhunt would always fail closed. Unanswered checks follow the
 * configured fail mode instead.
 */
export class DarkhuntPolicy {
  constructor(private readonly config?: GuardConfig | (() => GuardConfig)) {}

  private resolveConfig(): GuardConfig {
    const c = this.config;
    if (c === undefined) return getGuardConfig();
    return typeof c === 'function' ? c() : c;
  }

  async evaluate(invocation: Record<string, unknown>): Promise<AcsVerdict> {
    const config = this.resolveConfig();
    const input = (invocation.input ?? {}) as { intervention_point?: string; snapshot?: Snapshot };
    const stage = STAGES[input.intervention_point ?? ''];
    if (stage === undefined || config.mode === 'off') return { decision: 'allow' };
    try {
      return acsVerdict(await this.check(config, stage, input.snapshot ?? {}));
    } catch (err) {
      warnOnce('agt-error', `darkhunt agt: check failed: ${String(err)}`);
      const closed = config.mode === 'enforce' && config.fail === 'closed';
      return { decision: closed ? 'deny' : 'warn', reason: 'darkhunt:error', message: String(err) };
    }
  }

  private check(config: GuardConfig, stage: Stage, snapshot: Snapshot): Promise<Verdict> {
    const call = snapshot.tool_call ?? {};
    const envelope = snapshot.envelope ?? {};
    const host = currentObservation() ?? runs.get(String(call.id));
    const args =
      call.args !== null && typeof call.args === 'object' ? call.args : { value: call.args };
    return check({
      config,
      host,
      recordUnder: host,
      stage,
      tool: String(call.name ?? 'tool'),
      callId: String(call.id ?? randomUUID().replace(/-/g, '')),
      args: jsonSafe(args),
      result: snapshot.tool_result,
      sessionId: envelope.session?.id,
      userId: envelope.user?.id,
      source: envelope.agent?.id,
      tenantId: envelope.tenant,
    });
  }
}

/** The ACS snapshot envelope for a Darkhunt run (default: the current one). */
function envelopeOf(host: Trace | Span | undefined): Record<string, unknown> {
  const trace = traceOf(host);
  if (trace === undefined) return {};
  const env: Record<string, unknown> = {};
  if (trace.sessionId) env.session = { id: trace.sessionId };
  if (trace.agent) env.agent = { id: trace.agent };
  if (trace.userId) env.user = { id: trace.userId };
  return env;
}

/** The text a model reads in place of a blocked call's result. */
export function refusal(blocked: unknown, toolName: string): string {
  const verdict = isBlocked(blocked) ? blocked.result.verdict : {};
  const message = verdict.message || verdict.reason || 'policy';
  if (isBlocked(blocked) && blocked.interventionPoint === 'pre_tool_call') {
    return `Blocked by Darkhunt: ${message}. The ${toolName} tool was not run.`;
  }
  return `Withheld by Darkhunt: ${message}. The ${toolName} tool ran, but its output was withheld.`;
}

export interface GovernOptions<D> {
  /** What the caller gets on a block: as for `guard()`; a function gets AGT's error. */
  onDeny?: OnDeny<D> | ((blocked: Error) => D);
  /** The observation to record under, when the caller is not inside the run's context. */
  host?: Trace | Span;
}

/**
 * Run one tool call through an AGT control: `pre_tool_call`, `execute()`,
 * `post_tool_call`. For agent loops that dispatch tools by name. `execute()` runs the
 * call as made; its result goes into AGT's snapshot, so it must be JSON-serialisable.
 * A `control` of `null` / `undefined` just runs it.
 */
export async function runGoverned<T, D = string>(
  control: ControlSource,
  toolName: string,
  args: unknown,
  execute: () => T | Promise<T>,
  options: GovernOptions<D> = {}
): Promise<Awaited<T> | D> {
  const ctl = resolveControl(control);
  if (!ctl) return await execute();
  const callId = randomUUID().replace(/-/g, '');
  const host = options.host ?? currentObservation();
  runs.set(callId, host);
  try {
    const ran = await ctl.runTool(toolName, jsonSafe(args), async () => await execute(), {
      toolCallId: callId,
      snapshot: { envelope: envelopeOf(host) },
    });
    return ran.value as Awaited<T>;
  } catch (err) {
    if (!isBlocked(err)) throw err;
    const onDeny = options.onDeny ?? 'return';
    if (onDeny === 'throw') throw err;
    if (typeof onDeny === 'function') return (onDeny as (blocked: Error) => D)(err);
    return refusal(err, toolName) as D;
  } finally {
    runs.delete(callId);
  }
}

/**
 * Put a tool function behind an AGT control (pre/post tool call). The arguments sent
 * are built as for `guard()` (default: the first, input, argument). The wrapped
 * function is async.
 */
export function agtTool<A extends unknown[], R, D = string>(
  control: ControlSource,
  fn: (...args: A) => R,
  options: GovernOptions<D> & { name?: string; args?: (...args: A) => unknown } = {}
): (...args: A) => Promise<Awaited<R> | D> {
  const name = options.name ?? fn.name;
  if (!name) throw new TypeError('darkhunt agt: an anonymous function needs a name');
  const mapArgs = options.args ?? ((...a: A) => defaultArguments(a));
  const governed = (...a: A): Promise<Awaited<R> | D> =>
    runGoverned<R, D>(control, name, mapArgs(...a), () => fn(...a), options) as Promise<
      Awaited<R> | D
    >;
  Object.defineProperty(governed, 'name', { value: name });
  return governed;
}

/**
 * Ask one tool intervention point (`'pre_tool_call'` / `'post_tool_call'`) without
 * running anything, for frameworks that only offer allow/deny hooks. Resolves to the
 * refusal text when the policy denies, else `undefined`.
 */
export async function checkToolPoint(
  control: ControlSource,
  point: 'pre_tool_call' | 'post_tool_call',
  toolName: string,
  args: unknown,
  options: { result?: unknown; host?: Trace | Span } = {}
): Promise<string | undefined> {
  const ctl = resolveControl(control);
  if (!ctl) return undefined;
  const callId = randomUUID().replace(/-/g, '');
  const host = options.host ?? currentObservation();
  runs.set(callId, host);
  const snapshot: Record<string, unknown> = {
    envelope: envelopeOf(host),
    tool_call: { name: toolName, args: jsonSafe(args), id: callId },
  };
  if (point === 'post_tool_call') snapshot.tool_result = jsonSafe(options.result);
  let outcome: Awaited<ReturnType<AgtControl['evaluateInterventionPoint']>>;
  try {
    outcome = await ctl.evaluateInterventionPoint(point as never, snapshot, 'enforce' as never);
  } finally {
    runs.delete(callId);
  }
  if (outcome.verdict.decision !== 'deny') return undefined;
  const message = outcome.verdict.message || outcome.verdict.reason || 'policy';
  return point === 'pre_tool_call'
    ? `Blocked by Darkhunt: ${message}. The ${toolName} tool was not run.`
    : `Withheld by Darkhunt: ${message}. Do not use the output of ${toolName}.`;
}
