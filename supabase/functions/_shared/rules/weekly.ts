// The weekly minimum: each week an entry must wager at least pct% of its bank
// at the start of the week, rounded up to a whole unit. Any shortfall comes off
// the bank when the week closes, but never takes the bank below zero.

/** ceil(pct% of the bank) in whole units, returned in cents. */
export function requiredMinimumCents(bankAtStartCents: number, pct: number): number {
  if (bankAtStartCents <= 0 || pct <= 0) return 0;
  const bps = Math.round(pct * 100); // 30% -> 3000
  const units = Math.ceil((bankAtStartCents * bps) / 1_000_000);
  return units * 100;
}

export function shortfallCents(requiredCents: number, wageredCents: number): number {
  return Math.max(0, requiredCents - wageredCents);
}

/** The deduction actually taken: the shortfall, capped at what the entry has available. */
export function deductionCents(shortfall: number, availableCents: number): number {
  return Math.min(shortfall, Math.max(0, availableCents));
}
