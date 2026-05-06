import { keccak_256 } from '@noble/hashes/sha3';

/**
 * Ethereum address checksum (EIP-55).
 *
 * Accepts: well-formed 0x-prefixed 40-hex addresses that are either all
 * lowercase, all uppercase, or mixed-case where the case pattern matches
 * keccak256(lowercase-address) per EIP-55.
 */
const ADDR_RE = /^0[xX][0-9a-fA-F]{40}$/;

export function eip55(input: string): boolean {
  if (!ADDR_RE.test(input)) return false;
  const addr = input.slice(2);
  const lower = addr.toLowerCase();
  // All lowercase or all uppercase has no case pattern to verify per EIP-55.
  if (addr === lower || addr === addr.toUpperCase()) return true;
  return matchesChecksum(addr, lower);
}

/** For each hex char, verify its case matches the keccak256(lower) bit at that position. */
function matchesChecksum(addr: string, lower: string): boolean {
  const hashBytes = keccak_256(lower);
  for (let i = 0; i < 40; i++) {
    if (!charCaseMatchesNibble(addr.charCodeAt(i), nibbleAt(hashBytes, i))) {
      return false;
    }
  }
  return true;
}

/** Extract the i-th hex nibble of a byte array (i=0 → high nibble of byte 0, i=1 → low nibble, …). */
function nibbleAt(bytes: Uint8Array, i: number): number {
  return (bytes[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
}

/**
 * EIP-55 case rule for one position:
 *   - hex letter a-f → nibble must be < 8 (hash bit clear ⇒ lowercase)
 *   - hex letter A-F → nibble must be ≥ 8 (hash bit set   ⇒ uppercase)
 *   - digit 0-9      → no case constraint
 */
function charCaseMatchesNibble(ch: number, nibble: number): boolean {
  if (ch >= 97 /* 'a' */ && ch <= 102 /* 'f' */) return nibble < 8;
  if (ch >= 65 /* 'A' */ && ch <= 70 /* 'F' */) return nibble >= 8;
  return true;
}
