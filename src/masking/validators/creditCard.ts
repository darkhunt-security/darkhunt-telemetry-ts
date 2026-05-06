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
  return (
    isVisa(digits, len) ||
    isMastercard(digits, len) ||
    isAmex(digits, len) ||
    isDiners(digits, len) ||
    isJcb(digits, len) ||
    isDiscover(digits, len)
  );
}

/** Visa: 4XXX, length 13 or 16. */
function isVisa(d: string, len: number): boolean {
  return d.charAt(0) === '4' && (len === 13 || len === 16);
}

/** Mastercard: 51-55 OR 2221-2720, length 16. */
function isMastercard(d: string, len: number): boolean {
  if (len !== 16) return false;
  const d0 = d.charAt(0);
  const d1 = d.charAt(1);
  if (d0 === '5' && d1 >= '1' && d1 <= '5') return true;
  if (d0 === '2') {
    const prefix = Number.parseInt(d.slice(0, 4), 10);
    return prefix >= 2221 && prefix <= 2720;
  }
  return false;
}

/** Amex: 34 or 37, length 15. */
function isAmex(d: string, len: number): boolean {
  if (len !== 15) return false;
  const d1 = d.charAt(1);
  return d.charAt(0) === '3' && (d1 === '4' || d1 === '7');
}

/** Diners: 300-305, 36, or 38, length 14. */
function isDiners(d: string, len: number): boolean {
  if (len !== 14 || d.charAt(0) !== '3') return false;
  const d1 = d.charAt(1);
  if (d1 === '0') {
    const d2 = d.charAt(2);
    return d2 >= '0' && d2 <= '5';
  }
  return d1 === '6' || d1 === '8';
}

/** JCB: 35XX, length 16. */
function isJcb(d: string, len: number): boolean {
  return len === 16 && d.charAt(0) === '3' && d.charAt(1) === '5';
}

/** Discover: 6011, 65, 644-649, or 622126-622925; length 16. */
function isDiscover(d: string, len: number): boolean {
  if (len !== 16 || d.charAt(0) !== '6') return false;
  const d1 = d.charAt(1);
  if (d1 === '0') return d.charAt(2) === '1' && d.charAt(3) === '1';
  if (d1 === '5') return true;
  if (d1 === '4') {
    const d2 = d.charAt(2);
    return d2 >= '4' && d2 <= '9';
  }
  if (d1 === '2') {
    const prefix = Number.parseInt(d.slice(0, 6), 10);
    return prefix >= 622126 && prefix <= 622925;
  }
  return false;
}
