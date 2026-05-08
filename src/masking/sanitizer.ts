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
 * Zero-width characters (ZWSP, ZWNJ, ZWJ, BOM) that an attacker or careless
 * serializer can splice between the bytes of a secret to defeat the masking
 * regex — e.g. `sk-proj-<U+200B>1234…` would otherwise sneak through. Strip
 * them before the rule loop. Lossy on the ZWS bytes themselves, by design;
 * they are not visible in any UI.
 */
const ZERO_WIDTH_CHARS = /\u200B|\u200C|\u200D|\uFEFF/g;

/**
 * Reject the well-known catastrophic-backtracking shapes — a greedy class
 * (`.`, `\w`, `\d`, `\s`, `\S`) with `+` or `*` inside a group that itself
 * has `+` or `*`. Catches `(.+)+`, `(\w+)+`, `(\d*)+`, `(.*)+`, `(\S+)*`.
 *
 * Narrower than a full AST analysis on purpose: a heuristic that fires on
 * benign shapes like `(\d+\.)+\d+` would be worse than letting the operator
 * vet their own pattern.
 */
function assertNotPathological(regex: string, name?: string): void {
  const greedyClassQuantified = /\((?:\.|\\[wdsSW])[+*]\)[+*]/;
  if (greedyClassQuantified.test(regex)) {
    throw new Error(
      `[darkhunt-telemetry] Custom masking pattern${name ? ` "${name}"` : ''} ` +
        `contains a nested-quantifier shape that can cause catastrophic ` +
        `backtracking on adversarial inputs (regex: ${regex}). ` +
        `Rewrite without nested quantifiers, or use possessive/atomic groups.`
    );
  }
  const overlappingAlternation = /\((\w)\|\1\)[+*]/;
  if (overlappingAlternation.test(regex)) {
    throw new Error(
      `[darkhunt-telemetry] Custom masking pattern${name ? ` "${name}"` : ''} ` +
        `contains overlapping alternation that can cause catastrophic ` +
        `backtracking (regex: ${regex}).`
    );
  }
}

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
    assertNotPathological(cp.regex, cp.name);
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
    if (input.length === 0) return input;
    // Strip zero-width chars first so a spliced ZWS can't bypass the rule
    // regexes (e.g. a U+200B between bytes of an OpenAI key would sneak through).
    let result = input.replace(ZERO_WIDTH_CHARS, '');
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
   * array, primitive). Strings, numbers (stringified, run through rules,
   * kept as number when no pattern matches), and object KEYS are sanitized.
   * Booleans, nulls, BigInts, Symbols, and functions pass through untouched.
   *
   * Cycle-safe: object/array values that have already been visited in this
   * walk are returned as the placeholder `"[circular]"` instead of recursing.
   */
  sanitizeUnknown(value: unknown): unknown {
    return this.walk(value, new WeakSet());
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.sanitize(value);
    if (typeof value === 'number') {
      const s = String(value);
      // Only stringified digit-ranges plausible for SSN/phone/CC/account
      // numbers can match a rule; everything else (small counters, large
      // floats, NaN/Infinity) bypasses the rule loop and returns as-is.
      if (s.length < 7 || s.length > 19) return value;
      const masked = this.sanitize(s);
      return masked === s ? value : masked;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      return value.map((v) => this.walk(v, seen));
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value as object)) return '[circular]';
      seen.add(value as object);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Sanitize keys too: a secret used as a key (e.g. `{ [email]: 1 }`)
        // would otherwise reach the wire verbatim.
        out[this.sanitize(k)] = this.walk(v, seen);
      }
      return out;
    }
    return value;
  }
}
