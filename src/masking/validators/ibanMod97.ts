/**
 * IBAN validator (ISO 13616 mod-97 check).
 *
 * Strips whitespace, rotates the country+check-digit prefix to the end,
 * substitutes letters as A=10..Z=35, and verifies that the resulting integer
 * mod 97 == 1.
 */
export function ibanMod97(input: string): boolean {
  const iban = input.replace(/\s/g, '');
  const len = iban.length;
  if (len < 15 || len > 34) return false;

  let rearranged = '';
  for (let i = 4; i < len + 4; i++) {
    const c = iban.charCodeAt(i % len);
    if (c >= 48 && c <= 57) {
      rearranged += String.fromCharCode(c);
    } else if (c >= 65 && c <= 90) {
      rearranged += String(c - 65 + 10);
    } else if (c >= 97 && c <= 122) {
      rearranged += String(c - 97 + 10);
    } else {
      return false;
    }
  }

  try {
    return BigInt(rearranged) % 97n === 1n;
  } catch {
    return false;
  }
}
