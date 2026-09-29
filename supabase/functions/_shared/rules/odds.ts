// Exact odds and money arithmetic. Decimal odds are kept as BigInt fractions
// so a 10-leg parlay is computed exactly and rounded to the cent only once.

export interface Ratio {
  num: bigint;
  den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function ratio(num: bigint, den: bigint): Ratio {
  if (den === 0n) throw new Error("zero denominator");
  if (den < 0n) [num, den] = [-num, -den];
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}

export const ONE: Ratio = { num: 1n, den: 1n };

export function multiply(a: Ratio, b: Ratio): Ratio {
  return ratio(a.num * b.num, a.den * b.den);
}

/** American odds are valid at +100 or more, or -100 or less. */
export function isValidAmerican(odds: number): boolean {
  return Number.isInteger(odds) && Math.abs(odds) >= 100;
}

/** +150 -> 5/2, -110 -> 21/11, +100 or -100 -> 2. */
export function americanToDecimal(odds: number): Ratio {
  if (!isValidAmerican(odds)) throw new Error(`invalid American odds: ${odds}`);
  const a = BigInt(odds);
  return a > 0n ? ratio(100n + a, 100n) : ratio(-a + 100n, -a);
}

/** Decimal odds back to American, rounded to a whole number, for display only. */
export function decimalToAmerican(dec: Ratio): number {
  const d = Number(dec.num) / Number(dec.den);
  if (d >= 2) return Math.round((d - 1) * 100);
  return -Math.round(100 / (d - 1));
}

/**
 * stake x decimal odds, rounded half up to the cent. Throws a RangeError for a payout
 * too big to count exactly in a JavaScript number (about 90 trillion units).
 */
export function payoutCents(stakeCents: number, dec: Ratio): number {
  if (!Number.isSafeInteger(stakeCents) || stakeCents < 0) {
    throw new Error(`stake must be a whole number of cents: ${stakeCents}`);
  }
  const n = BigInt(stakeCents) * dec.num;
  const cents = (2n * n + dec.den) / (2n * dec.den);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("payout too large");
  return Number(cents);
}

export function unitsToCents(units: number): number {
  return Math.round(units * 100);
}

export function centsToUnits(cents: number): number {
  return cents / 100;
}
