/**
 * Bech32 / Bech32m validator (BIP-173 / BIP-350).
 *
 * Decodes the human-readable-part + data + 6-character checksum, runs the
 * polymod, and accepts either the Bech32 constant (1) or the Bech32m
 * constant (0x2bc830a3). Mixed-case input is rejected per spec.
 */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

export function bech32(input: string): boolean {
  if (input.length > 90) return false;
  const lower = input.toLowerCase();
  const upper = input.toUpperCase();
  // Spec: must be all-lowercase or all-uppercase, never mixed
  if (input !== lower && input !== upper) return false;

  const sepIdx = lower.lastIndexOf('1');
  if (sepIdx < 1 || sepIdx + 7 > lower.length) return false;

  const hrp = lower.slice(0, sepIdx);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) return false;
  }

  const data: number[] = [];
  for (let i = sepIdx + 1; i < lower.length; i++) {
    const idx = CHARSET.indexOf(lower.charAt(i));
    if (idx === -1) return false;
    data.push(idx);
  }

  const checksum = polymod(hrpExpand(hrp).concat(data));
  return checksum === BECH32_CONST || checksum === BECH32M_CONST;
}
