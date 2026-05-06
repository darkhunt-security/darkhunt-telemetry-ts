/**
 * Types describing the bundled masking ruleset shape. Mirrors the JSON Schema
 * at api-contract/contracts/schemas/masking/{MaskingRule,MaskingRulesFile}.json
 * — kept in sync manually when the schema evolves. The CI drift check
 * (scripts/check-rules-drift.sh, if present) flags YAML mismatches against
 * the upstream api-contract version.
 */

/** A post-match validator name. SDKs that don't implement it MUST drop the rule (fail-closed). */
export type Validator =
  | 'luhn'
  | 'credit_card'
  | 'aba'
  | 'iban_mod97'
  | 'base58check'
  | 'bech32'
  | 'eip55';

/** A single data-masking rule: regex + marker + optional validator. */
export interface MaskingRule {
  /** Stable rule identifier (snake_case), e.g. `email`, `openai_key`, `iban`. */
  name: string;
  /** Human-readable description of what the rule detects. */
  description: string;
  /** Replacement string substituted in place of every match, e.g. `[EMAIL]`. */
  marker: string;
  /** Regex pattern (ECMA / RE2-safe). */
  pattern: string;
  /** When false, the pattern is compiled with case-insensitive matching. Defaults to true. */
  caseSensitive?: boolean;
  /** Optional named post-match validator (Luhn, IBAN mod-97, etc.). */
  validation?: Validator;
  /** Sample strings the rule should match — used by the data-driven coverage test. */
  examples?: string[];
}

/** Top-level shape of data-masking-rules.yaml: a versioned, ordered list of rules. */
export interface MaskingRulesFile {
  /** Calendar-versioned ruleset identifier (YYYY.M.D), stamped at publish time. */
  version: string;
  /**
   * Ordered list of masking rules. Order is load-bearing — earlier rules
   * match first (see comments in data-masking-rules.yaml for cases where
   * ordering is required for correctness, e.g. IPv6 before MAC).
   */
  rules: MaskingRule[];
}
