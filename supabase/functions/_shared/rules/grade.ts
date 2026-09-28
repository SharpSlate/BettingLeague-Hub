import { americanToDecimal, multiply, ONE, payoutCents, type Ratio } from "./odds.ts";
import { teasedPoint, teaserPrice } from "./price.ts";
import type { BetType, FinalScore, Leg, LegResult, RuleSet, SlipResult } from "./types.ts";

/** Points are whole or half, so grading compares doubled integers to avoid rounding. */
const h = (x: number) => Math.round(x * 2);

/**
 * Grades one leg from a final score, or "void" when the game was voided.
 * Teaser legs are moved by the teaser points first.
 */
export function gradeLeg(leg: Leg, score: FinalScore | "void", teaserPoints?: number | null): Exclude<LegResult, "pending"> {
  if (score === "void") return "void";
  const { homeScore: home, awayScore: away } = score;
  let diff: number;
  if (leg.market === "moneyline") {
    diff = leg.side === "home" ? home - away : away - home;
  } else {
    const point = teaserPoints ? teasedPoint(leg, teaserPoints) : leg.point!;
    if (leg.market === "spread") {
      diff = leg.side === "home" ? h(home) + h(point) - h(away) : h(away) + h(point) - h(home);
    } else {
      const total = h(home + away);
      diff = leg.side === "over" ? total - h(point) : h(point) - total;
    }
  }
  return diff > 0 ? "won" : diff === 0 ? "push" : "lost";
}

export interface GradableSlip {
  type: BetType;
  stakeCents: number;
  teaserPoints?: number | null;
  legs: Leg[];
}

export interface Grade {
  result: SlipResult;
  /** What the slip returns to the bank: stake plus winnings, the stake alone, or 0. */
  payoutCents: number;
}

/**
 * Settles a slip from its legs' results under the rule set it was placed with.
 * A multi-leg slip loses as soon as any leg loses; otherwise it waits for every leg.
 * Void legs (a voided game) always drop out and the slip is repriced on what's left.
 * Pushed teaser legs follow the rule set's teaser push rule.
 */
export function gradeSlip(slip: GradableSlip, results: LegResult[], rules: RuleSet): Grade {
  if (results.length !== slip.legs.length) throw new Error("one result per leg");
  const stake = slip.stakeCents;
  const refund = (result: SlipResult): Grade => ({ result, payoutCents: stake });
  const lost: Grade = { result: "lost", payoutCents: 0 };
  const pending: Grade = { result: "pending", payoutCents: 0 };

  if (results.includes("lost")) return lost;
  if (results.includes("pending")) return pending;

  const winners = slip.legs.filter((_, i) => results[i] === "won");
  const pushes = results.filter((r) => r === "push").length;
  const allVoid = results.every((r) => r === "void");

  if (slip.type === "straight" || slip.type === "parlay") {
    if (winners.length === 0) return refund(allVoid ? "void" : "push");
    const decimal = winners.reduce<Ratio>((acc, leg) => multiply(acc, americanToDecimal(leg.price)), ONE);
    return { result: "won", payoutCents: payoutCents(stake, decimal) };
  }

  const t = rules.betTypes.teaser;
  const points = slip.teaserPoints;
  if (points == null) throw new Error("a teaser needs its points");
  if (pushes > 0 && t.pushRule === "lose") return lost;
  if (pushes > 0 && t.pushRule === "refund") return refund("push");
  if (winners.length === 0) return refund(allVoid ? "void" : "push");
  const legsPriced = winners.length === slip.legs.length ? slip.legs.length : Math.max(t.minLegs, winners.length);
  const price = teaserPrice(rules, points, legsPriced);
  if (price === null) throw new Error(`no teaser price for ${legsPriced} legs at ${points} points`);
  return { result: "won", payoutCents: payoutCents(stake, americanToDecimal(price)) };
}
