import { luhn } from './luhn.js';

/**
 * Credit-card validator: Luhn-passing AND length matches a known IIN range.
 *
 * Necessary as a separate validator from plain {@link luhn} because many
 * non-card identifiers (e.g. IMEI) also Luhn-pass — the IIN range gate
 * eliminates false positives where a 15- or 16-digit value happens to
 * checksum but isn't actually a card.
 */
export function creditCard(input: string): boolean {
  const digits = input.replace(/[\s-]/g, '');
  return digits.length >= 13 && digits.length <= 16 && hasValidIin(digits) && luhn(digits);
}

function hasValidIin(digits: string): boolean {
  const len = digits.length;
  if (len < 13) return false;
  const d0 = digits.charAt(0);
  const d1 = digits.charAt(1);

  // Visa: 4XXX, length 13 or 16
  if (d0 === '4') return len === 13 || len === 16;

  // Mastercard: 51-55, length 16
  if (d0 === '5' && d1 >= '1' && d1 <= '5') return len === 16;

  // Mastercard 2-series: 2221-2720, length 16
  if (d0 === '2' && len === 16) {
    const prefix = parseInt(digits.slice(0, 4), 10);
    return prefix >= 2221 && prefix <= 2720;
  }

  // Amex: 34 or 37, length 15
  if (d0 === '3' && (d1 === '4' || d1 === '7')) return len === 15;

  // Diners: 300-305, length 14
  if (d0 === '3' && d1 === '0') {
    const d2 = digits.charAt(2);
    return d2 >= '0' && d2 <= '5' && len === 14;
  }

  // Diners: 36 or 38, length 14
  if (d0 === '3' && (d1 === '6' || d1 === '8')) return len === 14;

  // JCB: 35XX, length 16
  if (d0 === '3' && d1 === '5') return len === 16;

  // Discover: 6011, length 16
  if (d0 === '6' && d1 === '0' && digits.charAt(2) === '1' && digits.charAt(3) === '1')
    return len === 16;

  // Discover: 65, length 16
  if (d0 === '6' && d1 === '5') return len === 16;

  // Discover: 644-649, length 16
  if (d0 === '6' && d1 === '4') {
    const d2 = digits.charAt(2);
    return d2 >= '4' && d2 <= '9' && len === 16;
  }

  // Discover: 622126-622925, length 16
  if (d0 === '6' && d1 === '2' && len === 16) {
    const prefix6 = parseInt(digits.slice(0, 6), 10);
    return prefix6 >= 622126 && prefix6 <= 622925;
  }

  return false;
}
