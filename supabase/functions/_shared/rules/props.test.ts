import { describe, expect, it } from "vitest";
import { DAY_ONE_RULES } from "./defaults.ts";
import { gradeLeg, gradePropLeg, gradeSlip } from "./grade.ts";
import { effectivePrice, quoteSlip, teasedPoint } from "./price.ts";
import { activeProps, DEFAULT_PROPS, playerKey, PROP_INACTIVES_MINUTES, propsClosed, propSides } from "./props.ts";
import { validateRuleSet } from "./ruleset.ts";
import type { Leg, PlayerStats, PropMarket, RuleSet, SlipInput } from "./types.ts";
import { checkAcrossBets, oppositeSides, propStakeCapCents, validateSlip, type ValidationContext } from "./validate.ts";

const ON: RuleSet = { ...DAY_ONE_RULES, props: { ...DEFAULT_PROPS, enabled: true } };
const prop = (player: string, market: PropMarket, side: "over" | "under" | "yes", point: number | null, gameId = "g1", price = -115): Leg =>
  ({ gameId, market, side, point, price, player });
const spread = (side: "home" | "away", point: number, gameId = "g1"): Leg => ({ gameId, market: "spread", side, point, price: -110 });
const rich: ValidationContext = { availableCents: 100_000_000 };
const codes = (s: SlipInput, rules: RuleSet = ON) => validateSlip(s, rules, rich).map((p) => p.code);
const straight = (leg: Leg, stakeCents = 10_000): SlipInput => ({ type: "straight", legs: [leg], stakeCents });
const parlay = (legs: Leg[], stakeCents = 10_000): SlipInput => ({ type: "parlay", legs, stakeCents });
const stats = (s: Partial<PlayerStats>): PlayerStats => ({ passYds: 0, rushYds: 0, recYds: 0, receptions: 0, tds: 0, ...s });

describe("player props: which legs are allowed", () => {
  it("are off unless the league turns them on (and in rule sets from before props)", () => {
    const leg = prop("Josh Allen", "pass_yds", "over", 245.5);
    expect(codes(straight(leg), DAY_ONE_RULES)).toContain("props_off");
    const { props: _gone, ...old } = DAY_ONE_RULES;
    expect(codes(straight(leg), old as RuleSet)).toContain("props_off");
    expect(activeProps(old as RuleSet)).toBeNull();
    expect(codes(straight(leg))).toEqual([]);
  });
  it("take a player, the right side, and a half-point line (none for an anytime TD)", () => {
    expect(codes(straight(prop("Josh Allen", "anytime_td", "yes", null, "g1", 120)))).toEqual([]);
    expect(codes(straight({ ...prop("Josh Allen", "pass_yds", "over", 245.5), player: null }))).toContain("leg_player");
    expect(codes(straight({ ...prop("Josh Allen", "pass_yds", "over", 245.5), player: "  " }))).toContain("leg_player");
    expect(codes(straight(prop("Josh Allen", "anytime_td", "over", null)))).toContain("leg_side");
    expect(codes(straight(prop("Josh Allen", "rush_yds", "yes", 30.5)))).toContain("leg_side");
    expect(codes(straight(prop("Josh Allen", "anytime_td", "yes", 0.5)))).toContain("leg_point");
    expect(codes(straight(prop("Josh Allen", "receptions", "over", null)))).toContain("leg_point");
    expect(codes(straight(prop("Josh Allen", "receptions", "over", 4.25)))).toContain("leg_point");
    expect(codes(straight(prop("Josh Allen", "receptions", "over", 0)))).toContain("leg_point");
    expect(propSides("anytime_td")).toEqual(["yes"]);
  });
  it("a game's own market can't name a player", () => {
    expect(codes(straight({ ...spread("home", -3), player: "Josh Allen" }))).toContain("leg_player");
  });
  it("only the markets the league picked", () => {
    const tdOnly: RuleSet = { ...ON, props: { ...ON.props!, markets: ["anytime_td"] } };
    expect(codes(straight(prop("Josh Allen", "pass_yds", "over", 245.5)), tdOnly)).toContain("leg_market");
    expect(validateSlip(straight(prop("Josh Allen", "pass_yds", "over", 245.5)), tdOnly, rich)[0]!.message).toContain("passing yards");
    expect(validateSlip(straight(prop("Josh Allen", "anytime_td", "yes", null)), { ...ON, props: { ...ON.props!, markets: ["pass_yds"] } }, rich)[0]!.message)
      .toBe("This league doesn't offer anytime TD props.");
  });
  it("never in a teaser", () => {
    const t: SlipInput = { type: "teaser", legs: [prop("Josh Allen", "pass_yds", "over", 245.5), spread("home", -3, "g2")], stakeCents: 10_000, teaserPoints: 6 };
    expect(codes(t)).toEqual(["leg_market"]);
    expect(() => teasedPoint(prop("Josh Allen", "pass_yds", "over", 245.5), 6)).toThrow();
  });
});

describe("player props in a parlay", () => {
  const perGame = (n: number): RuleSet => ({ ...ON, props: { ...ON.props!, maxPerGame: n } });
  it("one prop per game by default: two from one game tend to hit together", () => {
    expect(DEFAULT_PROPS).toMatchObject({ maxPerGame: 1, maxStakePct: 2, maxPerParlay: 3 });
    const two = [prop("Josh Allen", "anytime_td", "yes", null), prop("James Cook", "rush_yds", "over", 71.5)];
    expect(codes(parlay(two))).toEqual(["same_game_props"]);
    expect(codes(parlay([two[0]!, prop("Jared Goff", "pass_yds", "over", 262.5, "g2")]))).toEqual([]);
  });
  it("up to the per-game limit the league sets from one game", () => {
    expect(codes(parlay([prop("Josh Allen", "anytime_td", "yes", null), prop("James Cook", "rush_yds", "over", 71.5)]), perGame(2))).toEqual([]);
    const three = [prop("Josh Allen", "anytime_td", "yes", null), prop("James Cook", "rush_yds", "over", 71.5), prop("Patrick Mahomes", "pass_yds", "over", 254.5)];
    expect(codes(parlay(three), perGame(2))).toEqual(["same_game_props"]);
    expect(validateSlip(parlay(three), perGame(2), rich)[0]!.leg).toBe(2);
    expect(codes(parlay(three), perGame(3))).toEqual([]);
  });
  it("props from different games don't count against each other's game limit", () => {
    expect(codes(parlay([
      prop("Josh Allen", "anytime_td", "yes", null, "g1"), prop("James Cook", "rush_yds", "over", 71.5, "g1"),
      prop("Jared Goff", "pass_yds", "over", 262.5, "g2"), prop("Josh Jacobs", "rush_yds", "under", 68.5, "g2"),
    ]), { ...perGame(2), props: { ...perGame(2).props!, maxPerParlay: 4 } })).toEqual([]);
  });
  it("at most props.maxPerParlay props on a slip (3 by default); no limit in rule sets from before it", () => {
    const four = ["g1", "g2", "g3", "g4"].map((g, i) => prop(`Player ${i}`, "anytime_td", "yes", null, g));
    expect(codes(parlay(four.slice(0, 3)))).toEqual([]);
    expect(codes(parlay(four))).toEqual(["too_many_props"]);
    expect(validateSlip(parlay(four), ON, rich)[0]).toEqual({ code: "too_many_props", message: "At most 3 player props in one parlay.", leg: 3 });
    // Game lines don't count against it.
    expect(codes(parlay([...four.slice(0, 3), spread("home", -3, "g9")]))).toEqual([]);
    const { maxPerParlay: _gone, ...noCap } = ON.props!;
    expect(codes(parlay(four), { ...ON, props: noCap })).toEqual([]);
  });
  it("a prop can't share a parlay with its own game's spread, total or moneyline", () => {
    expect(codes(parlay([prop("Josh Allen", "anytime_td", "yes", null), spread("home", -3)]))).toEqual(["same_game_prop_line"]);
    expect(codes(parlay([prop("Josh Allen", "anytime_td", "yes", null), spread("home", -3, "g2")]))).toEqual([]);
  });
  it("one pick per player", () => {
    expect(codes(parlay([prop("Josh Allen", "anytime_td", "yes", null), prop("Josh Allen", "rush_yds", "over", 34.5)]), perGame(2))).toEqual(["same_player"]);
  });
  it("a bet with a prop stakes at most the props cap (2% of the maximum by default)", () => {
    expect(propStakeCapCents(ON)).toBe(500_000);
    expect(propStakeCapCents(DAY_ONE_RULES)).toBeNull();
    const leg = prop("Josh Allen", "pass_yds", "over", 245.5);
    expect(codes(straight(leg, 500_000))).toEqual([]);
    expect(codes(straight(leg, 500_100))).toEqual(["stake_max"]);
    expect(codes(straight(spread("home", -3), 500_100))).toEqual([]);
    // Rounded down to a whole stake step.
    const steps: RuleSet = { ...ON, stake: { ...ON.stake, maxUnits: 1_001, incrementUnits: 10 }, props: { ...ON.props!, maxStakePct: 50 } };
    expect(propStakeCapCents(steps)).toBe(50_000);
  });
});

describe("player props across bets", () => {
  it("the over and the under of one player's prop are opposite sides; other pairs aren't", () => {
    const over = prop("Josh Allen", "pass_yds", "over", 245.5);
    expect(oppositeSides(over, prop("Josh Allen", "pass_yds", "under", 245.5))).toBe(true);
    expect(oppositeSides(over, prop("Josh Allen", "pass_yds", "under", 239.5))).toBe(true);
    expect(oppositeSides(over, prop("Josh Allen", "rush_yds", "under", 34.5))).toBe(false);
    expect(oppositeSides(over, prop("Patrick Mahomes", "pass_yds", "under", 254.5))).toBe(false);
    expect(oppositeSides(over, { gameId: "g1", market: "total", side: "under" })).toBe(false);
    expect(checkAcrossBets([over], [prop("Josh Allen", "pass_yds", "under", 245.5)], ON).map((p) => p.code)).toEqual(["opposite_side"]);
  });
});

describe("player props: prices and grading", () => {
  it("pay the book's price even under flat pricing", () => {
    const flat: RuleSet = { ...ON, pricing: { straight: "flat", flatPrice: -110 } };
    expect(effectivePrice("pass_yds", -125, flat)).toBe(-125);
    expect(effectivePrice("spread", -125, flat)).toBe(-110);
    expect(quoteSlip(straight(prop("Josh Allen", "anytime_td", "yes", null, "g1", 120)), ON).payoutCents).toBe(22_000);
  });
  it("grade on the player's stats: over, under, a push on the number", () => {
    expect(gradePropLeg(prop("A", "pass_yds", "over", 245.5), stats({ passYds: 246 }))).toBe("won");
    expect(gradePropLeg(prop("A", "pass_yds", "under", 245.5), stats({ passYds: 246 }))).toBe("lost");
    expect(gradePropLeg(prop("A", "receptions", "over", 5), stats({ receptions: 5 }))).toBe("push");
    expect(gradePropLeg(prop("A", "rec_yds", "under", 40.5), stats({ recYds: -3 }))).toBe("won");
    expect(gradePropLeg(prop("A", "rush_yds", "over", 70.5), stats({ rushYds: 71 }))).toBe("won");
  });
  it("an anytime TD wins on any touchdown he scores himself", () => {
    expect(gradePropLeg(prop("A", "anytime_td", "yes", null), stats({ tds: 1 }))).toBe("won");
    expect(gradePropLeg(prop("A", "anytime_td", "yes", null), stats({ tds: 0, passYds: 300 }))).toBe("lost");
  });
  it("is void when he didn't play; in a parlay that leg drops out", () => {
    expect(gradePropLeg(prop("A", "anytime_td", "yes", null), "void")).toBe("void");
    const legs = [prop("A", "anytime_td", "yes", null, "g1", 120), prop("B", "pass_yds", "over", 245.5, "g2", -110)];
    const g = gradeSlip({ type: "parlay", stakeCents: 10_000, legs }, ["void", "won"], ON);
    expect(g).toEqual({ result: "won", payoutCents: 19_091 });
  });
  it("aren't graded from a final score", () => {
    expect(() => gradeLeg(prop("A", "anytime_td", "yes", null), { homeScore: 1, awayScore: 0 })).toThrow();
  });
});

describe("propsClosed: when a game's props can be bet", () => {
  const kickoff = new Date("2026-10-11T17:00:00Z");
  const at = (iso: string) => new Date(iso);
  it("only on props pulled within the league's limit", () => {
    expect(propsClosed(kickoff, null, at("2026-10-11T12:00:00Z"), 120)).toBe("stale");
    expect(propsClosed(kickoff, at("2026-10-11T10:00:00Z"), at("2026-10-11T12:00:00Z"), 120)).toBeNull();
    expect(propsClosed(kickoff, at("2026-10-11T10:00:00Z"), at("2026-10-11T12:00:01Z"), 120)).toBe("stale");
  });
  it("from 90 minutes before kickoff (inactives), only on props pulled after that", () => {
    expect(PROP_INACTIVES_MINUTES).toBe(90);
    const before = at("2026-10-11T15:00:00Z");
    expect(propsClosed(kickoff, before, at("2026-10-11T15:29:59Z"), 120)).toBeNull();
    expect(propsClosed(kickoff, before, at("2026-10-11T15:30:00Z"), 120)).toBe("inactives");
    expect(propsClosed(kickoff, at("2026-10-11T15:30:00Z"), at("2026-10-11T16:30:00Z"), 120)).toBeNull();
    expect(propsClosed(kickoff.toISOString(), "2026-10-11T15:45:00Z", Date.parse("2026-10-11T16:59:00Z"), 120)).toBeNull();
  });
});

describe("playerKey", () => {
  it("matches names across sources", () => {
    expect(playerKey("Aaron Jones Sr.")).toBe("aaron jones");
    expect(playerKey("Amon-Ra St. Brown")).toBe("amonra st brown");
    expect(playerKey("Kenneth Walker III")).toBe("kenneth walker");
    expect(playerKey("D.J. Moore")).toBe("dj moore");
    expect(playerKey("José  Ramírez")).toBe("jose ramirez");
  });
});

describe("validateRuleSet: props", () => {
  it("accepts the default props section, on or off, and none at all", () => {
    expect(validateRuleSet(ON)).toEqual([]);
    expect(validateRuleSet(DAY_ONE_RULES)).toEqual([]);
    const { props: _gone, ...old } = DAY_ONE_RULES;
    expect(validateRuleSet(old as RuleSet)).toEqual([]);
  });
  const bad = (p: Partial<NonNullable<RuleSet["props"]>>, rules: RuleSet = ON) =>
    validateRuleSet({ ...rules, props: { ...rules.props!, ...p } }).map((x) => x.code);
  it("refuses unknown or repeated markets, and none while on", () => {
    expect(bad({ markets: ["pass_tds" as PropMarket] })).toEqual(["props_markets"]);
    expect(bad({ markets: ["pass_yds", "pass_yds"] })).toEqual(["props_markets"]);
    expect(bad({ markets: [] })).toEqual(["props_markets"]);
    expect(bad({ markets: [], enabled: false })).toEqual([]);
  });
  it("takes 1 to 10 props in a parlay, or none set (no limit)", () => {
    expect(bad({ maxPerParlay: 1 })).toEqual([]);
    expect(bad({ maxPerParlay: 10 })).toEqual([]);
    expect(bad({ maxPerParlay: 0 })).toEqual(["props_per_parlay"]);
    expect(bad({ maxPerParlay: 11 })).toEqual(["props_per_parlay"]);
    expect(bad({ maxPerParlay: 2.5 })).toEqual(["props_per_parlay"]);
    const { maxPerParlay: _gone, ...noCap } = ON.props!;
    expect(validateRuleSet({ ...ON, props: noCap })).toEqual([]);
  });
  it("takes 1 to 3 picks per game and a stake cap above 0 up to 100%", () => {
    expect(bad({ maxPerGame: 0 })).toEqual(["props_per_game"]);
    expect(bad({ maxPerGame: 4 })).toEqual(["props_per_game"]);
    expect(bad({ maxPerGame: 1.5 })).toEqual(["props_per_game"]);
    expect(bad({ maxStakePct: 0 })).toEqual(["props_stake"]);
    expect(bad({ maxStakePct: 101 })).toEqual(["props_stake"]);
    expect(bad({ maxStakePct: Number.NaN })).toEqual(["props_stake"]);
    expect(bad({ enabled: "yes" as unknown as boolean })).toEqual(["props"]);
  });
  it("refuses a cap that comes out below the minimum stake", () => {
    const tight: RuleSet = { ...ON, stake: { ...ON.stake, minUnits: 100, maxUnits: 150 } };
    expect(bad({ maxStakePct: 50 }, tight)).toEqual(["props_stake"]);
    expect(bad({ maxStakePct: 70 }, tight)).toEqual([]);
  });
});
