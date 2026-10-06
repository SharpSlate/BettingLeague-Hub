import { americanToDecimal, isValidAmerican } from "./odds.ts";
import { PROP_MARKETS } from "./props.ts";
import type { GameMarket, Problem, RuleSet } from "./types.ts";

const MARKETS: GameMarket[] = ["spread", "total", "moneyline"];

/** A whole number of cents, at least 1 cent, e.g. 1 or 2.5 units but not 1.005. */
function wholeCents(units: number): boolean {
  const c = units * 100;
  return Number.isFinite(c) && c >= 1 && Math.abs(c - Math.round(c)) < 1e-6 && Number.isSafeInteger(Math.round(c));
}

/** Whether American price a pays less than b. */
function paysLess(a: number, b: number): boolean {
  const x = americanToDecimal(a);
  const y = americanToDecimal(b);
  return x.num * y.den < y.num * x.den;
}

/**
 * Checks a rule-set document before it can be published. Grading relies on
 * these holding, e.g. a teaser price for every leg count at every points option.
 */
export function validateRuleSet(r: RuleSet): Problem[] {
  const problems: Problem[] = [];
  const add = (code: string, message: string) => problems.push({ code, message });
  const { straight, parlay, teaser } = r.betTypes;

  const badMarket = (list: GameMarket[]) => list.some((m) => !MARKETS.includes(m));
  if (badMarket(straight.markets) || badMarket(parlay.markets) || badMarket(teaser.markets)) {
    add("markets", "Markets must be spread, total or moneyline.");
  }
  // Every number must be a real number: an editor can turn a typo into NaN, and NaN
  // becomes null on its way to the server, where null passes comparisons like >= 0.
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const legsOk = (min: number, max: number) => Number.isInteger(min) && Number.isInteger(max) && min >= 2 && max >= min && max <= 20;
  if (!legsOk(parlay.minLegs, parlay.maxLegs)) {
    add("parlay_legs", "Parlay legs must be whole numbers from at least 2 up to at most 20.");
  }
  const teaserLegsOk = legsOk(teaser.minLegs, teaser.maxLegs);
  if (!teaserLegsOk) {
    add("teaser_legs", "Teaser legs must be whole numbers from at least 2 up to at most 20.");
  }
  if (teaser.markets.includes("moneyline")) add("teaser_markets", "Moneylines can't be teased.");
  if (!straight.enabled && !parlay.enabled && !teaser.enabled) add("bet_types", "Turn on at least one bet type.");
  if (new Set(teaser.points).size !== teaser.points.length) add("teaser_points", "Each teaser points option can be listed only once.");
  if (teaser.enabled && teaser.points.length === 0) add("teaser_points", "Teasers need at least one points option.");
  for (const p of teaser.points) {
    if (!(p > 0) || !Number.isInteger(p * 2)) add("teaser_points", `Teaser points must be whole or half points: ${p}.`);
    if (!teaserLegsOk) continue;
    // A card cut down by pushes or voids is priced on the legs left, down to 2, so the
    // table needs every row from 2 legs up, each paying more than the row before.
    let prev: number | null = null;
    for (let n = 2; n <= teaser.maxLegs; n++) {
      const price = teaser.prices[String(p)]?.[String(n)];
      if (price === undefined || !isValidAmerican(price)) {
        add("teaser_prices", `The teaser table needs a valid price for ${n} legs at ${p} points.`);
        prev = null;
        continue;
      }
      if (prev !== null && !paysLess(prev, price)) {
        add("teaser_prices", `At ${p} points, ${n} legs must pay more than ${n - 1} legs.`);
      }
      prev = price;
    }
  }
  if (!["reduce", "refund", "lose"].includes(teaser.pushRule)) add("teaser_push", "Unknown teaser push rule.");
  if (!["book", "flat"].includes(r.pricing.straight) || !isValidAmerican(r.pricing.flatPrice)) {
    add("pricing", "Pricing must be book or flat, with a valid flat price.");
  }
  const s = r.stake;
  if (!wholeCents(s.incrementUnits) || !wholeCents(s.minUnits) || !wholeCents(s.maxUnits) || s.maxUnits < s.minUnits) {
    add("stake", "Stake limits must be positive amounts in whole cents (at most 2 decimal places), with the maximum at or above the minimum.");
  }
  if (s.maxPctOfBank !== null && !(num(s.maxPctOfBank) && s.maxPctOfBank > 0 && s.maxPctOfBank <= 100)) {
    add("stake_pct", "The stake cap must be between 0 and 100 percent of the bank, or blank for none.");
  }
  if (!(num(r.undoMinutes) && r.undoMinutes >= 0 && r.undoMinutes <= 60)) add("undo", "The undo window must be 0 to 60 minutes.");
  if (typeof r.undoAfterLineMove !== "boolean") add("undo_line_move", "Say whether a bet can be undone after its line moves.");
  if (typeof r.acrossBets?.oppositeSides !== "boolean") add("across_bets", "Say whether an entry can bet both sides of a game in separate bets.");
  if (!(num(r.weeklyMinimum.pct) && r.weeklyMinimum.pct >= 0 && r.weeklyMinimum.pct <= 100)) add("weekly_pct", "The weekly minimum must be 0 to 100 percent.");
  if (!["deduct_shortfall", "warn", "none"].includes(r.weeklyMinimum.penalty)) add("weekly_penalty", "Unknown weekly-minimum penalty.");
  if (!["kickoff_per_leg", "on_placement", "week_first_kickoff"].includes(r.visibility)) add("visibility", "Unknown visibility rule.");
  if (!["game_kickoff", "week_first_kickoff"].includes(r.lock)) add("lock", "Unknown lock rule.");
  if (!(num(r.bank.startUnits) && num(r.bank.bonusUnits) && r.bank.startUnits >= 0 && r.bank.bonusUnits >= 0)) {
    add("bank", "Starting bank and bonus must be numbers, 0 or more.");
  }
  // Rule sets from before props existed have no props section, which means no props.
  const p = r.props;
  if (p !== undefined) {
    if (typeof p?.enabled !== "boolean") add("props", "Say whether the league offers player props.");
    if (!Array.isArray(p?.markets) || p.markets.some((m) => !PROP_MARKETS.includes(m)) || new Set(p.markets).size !== p.markets.length) {
      add("props_markets", "Prop markets must be anytime TD, receptions, rushing, receiving or passing yards, each listed once.");
    } else if (p.enabled && p.markets.length === 0) {
      add("props_markets", "Pick at least one prop market, or turn props off.");
    }
    if (!(Number.isInteger(p?.maxPerGame) && p.maxPerGame >= 1 && p.maxPerGame <= 3)) {
      add("props_per_game", "Picks per game with a prop must be 1, 2 or 3.");
    }
    if (p?.maxPerParlay !== undefined && !(Number.isInteger(p.maxPerParlay) && p.maxPerParlay >= 1 && p.maxPerParlay <= 10)) {
      add("props_per_parlay", "Props in one parlay must be a whole number from 1 to 10.");
    }
    if (!(num(p?.maxStakePct) && p.maxStakePct > 0 && p.maxStakePct <= 100)) {
      add("props_stake", "The prop stake limit must be above 0 and at most 100 percent of the maximum stake.");
    } else if (p.enabled && wholeCents(s.minUnits) && wholeCents(s.maxUnits) && wholeCents(s.incrementUnits)) {
      const step = Math.round(s.incrementUnits * 100);
      const cap = Math.floor(Math.floor((Math.round(s.maxUnits * 100) * p.maxStakePct) / 100) / step) * step;
      if (cap < Math.round(s.minUnits * 100)) add("props_stake", "The prop stake limit comes out below the minimum stake. Raise it.");
    }
  }
  return problems;
}
