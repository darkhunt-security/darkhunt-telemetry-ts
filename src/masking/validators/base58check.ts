import { sha256 } from '@noble/hashes/sha256';

/**
 * Base58Check validator (Bitcoin P2PKH/P2SH-style addresses).
 *
 * Decodes the Base58 string, splits the trailing 4-byte checksum, and
 * verifies that the first 4 bytes of double-SHA-256 over the payload match.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = 58n;

export function base58check(input: string): boolean {
  if (input.length === 0) return false;

  // Count leading '1's — each maps to a leading zero byte after decoding
  let leadingOnes = 0;
  while (leadingOnes < input.length && input.charAt(leadingOnes) === '1') {
    leadingOnes++;
  }

  // Decode rest as base58 → bigint
  let num = 0n;
  for (let i = 0; i < input.length; i++) {
    const idx = ALPHABET.indexOf(input.charAt(i));
    if (idx === -1) return false;
    num = num * BASE + BigInt(idx);
  }

  // bigint → byte array (big-endian)
  const bodyBytes: number[] = [];
  while (num > 0n) {
    bodyBytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  const bytes = new Uint8Array(leadingOnes + bodyBytes.length);
  for (let i = 0; i < bodyBytes.length; i++) bytes[leadingOnes + i] = bodyBytes[i]!;

  if (bytes.length < 5) return false;

  const payload = bytes.subarray(0, bytes.length - 4);
  const checksum = bytes.subarray(bytes.length - 4);
  const hash = sha256(sha256(payload));

  for (let i = 0; i < 4; i++) {
    if (hash[i] !== checksum[i]) return false;
  }
  return true;
}
