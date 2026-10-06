/**
 * Ask Darkhunt about a request before the agent sees it, and an answer before the
 * user does.
 *
 * {@link checkInput} sends the request to `/verify` at the `INPUT` stage and
 * {@link checkOutput} sends the answer at `OUTPUT`. They decide as {@link guard} does
 * for a tool call — same mode, fail mode, routing and `onVerdict` hook — but stopping
 * the work is the caller's job, since only the caller knows what "don't run the agent"
 * or "don't show the answer" means:
 *
 * ```ts
 * const verdict = await checkInput(request);
 * if (verdict.blocked) return refusal(verdict); // the agent never sees the request
 * const answer = await runAgent(request);
 * const out = await checkOutput(answer);
 * return out.blocked ? refusal(out) : answer;
 * ```
 *
 * Each check is recorded as a `guardrail` span under the current trace or span.
 */

import { currentObservation } from '../current.js';
import { blocks, recordVerdict, traceOf, warnOnce } from './check.js';
import { verify } from './client.js';
import { getGuardConfig, type GuardConfig } from './config.js';
import { Verdict, type Stage } from './verdict.js';

/** One message to check. `role` defaults to `user` for input, `assistant` for output. */
export interface ContentMessage {
  role?: string;
  content: string;
}

/** The text to check, or messages when context matters. */
export type Content = string | ContentMessage[];

export interface ContentCheckOptions {
  /**
   * The session to file the check under when there is no current trace (a gateway
   * checking a run it has already handed off). Inside a trace, the trace's is used.
   */
  sessionId?: string;
  /** A configuration (or a function returning one) instead of the process-wide one. */
  config?: GuardConfig | (() => GuardConfig);
}

function capped(text: string, limit: number): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= limit) return text;
  // A content rule sees the first `limit` bytes; say so rather than send nothing.
  const head = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
  return `${head}\n[truncated: ${bytes} bytes]`;
}

function messages(content: Content, role: string, limit: number): ContentMessage[] {
  if (typeof content === 'string') return [{ role, content: capped(content, limit) }];
  return content.map((m) => ({ role: m.role || role, content: capped(m.content ?? '', limit) }));
}

async function checkContent(
  stage: Stage,
  content: Content,
  role: string,
  options: ContentCheckOptions
): Promise<Verdict> {
  const c = options.config;
  const config = c === undefined ? getGuardConfig() : typeof c === 'function' ? c() : c;
  if (config.mode === 'off') return new Verdict('', stage, undefined).with({ mode: 'off' });
  const host = currentObservation();
  const trace = traceOf(host);
  const tenant = trace?.tenantId || config.tenantId;
  const body: Record<string, unknown> = {
    stage,
    workspaceId: trace?.workspaceId || config.workspaceId,
    applicationId: trace?.applicationId || config.applicationId,
    sessionId: options.sessionId || trace?.sessionId,
    userId: trace?.userId,
    userEmail: trace?.userEmail,
    source: config.source ?? trace?.agent,
    messages: messages(content, role, config.maxResultBytes),
  };
  for (const key of Object.keys(body)) if (!body[key]) delete body[key];

  const g = host?.span(`darkhunt.guard.${stage.toLowerCase()}`, {
    observationType: 'guardrail',
    input: body.messages,
  });
  let verdict: Verdict;
  if (!tenant) {
    warnOnce('no-tenant', 'darkhunt guard: no tenant id (DARKHUNT_TENANT_ID); checks are skipped');
    verdict = new Verdict('', stage, undefined, [], [], false, 'no tenant configured');
  } else {
    // Content is classified by a model, so it gets the result budget, not the tight
    // one a tool call gets.
    verdict = await verify(config, tenant, body, config.resultTimeoutMs);
  }
  verdict = verdict.with({
    mode: config.mode,
    blocked: blocks(config, verdict),
    sessionId: body.sessionId as string | undefined,
  });
  recordVerdict(g, undefined, verdict);
  if (config.onVerdict) {
    try {
      config.onVerdict(verdict);
    } catch (err) {
      warnOnce('hook', `darkhunt guard: onVerdict threw: ${String(err)}`);
    }
  }
  return verdict;
}

/**
 * Check a request (`INPUT`) before the agent sees it. Act on `verdict.blocked`.
 *
 * @param content The request text, or `{ role, content }` messages when context matters.
 */
export function checkInput(content: Content, options: ContentCheckOptions = {}): Promise<Verdict> {
  return checkContent('INPUT', content, 'user', options);
}

/** Check an answer (`OUTPUT`) before the user sees it. Act on `verdict.blocked`. */
export function checkOutput(content: Content, options: ContentCheckOptions = {}): Promise<Verdict> {
  return checkContent('OUTPUT', content, 'assistant', options);
}
