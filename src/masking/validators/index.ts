import { aba } from './aba.js';
import { base58check } from './base58check.js';
import { bech32 } from './bech32.js';
import { creditCard } from './creditCard.js';
import { eip55 } from './eip55.js';
import { ibanMod97 } from './ibanMod97.js';
import { luhn } from './luhn.js';

/** A post-match validator: returns true to confirm the regex match should be redacted. */
export type Validator = (match: string) => boolean;

/**
 * Mapping from the schema's {@code validation} enum values to their TypeScript
 * implementations. Keys MUST stay aligned with the enum in
 * {@code @darkhunt-security/masking-schema}'s {@code MaskingRule.validation}.
 */
export const VALIDATORS: Readonly<Record<string, Validator>> = Object.freeze({
  aba,
  base58check,
  bech32,
  credit_card: creditCard,
  eip55,
  iban_mod97: ibanMod97,
  luhn,
});

export { aba, base58check, bech32, creditCard, eip55, ibanMod97, luhn };
