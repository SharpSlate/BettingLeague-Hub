import { americanToDecimal, decimalToAmerican, multiply, ONE, payoutCents, type Ratio } from "./odds.ts";
import type { Leg, Market, RuleSet, SlipInput } from "./types.ts";

/** The price a straight or parlay leg pays, given the book's price and the pricing rule. */
export function effectivePrice(market: Market, bookPrice: number, rules: RuleSet): number {
  if (rules.pricing.straight === "flat" && market !== "moneyline") return rules.pricing.flatPrice;
  return bookPrice;
}

/** The table price for a teaser, or null if the table has no entry. */
export function teaserPrice(rules: RuleSet, points: number, legs: number): number | null {
  const row = rules.betTypes.teaser.prices[String(points)];
  const price = row?.[String(legs)];
  return price === undefined ? null : price;
}

/** Moves a leg's point by the teaser points in the bettor's favor. */
export function teasedPoint(leg: Leg, points: number): number {
  if (leg.point === null || leg.market === "moneyline") throw new Error("a moneyline can't be teased");
  if (leg.market === "spread") return leg.point + points;
  return leg.side === "over" ? leg.point - points : leg.point + points;
}

export interface Quote {
  decimal: Ratio;
  /** American odds for the whole slip (rounded for parlays). */
  american: number;
  /** Stake plus winnings if the slip wins as placed. */
  payoutCents: number;
}

/** Prices a slip as placed. Call validateSlip first; this throws on an unpriceable slip. */
export function quoteSlip(slip: SlipInput, rules: RuleSet): Quote {
  if (slip.type === "teaser") {
    const price = teaserPrice(rules, slip.teaserPoints ?? NaN, slip.legs.length);
    if (price === null) throw new Error("no teaser price for this slip");
    const decimal = americanToDecimal(price);
    return { decimal, american: price, payoutCents: payoutCents(slip.stakeCents, decimal) };
  }
  const decimal = slip.legs.reduce<Ratio>((acc, leg) => multiply(acc, americanToDecimal(leg.price)), ONE);
  const american = slip.type === "straight" && slip.legs.length === 1 ? slip.legs[0]!.price : decimalToAmerican(decimal);
  return { decimal, american, payoutCents: payoutCents(slip.stakeCents, decimal) };
}
