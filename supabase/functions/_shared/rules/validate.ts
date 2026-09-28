import { isValidAmerican } from "./odds.ts";
import { quoteSlip, teaserPrice } from "./price.ts";
import type { Leg, Market, Problem, RuleSet, SameGameRules, Side, SlipInput } from "./types.ts";

const SIDES: Record<Market, Side[]> = {
  spread: ["home", "away"],
  moneyline: ["home", "away"],
  total: ["over", "under"],
};

const TYPE_NAME = { straight: "straight bet", parlay: "parlay", teaser: "teaser" } as const;

export interface ValidationContext {
  /** The entry's available units in cents (the ledger sum). */
  availableCents: number;
  /** The entry's bank in cents, needed only when maxPctOfBank is set. */
  bankCents?: number;
}

type Add = (code: string, message: string, leg?: number) => void;

/** Checks a slip against a rule set. An empty list means the slip may be placed. */
export function validateSlip(slip: SlipInput, rules: RuleSet, ctx: ValidationContext): Problem[] {
  const problems: Problem[] = [];
  const add: Add = (code, message, leg) =>
    problems.push(leg === undefined ? { code, message } : { code, message, leg });
  const n = slip.legs.length;

  if (slip.type === "straight") {
    const r = rules.betTypes.straight;
    if (!r.enabled) add("type_disabled", "Straight bets are turned off.");
    if (n !== 1) add("leg_count", "A straight bet has exactly one pick.");
    checkLegs(slip.legs, r.markets, "straight", add);
  } else if (slip.type === "parlay") {
    const r = rules.betTypes.parlay;
    if (!r.enabled) add("type_disabled", "Parlays are turned off.");
    if (n < r.minLegs || n > r.maxLegs) add("leg_count", `A parlay needs ${r.minLegs} to ${r.maxLegs} legs.`);
    checkLegs(slip.legs, r.markets, "parlay", add);
    checkSameGame(slip.legs, r.sameGame, "parlay", add);
  } else if (slip.type === "teaser") {
    const r = rules.betTypes.teaser;
    if (!r.enabled) add("type_disabled", "Teasers are turned off.");
    if (n < r.minLegs || n > r.maxLegs) add("leg_count", `A teaser needs ${r.minLegs} to ${r.maxLegs} legs.`);
    const pts = slip.teaserPoints;
    if (pts == null || !r.points.includes(pts)) {
      add("teaser_points", `Teasers are ${r.points.join(", ")} points.`);
    } else if (n >= r.minLegs && n <= r.maxLegs && teaserPrice(rules, pts, n) === null) {
      add("teaser_price_missing", `There's no price for a ${n}-leg ${pts}-point teaser.`);
    }
    checkLegs(slip.legs, r.markets, "teaser", add);
    if (r.totalsNeedSpread && slip.legs.some((l) => l.market === "total") && !slip.legs.some((l) => l.market === "spread")) {
      add("totals_need_spread", "A total can only be teased alongside a spread.");
    }
    checkSameGame(slip.legs, r.sameGame, "teaser", add);
  } else {
    add("type_unknown", "Unknown bet type.");
  }

  if (slip.type !== "teaser" && slip.teaserPoints != null) {
    add("teaser_points", "Only teasers take teaser points.");
  }
  checkStake(slip.stakeCents, rules, ctx, add);
  if (!problems.length) {
    try {
      quoteSlip(slip, rules);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      add("payout_too_large", "That payout is too large for the site to handle. Lower the stake.");
    }
  }
  return problems;
}

function checkLegs(legs: Leg[], markets: Market[], type: keyof typeof TYPE_NAME, add: Add): void {
  legs.forEach((leg, i) => {
    if (!leg.gameId) add("leg_game", "Pick a game.", i);
    if (!SIDES[leg.market]) {
      add("leg_market", "Unknown market.", i);
      return;
    }
    if (!markets.includes(leg.market)) {
      add("leg_market", `A ${TYPE_NAME[type]} can't include a ${leg.market === "moneyline" ? "moneyline" : leg.market}.`, i);
    }
    if (!SIDES[leg.market].includes(leg.side)) add("leg_side", "That side doesn't match the market.", i);
    if (leg.market === "moneyline") {
      if (leg.point !== null) add("leg_point", "A moneyline has no point.", i);
    } else if (leg.point === null || !Number.isFinite(leg.point) || !Number.isInteger(leg.point * 2)) {
      add("leg_point", "The line must be a whole or half point.", i);
    } else if (leg.market === "total" && leg.point <= 0) {
      add("leg_point", "A total must be above zero.", i);
    }
    if (!isValidAmerican(leg.price)) add("leg_price", "That price isn't valid.", i);
  });
}

function checkSameGame(legs: Leg[], rules: SameGameRules, type: "parlay" | "teaser", add: Add): void {
  const where = `in one ${TYPE_NAME[type]}`;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!;
      const b = legs[j]!;
      if (a.gameId !== b.gameId) continue;
      const pair = [a.market, b.market].sort().join("+");
      if (a.market === b.market && a.side === b.side) {
        add("same_game_duplicate", "The same pick is on the slip twice.", j);
      } else if (a.market === b.market) {
        if (!rules.bothSides) add("same_game_both_sides", `Both sides of one game can't be combined ${where}.`, j);
      } else if (pair === "moneyline+spread") {
        if (!rules.spreadMoneyline) add("same_game_spread_moneyline", `A spread and a moneyline on the same game can't be combined ${where}.`, j);
      } else if (pair === "spread+total") {
        if (!rules.spreadTotal) add("same_game_spread_total", `A spread and a total on the same game can't be combined ${where}.`, j);
      } else if (pair === "moneyline+total") {
        if (!rules.moneylineTotal) add("same_game_moneyline_total", `A moneyline and a total on the same game can't be combined ${where}.`, j);
      }
    }
  }
}

function checkStake(stakeCents: number, rules: RuleSet, ctx: ValidationContext, add: Add): void {
  const s = rules.stake;
  if (!Number.isSafeInteger(stakeCents) || stakeCents <= 0) {
    add("stake", "Enter a stake.");
    return;
  }
  if (stakeCents % Math.round(s.incrementUnits * 100) !== 0) {
    add("stake_increment", s.incrementUnits === 1 ? "Stakes are whole units." : `Stakes go in steps of ${s.incrementUnits} units.`);
  }
  if (stakeCents < Math.round(s.minUnits * 100)) add("stake_min", `The minimum stake is ${fmt(s.minUnits)} units.`);
  if (stakeCents > Math.round(s.maxUnits * 100)) add("stake_max", `The maximum stake is ${fmt(s.maxUnits)} units.`);
  if (stakeCents > ctx.availableCents) add("stake_available", `You have ${fmt(ctx.availableCents / 100)} units available.`);
  if (s.maxPctOfBank !== null && ctx.bankCents !== undefined && stakeCents * 100 > ctx.bankCents * s.maxPctOfBank) {
    add("stake_pct", `A single bet can be at most ${s.maxPctOfBank}% of your bank.`);
  }
}

function fmt(units: number): string {
  return units.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
