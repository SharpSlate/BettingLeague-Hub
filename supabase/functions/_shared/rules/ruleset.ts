import { isValidAmerican } from "./odds.ts";
import type { Market, Problem, RuleSet } from "./types.ts";

const MARKETS: Market[] = ["spread", "total", "moneyline"];

/**
 * Checks a rule-set document before it can be published. Grading relies on
 * these holding, e.g. a teaser price for every leg count at every points option.
 */
export function validateRuleSet(r: RuleSet): Problem[] {
  const problems: Problem[] = [];
  const add = (code: string, message: string) => problems.push({ code, message });
  const { straight, parlay, teaser } = r.betTypes;

  const badMarket = (list: Market[]) => list.some((m) => !MARKETS.includes(m));
  if (badMarket(straight.markets) || badMarket(parlay.markets) || badMarket(teaser.markets)) {
    add("markets", "Markets must be spread, total or moneyline.");
  }
  if (!Number.isInteger(parlay.minLegs) || parlay.minLegs < 2 || parlay.maxLegs < parlay.minLegs || parlay.maxLegs > 20) {
    add("parlay_legs", "Parlay legs must run from at least 2 up to at most 20.");
  }
  if (!Number.isInteger(teaser.minLegs) || teaser.minLegs < 2 || teaser.maxLegs < teaser.minLegs || teaser.maxLegs > 20) {
    add("teaser_legs", "Teaser legs must run from at least 2 up to at most 20.");
  }
  if (teaser.markets.includes("moneyline")) add("teaser_markets", "Moneylines can't be teased.");
  if (teaser.enabled && teaser.points.length === 0) add("teaser_points", "Teasers need at least one points option.");
  for (const p of teaser.points) {
    if (!(p > 0) || !Number.isInteger(p * 2)) add("teaser_points", `Teaser points must be whole or half points: ${p}.`);
    for (let n = teaser.minLegs; n <= teaser.maxLegs; n++) {
      const price = teaser.prices[String(p)]?.[String(n)];
      if (price === undefined || !isValidAmerican(price)) {
        add("teaser_prices", `The teaser table needs a valid price for ${n} legs at ${p} points.`);
      }
    }
  }
  if (!["reduce", "refund", "lose"].includes(teaser.pushRule)) add("teaser_push", "Unknown teaser push rule.");
  if (!["book", "flat"].includes(r.pricing.straight) || !isValidAmerican(r.pricing.flatPrice)) {
    add("pricing", "Pricing must be book or flat, with a valid flat price.");
  }
  const s = r.stake;
  if (!(s.incrementUnits > 0) || !(s.minUnits > 0) || s.maxUnits < s.minUnits) {
    add("stake", "Stake limits must be positive, with the maximum at or above the minimum.");
  }
  if (s.maxPctOfBank !== null && !(s.maxPctOfBank > 0 && s.maxPctOfBank <= 100)) {
    add("stake_pct", "The stake cap must be between 0 and 100 percent of the bank.");
  }
  if (!(r.undoMinutes >= 0 && r.undoMinutes <= 60)) add("undo", "The undo window must be 0 to 60 minutes.");
  if (!(r.weeklyMinimum.pct >= 0 && r.weeklyMinimum.pct <= 100)) add("weekly_pct", "The weekly minimum must be 0 to 100 percent.");
  if (!["deduct_shortfall", "warn", "none"].includes(r.weeklyMinimum.penalty)) add("weekly_penalty", "Unknown weekly-minimum penalty.");
  if (!["kickoff_per_leg", "on_placement", "week_first_kickoff"].includes(r.visibility)) add("visibility", "Unknown visibility rule.");
  if (!["game_kickoff", "week_first_kickoff"].includes(r.lock)) add("lock", "Unknown lock rule.");
  if (!(r.bank.startUnits >= 0 && r.bank.bonusUnits >= 0)) add("bank", "Starting bank and bonus can't be negative.");
  return problems;
}
