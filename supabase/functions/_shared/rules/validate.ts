import { isValidAmerican } from "./odds.ts";
import { quoteSlip, teaserPrice } from "./price.ts";
import { activeProps, isProp, PROP_LABEL, propSides } from "./props.ts";
import type { GameMarket, Leg, Problem, PropRules, RuleSet, SameGameRules, Side, SlipInput } from "./types.ts";

const SIDES: Record<GameMarket, Side[]> = {
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
    checkLegs(slip.legs, r.markets, "straight", rules, add);
  } else if (slip.type === "parlay") {
    const r = rules.betTypes.parlay;
    if (!r.enabled) add("type_disabled", "Parlays are turned off.");
    if (n < r.minLegs || n > r.maxLegs) add("leg_count", `A parlay needs ${r.minLegs} to ${r.maxLegs} legs.`);
    checkLegs(slip.legs, r.markets, "parlay", rules, add);
    checkSameGame(slip.legs, r.sameGame, "parlay", add, activeProps(rules));
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
    checkLegs(slip.legs, r.markets, "teaser", rules, add);
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
  checkStake(slip, rules, ctx, add);
  if (!problems.length) {
    try {
      // A win has to pay back more than the stake; at an extreme price and a tiny
      // stake the rounded payout can come out equal to it.
      if (quoteSlip(slip, rules).payoutCents <= slip.stakeCents) {
        add("payout_too_small", "At that price a win wouldn't pay back more than the stake. Raise the stake.");
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      add("payout_too_large", "That payout is too large for the site to handle. Lower the stake.");
    }
  }
  return problems;
}

/** A leg as far as opposite sides go: its game, market, side and (for a prop) player. */
export type LegPick = Pick<Leg, "gameId" | "market" | "side" | "player">;

/**
 * Whether two picks take opposite sides of one game: both teams, by spread or moneyline
 * in any mix, the over and the under of the total, or the over and the under of one
 * player's prop.
 */
export function oppositeSides(a: LegPick, b: LegPick): boolean {
  if (a.gameId.toLowerCase() !== b.gameId.toLowerCase() || a.side === b.side) return false;
  if (isProp(a.market) || isProp(b.market)) return a.market === b.market && (a.player ?? "") === (b.player ?? "");
  return (a.market === "total") === (b.market === "total");
}

/**
 * Checks a new slip's legs against the entry's pending bets. Unless the rules allow it,
 * an entry can't bet both sides of a game in separate bets (place_slip_internal enforces
 * the same).
 */
export function checkAcrossBets(legs: LegPick[], pending: LegPick[], rules: RuleSet): Problem[] {
  if (rules.acrossBets.oppositeSides) return [];
  const problems: Problem[] = [];
  legs.forEach((leg, i) => {
    if (pending.some((p) => oppositeSides(leg, p))) {
      problems.push({ code: "opposite_side", message: "You already have a bet on the other side of this. An entry can't bet both teams in a game, or both the over and the under.", leg: i });
    }
  });
  return problems;
}

function checkLegs(legs: Leg[], markets: GameMarket[], type: keyof typeof TYPE_NAME, rules: RuleSet, add: Add): void {
  legs.forEach((leg, i) => {
    if (!leg.gameId) add("leg_game", "Pick a game.", i);
    if (isProp(leg.market)) {
      checkPropLeg(leg, i, type, activeProps(rules), add);
      return;
    }
    if (leg.player != null) add("leg_player", "Only a player prop names a player.", i);
    if (!Object.hasOwn(SIDES, leg.market)) {
      add("leg_market", "Unknown market.", i);
      return;
    }
    const market = leg.market as GameMarket;
    if (!markets.includes(market)) {
      add("leg_market", `A ${TYPE_NAME[type]} can't include a ${market === "moneyline" ? "moneyline" : market}.`, i);
    }
    if (!SIDES[market].includes(leg.side)) add("leg_side", "That side doesn't match the market.", i);
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

function checkPropLeg(leg: Leg, i: number, type: keyof typeof TYPE_NAME, props: PropRules | null, add: Add): void {
  const market = leg.market as keyof typeof PROP_LABEL;
  if (!props) {
    add("props_off", "This league doesn't offer player props.", i);
  } else if (type === "teaser") {
    add("leg_market", "Player props can't be teased.", i);
  } else if (!props.markets.includes(market)) {
    add("leg_market", `This league doesn't offer ${PROP_LABEL[market].toLowerCase().replace(" td", " TD")} props.`, i);
  }
  if (typeof leg.player !== "string" || !leg.player.trim()) add("leg_player", "A player prop needs its player.", i);
  if (!propSides(market).includes(leg.side)) add("leg_side", "That side doesn't match the market.", i);
  if (market === "anytime_td") {
    if (leg.point !== null) add("leg_point", "An anytime touchdown has no line.", i);
  } else if (leg.point === null || !Number.isFinite(leg.point) || !Number.isInteger(leg.point * 2) || leg.point <= 0) {
    add("leg_point", "The line must be a whole or half number above zero.", i);
  }
  if (!isValidAmerican(leg.price)) add("leg_price", "That price isn't valid.", i);
}

function checkSameGame(legs: Leg[], rules: SameGameRules, type: "parlay" | "teaser", add: Add, props: PropRules | null = null): void {
  const where = `in one ${TYPE_NAME[type]}`;
  if (type === "parlay") checkSameGameProps(legs, where, props, add);
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!;
      const b = legs[j]!;
      if (a.gameId !== b.gameId || isProp(a.market) || isProp(b.market)) continue;
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

/**
 * Props in a parlay: one pick per player, no prop beside its game's own lines, and at
 * most props.maxPerGame legs from a game that has a prop on the slip. (A teaser can't
 * take props at all; checkPropLeg says so.)
 */
function checkSameGameProps(legs: Leg[], where: string, props: PropRules | null, add: Add): void {
  const players = new Map<string, number>();
  legs.forEach((leg, i) => {
    if (!isProp(leg.market) || typeof leg.player !== "string") return;
    const k = `${leg.gameId.toLowerCase()}|${leg.player.trim().toLowerCase()}`;
    if (players.has(k)) add("same_player", "Only one pick per player on a slip.", i);
    else players.set(k, i);
  });
  const games = new Map<string, number[]>();
  legs.forEach((leg, i) => games.set(leg.gameId.toLowerCase(), [...(games.get(leg.gameId.toLowerCase()) ?? []), i]));
  for (const idx of games.values()) {
    if (!idx.some((i) => isProp(legs[i]!.market))) continue;
    const mixed = idx.find((i) => !isProp(legs[i]!.market));
    if (mixed !== undefined) add("same_game_prop_line", `A player prop can't be combined with its game's spread, total or moneyline ${where}.`, mixed);
    const max = props?.maxPerGame ?? 1;
    const propLegs = idx.filter((i) => isProp(legs[i]!.market));
    if (propLegs.length > max) {
      add("same_game_props", max === 1 ? `Only one player prop per game ${where}.` : `At most ${max} player props from one game ${where}.`, propLegs[max]);
    }
  }
}

function checkStake(slip: SlipInput, rules: RuleSet, ctx: ValidationContext, add: Add): void {
  const stakeCents = slip.stakeCents;
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
  const props = activeProps(rules);
  if (props && slip.legs.some((l) => isProp(l.market))) {
    const cap = propStakeCapCents(rules);
    if (cap !== null && stakeCents > cap && stakeCents <= Math.round(s.maxUnits * 100)) {
      add("stake_max", `A bet with a player prop can stake at most ${fmt(cap / 100)} units.`);
    }
  }
  if (stakeCents > ctx.availableCents) add("stake_available", `You have ${fmt(ctx.availableCents / 100)} units available.`);
  if (s.maxPctOfBank !== null && ctx.bankCents !== undefined && stakeCents * 100 > ctx.bankCents * s.maxPctOfBank) {
    add("stake_pct", `A single bet can be at most ${s.maxPctOfBank}% of your bank.`);
  }
}

/**
 * The most a bet with a player prop may stake, in cents: the league's maximum times
 * props.maxStakePct, rounded down to a whole step. Null when props are off. The
 * database works it out the same way (place_slip_internal).
 */
export function propStakeCapCents(rules: RuleSet): number | null {
  const props = activeProps(rules);
  if (!props) return null;
  const step = Math.round(rules.stake.incrementUnits * 100);
  const raw = Math.floor((Math.round(rules.stake.maxUnits * 100) * props.maxStakePct) / 100);
  return Math.floor(raw / step) * step;
}

function fmt(units: number): string {
  return units.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
