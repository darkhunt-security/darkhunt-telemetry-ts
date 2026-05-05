/**
 * ABA routing number validator: 9 digits, weighted-mod-10 checksum.
 * Weights {@code [3,7,1,3,7,1,3,7,1]} per ABA spec.
 */
const WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7, 1] as const;

export function aba(input: string): boolean {
  const digits = input.replace(/\s/g, '');
  if (digits.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    sum += n * WEIGHTS[i]!;
  }
  return sum % 10 === 0;
}
