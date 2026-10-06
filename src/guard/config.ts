/** Guard configuration: explicit options > environment > defaults. */

import type { Verdict } from './verdict.js';

export type GuardMode = 'enforce' | 'shadow' | 'off';
export type FailMode = 'open' | 'closed';

/** The public guardrail-manager route behind the Darkhunt API gateway. */
export const DEFAULT_GUARD_URL = 'https://api.darkhunt.ai/guardrail-manager';

export interface GuardConfig {
  /** Guardrail manager base URL; `/api/t/{tenant}/verify` is appended. */
  url: string;
  apiKey?: string;
  /** Routing fallbacks, used when the current run (trace) does not carry them. */
  tenantId?: string;
  workspaceId?: string;
  applicationId?: string;
  /**
   * `enforce` blocks on a DENY; `shadow` checks and records but never blocks
   * ("Would block (shadow)"); `off` makes no calls.
   */
  mode: GuardMode;
  /** What `enforce` does when Darkhunt does not answer. Required for `enforce`. */
  fail?: FailMode;
  /** Timeout for the check before a tool runs (`TOOL_CALL`). */
  callTimeoutMs: number;
  /** Timeout for the check on a tool's result (`TOOL_RESULT`). */
  resultTimeoutMs: number;
  /** Results larger than this (UTF-8 JSON bytes) are sent truncated. */
  maxResultBytes: number;
  /** Extra request headers. */
  headers: Record<string, string>;
  /** Overrides the `source` sent with each check (default: the trace's agent). */
  source?: string;
  /** Called with every verdict — e.g. to add blocks to the run's own result. */
  onVerdict?: (verdict: Verdict) => void;
}

export type GuardConfigOptions = Partial<GuardConfig>;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && env(name) !== undefined ? value : fallback;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function validated(config: GuardConfig): GuardConfig {
  if (!['enforce', 'shadow', 'off'].includes(config.mode)) {
    throw new Error(`darkhunt guard: unknown mode ${JSON.stringify(config.mode)}`);
  }
  if (config.fail !== undefined && !['open', 'closed'].includes(config.fail)) {
    throw new Error(`darkhunt guard: unknown fail mode ${JSON.stringify(config.fail)}`);
  }
  if (config.mode === 'enforce' && config.fail === undefined) {
    throw new Error(
      'darkhunt guard: enforce mode needs a fail mode — set DARKHUNT_GUARD_FAIL ' +
        "(open|closed) or pass fail: 'open' | 'closed'"
    );
  }
  return config;
}

/** Read the configuration from the environment, then apply `overrides`. */
export function guardConfigFromEnv(overrides: GuardConfigOptions = {}): GuardConfig {
  const fromEnv: GuardConfig = {
    url: (env('DARKHUNT_GUARD_URL') ?? DEFAULT_GUARD_URL).replace(/\/+$/, ''),
    apiKey: env('DARKHUNT_API_KEY'),
    tenantId: env('DARKHUNT_TENANT_ID'),
    workspaceId: env('DARKHUNT_WORKSPACE_ID'),
    applicationId: env('DARKHUNT_APPLICATION_ID'),
    mode: (env('DARKHUNT_GUARD_MODE') ?? 'shadow').toLowerCase() as GuardMode,
    fail: env('DARKHUNT_GUARD_FAIL')?.toLowerCase() as FailMode | undefined,
    callTimeoutMs: envNumber('DARKHUNT_GUARD_TIMEOUT_CALL', 1.5) * 1000,
    resultTimeoutMs: envNumber('DARKHUNT_GUARD_TIMEOUT_RESULT', 5) * 1000,
    maxResultBytes: envNumber('DARKHUNT_GUARD_MAX_RESULT', 64 * 1024),
    headers: parseHeaders(env('DARKHUNT_GUARD_HEADERS')),
  };
  const set = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return validated({ ...fromEnv, ...set });
}

let current: GuardConfig | undefined;

/**
 * Set the process-wide guard configuration: the environment plus `overrides`
 * (`undefined` values are ignored). Returns the resulting configuration.
 */
export function configureGuard(overrides: GuardConfigOptions = {}): GuardConfig {
  current = guardConfigFromEnv(overrides);
  return current;
}

/** The process-wide configuration, read from the environment on first use. */
export function getGuardConfig(): GuardConfig {
  current ??= guardConfigFromEnv();
  return current;
}

/** Forget the configuration so the next use re-reads the environment (tests). */
export function resetGuardConfig(): void {
  current = undefined;
}
