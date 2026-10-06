/**
 * `guard(fn)` — ask Darkhunt before a tool runs, and before its output is used.
 *
 * A guarded call makes up to two checks against the guardrail manager's `/verify`:
 *
 * - `TOOL_CALL`, with the arguments, before the function runs. A block means the
 *   function never runs.
 * - `TOOL_RESULT`, with what it returned (`after: true`, the default), before the caller
 *   sees it. A block means the function ran but its output is withheld.
 *
 * Each check is recorded as a `guardrail` span under the tool's span. The tool span is
 * the current one when the caller already opened it for this tool (it is reused, not
 * nested), otherwise the guard opens one under the current run. Outside any run the
 * checks still happen — routed by the guard configuration — but nothing is recorded.
 *
 * It wraps the function itself, so it works wherever the function is called from: wrap
 * the function you hand to your framework's tool helper.
 *
 *     const sendReferral = tool({ ..., execute: guard(async function sendReferral(input) { ... }) });
 */

import { context as otContext } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import { currentObservation } from '../current.js';
import { Span } from '../span.js';
import type { Trace } from '../trace.js';
import { check, jsonSafe } from './check.js';
import { getGuardConfig, type GuardConfig } from './config.js';
import { DarkhuntBlockedError, refusal, Verdict } from './verdict.js';

export type OnDeny<D> = 'return' | 'throw' | ((verdict: Verdict) => D);

export interface GuardOptions<A extends unknown[], D> {
  /** The tool name rules match on (`toolName==…`). Default: the function's name. */
  name?: string;
  /** Also check the result before returning it. Default `true`. */
  after?: boolean;
  /**
   * What the caller gets when a check blocks: `'return'` (default) a refusal string the
   * model can read; `'throw'` a {@link DarkhuntBlockedError}; a function — its return
   * value, given the {@link Verdict} (e.g. `() => []` for a pipeline that can go on).
   */
  onDeny?: OnDeny<D>;
  /**
   * The arguments sent for checking, built from the call's arguments. Default: the
   * first argument when it is a plain object (the usual tool-input shape — later
   * arguments are typically framework context), `{}` for no arguments, else
   * `{ args: [...] }`.
   */
  args?: (...args: A) => unknown;
  /** A configuration (or a function returning one) instead of the process-wide one. */
  config?: GuardConfig | (() => GuardConfig);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The default argument mapping — see {@link GuardOptions.args}. */
export function defaultArguments(args: unknown[]): unknown {
  if (isPlainObject(args[0])) return args[0];
  if (args.length === 0) return {};
  return { args };
}

/**
 * Guard a tool function. The guarded function is always async (the checks are network
 * calls) and resolves to the tool's result — or, when a check blocks, to what
 * `onDeny` says.
 */
export function guard<A extends unknown[], R, D = string>(
  fn: (...args: A) => R,
  options: GuardOptions<A, D> = {}
): (...args: A) => Promise<Awaited<R> | D> {
  if (typeof fn !== 'function') {
    throw new TypeError('darkhunt guard: guard() needs a function');
  }
  const name = options.name ?? fn.name;
  if (!name) {
    throw new TypeError(
      'darkhunt guard: an anonymous function needs a name — guard(fn, { name: "send_referral" })'
    );
  }
  const after = options.after ?? true;
  const onDeny: OnDeny<D> = options.onDeny ?? 'return';
  const mapArgs = options.args ?? ((...a: A) => defaultArguments(a));
  const resolveConfig = (): GuardConfig => {
    const c = options.config;
    if (c === undefined) return getGuardConfig();
    return typeof c === 'function' ? c() : c;
  };

  const guarded = async (...a: A): Promise<Awaited<R> | D> => {
    const config = resolveConfig();
    if (config.mode === 'off') return await fn(...a);
    const args = jsonSafe(mapArgs(...a));
    const host = currentObservation();
    const reuse = host instanceof Span && host.observationType === 'tool' && host.toolName === name;
    const toolSpan: Span | undefined =
      host === undefined
        ? undefined
        : reuse
          ? (host as Span)
          : (host as Trace | Span).span(name, {
              observationType: 'tool',
              toolName: name,
              toolArguments: args,
            });
    const opened = toolSpan !== undefined && !reuse;
    const callId = toolSpan?.otel.spanContext().spanId ?? randomUUID().replace(/-/g, '');

    const refuse = (v: Verdict): D => {
      if (onDeny === 'throw') throw new DarkhuntBlockedError(v);
      const value = (typeof onDeny === 'function' ? onDeny(v) : refusal(v)) as D;
      if (opened) toolSpan.update({ output: value });
      return value;
    };
    const ask = (stage: 'TOOL_CALL' | 'TOOL_RESULT', result?: unknown): Promise<Verdict> =>
      check({ config, host, recordUnder: toolSpan, stage, tool: name, callId, args, result });

    const run = async (): Promise<Awaited<R> | D> => {
      const pre = await ask('TOOL_CALL');
      if (pre.blocked) return refuse(pre);
      const result = await fn(...a);
      if (after) {
        const post = await ask('TOOL_RESULT', result);
        if (post.blocked) return refuse(post);
      }
      if (opened) toolSpan.update({ output: result });
      return result;
    };

    if (toolSpan === undefined) return await run();
    try {
      // The tool span is active while the tool runs, so its own spans nest under it.
      return await otContext.with(toolSpan.context, run);
    } catch (err) {
      if (opened) {
        toolSpan.end({
          level: 'ERROR',
          statusMessage: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      if (opened) toolSpan.end();
    }
  };
  Object.defineProperty(guarded, 'name', { value: name });
  return guarded;
}
