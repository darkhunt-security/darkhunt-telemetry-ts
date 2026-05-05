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
  const upper = addr.toUpperCase();

  // All lowercase or all uppercase is acceptable per EIP-55 (no checksum to verify)
  if (addr === lower || addr === upper) return true;

  // Mixed case: each hex char's case must match keccak256(lowercase) bit pattern
  const hashBytes = keccak_256(lower);
  for (let i = 0; i < 40; i++) {
    const ch = addr.charCodeAt(i);
    if (ch >= 97 /* 'a' */ && ch <= 102 /* 'f' */) {
      // Must be lowercase → corresponding nibble < 8
      const nibble = (hashBytes[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
      if (nibble >= 8) return false;
    } else if (ch >= 65 /* 'A' */ && ch <= 70 /* 'F' */) {
      // Must be uppercase → corresponding nibble >= 8
      const nibble = (hashBytes[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
      if (nibble < 8) return false;
    }
  }
  return true;
}
