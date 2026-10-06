/** What one `/verify` check decided, and the error a blocked call raises. */

/** Where Darkhunt checks: the request, a tool call, its result, or the answer. */
export type Stage = 'INPUT' | 'TOOL_CALL' | 'TOOL_RESULT' | 'OUTPUT';

export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  action: string;
}

export class Verdict {
  constructor(
    readonly tool: string,
    readonly stage: Stage,
    /** `ALLOW` / `DENY`, or `undefined` when Darkhunt did not answer. */
    readonly decision: string | undefined,
    readonly matchedRules: RuleMatch[] = [],
    readonly observedRules: RuleMatch[] = [],
    /** The classifier gave no verdict for a rule that needed one. */
    readonly failed = false,
    readonly error?: string,
    readonly latencyMs = 0,
    readonly sessionId?: string,
    readonly mode = 'shadow',
    /** This check stopped the call (enforce mode, and a DENY or a fail-closed outage). */
    readonly blocked = false
  ) {}

  with(changes: Partial<Pick<Verdict, 'sessionId' | 'mode' | 'blocked'>>): Verdict {
    return new Verdict(
      this.tool,
      this.stage,
      this.decision,
      this.matchedRules,
      this.observedRules,
      this.failed,
      this.error,
      this.latencyMs,
      changes.sessionId ?? this.sessionId,
      changes.mode ?? this.mode,
      changes.blocked ?? this.blocked
    );
  }

  /** A rule denied the call (whether or not it was enforced). */
  get denied(): boolean {
    return this.decision === 'DENY';
  }

  /** Darkhunt did not answer (timeout, network, HTTP error, no tenant). */
  get unanswered(): boolean {
    return this.decision === undefined;
  }

  /** A short human-readable reason: the deciding rule, or why there was no answer. */
  get reason(): string {
    if (this.matchedRules[0]) return this.matchedRules[0].ruleName;
    if (this.unanswered) return `Darkhunt unavailable (${this.error ?? 'no answer'})`;
    if (this.denied) return 'denied by policy';
    return 'allowed';
  }
}

/** What to show in place of whatever `verdict` blocked. */
export function refusal(verdict: Verdict): string {
  switch (verdict.stage) {
    case 'INPUT':
      return `Blocked by Darkhunt: ${verdict.reason}. The request was not processed.`;
    case 'OUTPUT':
      return `Withheld by Darkhunt: ${verdict.reason}. The answer was not shown.`;
    case 'TOOL_CALL':
      return `Blocked by Darkhunt: ${verdict.reason}. The ${verdict.tool} tool was not run.`;
    default:
      return `Withheld by Darkhunt: ${verdict.reason}. The ${verdict.tool} tool ran, but its output was withheld.`;
  }
}

/** Thrown by a guarded tool with `onDeny: 'throw'` when Darkhunt blocks it. */
export class DarkhuntBlockedError extends Error {
  constructor(readonly verdict: Verdict) {
    super(refusal(verdict));
    this.name = 'DarkhuntBlockedError';
  }
}
