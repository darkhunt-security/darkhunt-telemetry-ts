/**
 * Luhn (mod-10) checksum validator.
 *
 * Returns true when the digits-only projection of `input` (spaces and dashes
 * stripped) passes the Luhn algorithm. Used as the post-match validator for
 * the {@code luhn} entry in the masking ruleset and as a building block for
 * {@link creditCard}.
 */
export function luhn(input: string): boolean {
  let sum = 0;
  let alternate = false;
  let len = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    const ch = input.charCodeAt(i);
    if (ch === 32 /* space */ || ch === 45 /* '-' */) continue;
    const digit = ch - 48;
    if (digit < 0 || digit > 9) return false;
    let n = digit;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
    len++;
  }
  return len > 0 && sum % 10 === 0;
}
