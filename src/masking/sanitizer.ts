import bundledRules from './rules/rules.json' with { type: 'json' };
import type { MaskingRule, MaskingRulesFile } from './rules/types.js';
import { VALIDATORS, type Validator } from './validators/index.js';

function loadDefaults(): MaskingRulesFile {
  return bundledRules as MaskingRulesFile;
}

/**
 * Operator-defined extra masking rule, merged on top of the bundled defaults.
 * Use {@link DarkhuntTelemetryOptions.mask.customPatterns} to register them.
 */
export interface CustomPattern {
  /** Optional name; surfaced in logs and not part of matching */
  name?: string;
  /** Regex source (will be compiled with `g` and optionally `i` flags). */
  regex: string;
  /** Replacement marker, e.g. `[INTERNAL_ID]`. */
  marker: string;
  /** When false, the pattern is compiled case-insensitively. Defaults to true. */
  caseSensitive?: boolean;
}

interface CompiledRule {
  marker: string;
  pattern: RegExp;
  validator?: Validator;
}

/**
 * Strings shorter than this never match anything in the ruleset (the shortest
 * rule is well above this floor) — short-circuit early to avoid the per-rule
 * regex loop on every trivial value.
 */
const MIN_INPUT_LENGTH = 6;

function compileRules(
  rules: readonly MaskingRule[],
  customPatterns: readonly CustomPattern[]
): CompiledRule[] {
  const compiled: CompiledRule[] = [];

  for (const rule of rules) {
    const flags = rule.caseSensitive === false ? 'gi' : 'g';
    let validator: Validator | undefined;
    if (rule.validation) {
      validator = VALIDATORS[rule.validation];
      if (!validator) {
        // Fail-closed: unknown validators mean we can't enforce the rule
        // safely (regex alone over-matches). Drop and warn.
        console.warn(
          `[darkhunt-telemetry] Skipping masking rule "${rule.name}": ` +
            `validator "${rule.validation}" is not implemented in this SDK version. ` +
            `Upgrade @darkhunt-security/telemetry to enforce this rule.`
        );
        continue;
      }
    }
    compiled.push({
      marker: rule.marker,
      pattern: new RegExp(rule.pattern, flags),
      validator,
    });
  }

  for (const cp of customPatterns) {
    const flags = cp.caseSensitive === false ? 'gi' : 'g';
    compiled.push({
      marker: cp.marker,
      pattern: new RegExp(cp.regex, flags),
    });
  }

  return compiled;
}

/**
 * Compiled, ordered list of masking rules with a fast {@link sanitize} method.
 *
 * Construct once per process (typically by {@code DarkhuntTelemetry}) and
 * share across traces — pattern compilation runs in the constructor and the
 * resulting object is read-only and concurrency-safe.
 */
export class Sanitizer {
  private readonly rules: CompiledRule[];
  /** Ruleset version stamped into the bundled YAML — useful for support. */
  readonly rulesetVersion: string;

  /**
   * @param rulesFile Defaults to the YAML ruleset vendored under
   *                  {@code src/masking/rules/data-masking-rules.yaml} and
   *                  parsed at SDK build time into {@code rules.json}.
   * @param customPatterns Operator-defined extras appended after the defaults.
   */
  constructor(rulesFile?: MaskingRulesFile, customPatterns: readonly CustomPattern[] = []) {
    const file = rulesFile ?? loadDefaults();
    this.rulesetVersion = file.version;
    this.rules = compileRules(file.rules, customPatterns);
  }

  /** Apply every rule in declared order; return the redacted string. */
  sanitize(input: string): string {
    if (input.length < MIN_INPUT_LENGTH) return input;
    let result = input;
    for (const rule of this.rules) {
      if (rule.validator) {
        const validator = rule.validator;
        result = result.replace(rule.pattern, (match) => (validator(match) ? rule.marker : match));
      } else {
        result = result.replace(rule.pattern, rule.marker);
      }
    }
    return result;
  }

  /**
   * Recursively sanitize the string leaves of any structured value (object,
   * array, primitive). Non-string leaves (numbers, booleans, nulls) are
   * returned unchanged. Used for input/output payloads and metadata values
   * that may arrive as strings, arrays of chat messages, or arbitrary JSON.
   */
  sanitizeUnknown(value: unknown): unknown {
    if (typeof value === 'string') return this.sanitize(value);
    if (Array.isArray(value)) return value.map((v) => this.sanitizeUnknown(v));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.sanitizeUnknown(v);
      }
      return out;
    }
    return value;
  }
}
