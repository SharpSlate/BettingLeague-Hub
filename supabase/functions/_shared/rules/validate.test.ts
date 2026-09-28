import { describe, expect, it } from "vitest";
import { DAY_ONE_RULES } from "./defaults.ts";
import { quoteSlip, teasedPoint, effectivePrice } from "./price.ts";
import { validateRuleSet } from "./ruleset.ts";
import type { Leg, RuleSet, SlipInput } from "./types.ts";
import { checkAcrossBets, oppositeSides, validateSlip, type ValidationContext } from "./validate.ts";

const spread = (side: "home" | "away", point: number, gameId = "g1", price = -110): Leg => ({ gameId, market: "spread", side, point, price });
const total = (side: "over" | "under", point: number, gameId = "g1", price = -110): Leg => ({ gameId, market: "total", side, point, price });
const ml = (side: "home" | "away", price: number, gameId = "g1"): Leg => ({ gameId, market: "moneyline", side, point: null, price });

const rich: ValidationContext = { availableCents: 100_000_000 };
const codes = (s: SlipInput, rules: RuleSet = DAY_ONE_RULES, ctx: ValidationContext = rich) => validateSlip(s, rules, ctx).map((p) => p.code);
const parlay = (legs: Leg[], stakeCents = 10_000): SlipInput => ({ type: "parlay", legs, stakeCents });
const teaser = (legs: Leg[], teaserPoints: number | null = 6, stakeCents = 10_000): SlipInput => ({ type: "teaser", legs, stakeCents, teaserPoints });
const games = (n: number, make: (g: string) => Leg) => Array.from({ length: n }, (_, i) => make(`g${i}`));

describe("validateSlip: leg counts and types", () => {
  it("a straight bet has one leg", () => {
    expect(codes({ type: "straight", legs: [spread("home", -3)], stakeCents: 10_000 })).toEqual([]);
    expect(codes({ type: "straight", legs: [spread("home", -3, "a"), spread("home", -3, "b")], stakeCents: 10_000 })).toContain("leg_count");
  });
  it("parlays take 2 to 10 legs of any market", () => {
    expect(codes(parlay([spread("home", -3, "a"), total("over", 41, "b"), ml("away", 140, "c")]))).toEqual([]);
    expect(codes(parlay(games(10, (g) => ml("home", -120, g))))).toEqual([]);
    expect(codes(parlay(games(11, (g) => ml("home", -120, g))))).toContain("leg_count");
    expect(codes(parlay([ml("home", -120)]))).toContain("leg_count");
  });
  it("teasers take 2 to 10 legs of spreads and totals, mixed freely", () => {
    const mixed = games(10, (g) => (g.endsWith("1") || g.endsWith("4") ? total("under", 47, g) : spread("away", 2.5, g)));
    expect(codes(teaser(mixed))).toEqual([]);
    expect(codes(teaser(games(10, (g) => total("over", 44, g))))).toEqual([]); // all totals is fine by default
    expect(codes(teaser(games(11, (g) => spread("home", -7, g))))).toContain("leg_count");
  });
  it("moneylines can't be teased", () => {
    expect(codes(teaser([spread("home", -7, "a"), ml("home", -150, "b")]))).toContain("leg_market");
  });
  it("teaser points must be one of the options", () => {
    expect(codes(teaser([spread("home", -7, "a"), spread("home", -8, "b")], 5))).toContain("teaser_points");
    expect(codes(teaser([spread("home", -7, "a"), spread("home", -8, "b")], null))).toContain("teaser_points");
    expect(codes({ ...parlay([ml("home", -120, "a"), ml("home", -120, "b")]), teaserPoints: 6 })).toContain("teaser_points");
  });
  it("Splash's totals-need-a-spread rule can be switched back on", () => {
    const splashy: RuleSet = { ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, teaser: { ...DAY_ONE_RULES.betTypes.teaser, totalsNeedSpread: true } } };
    expect(codes(teaser(games(3, (g) => total("over", 44, g))), splashy)).toContain("totals_need_spread");
    expect(codes(teaser([total("over", 44, "a"), spread("home", -7, "b")]), splashy)).toEqual([]);
  });
  it("a disabled bet type is refused", () => {
    const off: RuleSet = { ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, parlay: { ...DAY_ONE_RULES.betTypes.parlay, enabled: false } } };
    expect(codes(parlay([ml("home", -120, "a"), ml("home", -120, "b")]), off)).toContain("type_disabled");
  });
});

describe("validateSlip: same-game combinations", () => {
  // Legs from one game are related (a big favorite covering and the over tend to win
  // together), and multiplying their odds pays them as if they weren't.
  it("a parlay can't combine two legs from the same game by default", () => {
    expect(codes(parlay([spread("home", -3), total("over", 44.5)]))).toContain("same_game_spread_total");
    expect(codes(parlay([ml("away", 130), total("under", 44.5)]))).toContain("same_game_moneyline_total");
    expect(codes(parlay([spread("home", -3), ml("home", -160)]))).toContain("same_game_spread_moneyline");
    expect(codes(parlay([spread("home", -3), ml("away", 140)]))).toContain("same_game_spread_moneyline");
    expect(codes(parlay([total("over", 44.5), total("under", 44.5)]))).toContain("same_game_both_sides");
    expect(codes(parlay([spread("home", -3), spread("away", 3)]))).toContain("same_game_both_sides");
    expect(codes(parlay([ml("home", -160), ml("away", 140)]))).toContain("same_game_both_sides");
  });
  it("nor can a teaser", () => {
    expect(codes(teaser([spread("home", -3), total("over", 44.5)]))).toContain("same_game_spread_total");
    expect(codes(teaser([spread("home", -3), spread("away", 3)]))).toContain("same_game_both_sides");
    expect(codes(teaser([total("over", 44.5), total("under", 44.5)]))).toContain("same_game_both_sides");
  });
  it("the commissioner can allow each combination", () => {
    const open = { spreadTotal: true, moneylineTotal: true, spreadMoneyline: true, bothSides: true };
    const loose: RuleSet = {
      ...DAY_ONE_RULES,
      betTypes: {
        ...DAY_ONE_RULES.betTypes,
        parlay: { ...DAY_ONE_RULES.betTypes.parlay, sameGame: open },
        teaser: { ...DAY_ONE_RULES.betTypes.teaser, sameGame: open },
      },
    };
    expect(codes(parlay([spread("home", -3), total("over", 44.5)]), loose)).toEqual([]);
    expect(codes(parlay([ml("away", 130), total("under", 44.5)]), loose)).toEqual([]);
    expect(codes(parlay([spread("home", -3), ml("home", -160)]), loose)).toEqual([]);
    expect(codes(parlay([ml("home", -160), ml("away", 140)]), loose)).toEqual([]);
    expect(codes(teaser([spread("home", -3), spread("away", 3), total("over", 44.5), total("under", 44.5)]), loose)).toEqual([]);
  });
  it("the same pick twice is always refused", () => {
    const open = { spreadTotal: true, moneylineTotal: true, spreadMoneyline: true, bothSides: true };
    const loose: RuleSet = { ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, parlay: { ...DAY_ONE_RULES.betTypes.parlay, sameGame: open } } };
    expect(codes(parlay([spread("home", -3), spread("home", -3)]))).toContain("same_game_duplicate");
    expect(codes(parlay([spread("home", -3), spread("home", -3)]), loose)).toContain("same_game_duplicate");
    expect(codes(teaser([spread("home", -3), spread("home", -3)]))).toContain("same_game_duplicate");
  });
});

describe("both sides of a game across separate bets", () => {
  it("both teams, by spread or moneyline in any mix, are opposite sides; so are the over and the under", () => {
    expect(oppositeSides(spread("home", -3), spread("away", 3))).toBe(true);
    expect(oppositeSides(spread("home", -3), ml("away", 140))).toBe(true);
    expect(oppositeSides(ml("home", -160), spread("away", 3))).toBe(true);
    expect(oppositeSides(total("over", 44.5), total("under", 44.5))).toBe(true);
    expect(oppositeSides(total("over", 44.5), total("under", 47))).toBe(true);
  });
  it("the same team twice, a team and a total, or another game aren't", () => {
    expect(oppositeSides(spread("home", -3), ml("home", -160))).toBe(false);
    expect(oppositeSides(spread("home", -3), total("under", 44.5))).toBe(false);
    expect(oppositeSides(spread("home", -3, "a"), spread("away", 3, "b"))).toBe(false);
    expect(oppositeSides(spread("home", -3, "ABC"), spread("away", 3, "abc"))).toBe(true);
  });
  it("a new bet against a pending one is refused unless the rules allow it", () => {
    const pending = [spread("home", -3, "a"), total("over", 41, "b")];
    expect(checkAcrossBets([ml("away", 140, "a")], pending, DAY_ONE_RULES).map((p) => p.code)).toEqual(["opposite_side"]);
    expect(checkAcrossBets([spread("home", -7, "c"), total("under", 41, "b")], pending, DAY_ONE_RULES)).toEqual([
      expect.objectContaining({ code: "opposite_side", leg: 1 }),
    ]);
    expect(checkAcrossBets([spread("home", -3.5, "a"), total("over", 40.5, "b")], pending, DAY_ONE_RULES)).toEqual([]);
    const allowed: RuleSet = { ...DAY_ONE_RULES, acrossBets: { oppositeSides: true } };
    expect(checkAcrossBets([ml("away", 140, "a")], pending, allowed)).toEqual([]);
  });
});

describe("validateSlip: legs and stakes", () => {
  it("checks points and prices", () => {
    expect(codes(parlay([spread("home", -3.25, "a"), ml("home", -120, "b")]))).toContain("leg_point");
    expect(codes(parlay([{ ...ml("home", -120, "a"), point: 1 }, ml("home", -120, "b")]))).toContain("leg_point");
    expect(codes(parlay([spread("home", -3, "a", -50), ml("home", -120, "b")]))).toContain("leg_price");
    expect(codes(parlay([{ ...spread("home", -3, "a"), side: "over" }, ml("home", -120, "b")]))).toContain("leg_side");
  });
  it("checks the stake", () => {
    const one = (stakeCents: number) => ({ type: "straight" as const, legs: [spread("home", -3)], stakeCents });
    expect(codes(one(0))).toContain("stake");
    expect(codes(one(10_050))).toContain("stake_increment"); // 100.50 units
    expect(codes(one(25_000_100))).toContain("stake_max"); // 250,001 units
    expect(codes(one(50_000), DAY_ONE_RULES, { availableCents: 49_999 })).toContain("stake_available");
    expect(codes(one(50_000), DAY_ONE_RULES, { availableCents: 50_000 })).toEqual([]);
  });
  it("enforces a stake cap as a percent of bank when set", () => {
    const capped: RuleSet = { ...DAY_ONE_RULES, stake: { ...DAY_ONE_RULES.stake, maxPctOfBank: 50 } };
    const s = { type: "straight" as const, legs: [spread("home", -3)], stakeCents: 600_000 };
    expect(codes(s, capped, { availableCents: 1_000_000, bankCents: 1_000_000 })).toContain("stake_pct");
    expect(codes({ ...s, stakeCents: 500_000 }, capped, { availableCents: 1_000_000, bankCents: 1_000_000 })).toEqual([]);
  });
});

describe("quoteSlip and pricing helpers", () => {
  it("quotes a straight bet at its own price", () => {
    expect(quoteSlip({ type: "straight", legs: [spread("home", -3)], stakeCents: 100_000 }, DAY_ONE_RULES)).toMatchObject({ american: -110, payoutCents: 190_909 });
  });
  it("quotes a parlay by multiplying decimals: +811, 91116", () => {
    const q = quoteSlip(parlay([spread("home", -3, "a"), total("over", 44.5, "b"), ml("away", 150, "c")]), DAY_ONE_RULES);
    expect(q).toMatchObject({ american: 811, payoutCents: 91_116 });
  });
  it("quotes a teaser from the table: 3 legs at 6 points = +180, 28000", () => {
    const q = quoteSlip(teaser([spread("home", -7, "a"), total("over", 44.5, "b"), spread("away", 2.5, "c")]), DAY_ONE_RULES);
    expect(q).toMatchObject({ american: 180, payoutCents: 28_000 });
  });
  it("moves teaser legs in the bettor's favor", () => {
    expect(teasedPoint(spread("home", -7), 6)).toBe(-1);
    expect(teasedPoint(spread("away", 3), 6)).toBe(9);
    expect(teasedPoint(total("over", 44.5), 6)).toBe(38.5);
    expect(teasedPoint(total("under", 41), 7)).toBe(48);
    expect(() => teasedPoint(ml("home", -150), 6)).toThrow();
  });
  it("prices straight legs at the book price, or flat when the rules say so", () => {
    const flat: RuleSet = { ...DAY_ONE_RULES, pricing: { straight: "flat", flatPrice: -110 } };
    expect(effectivePrice("spread", -118, DAY_ONE_RULES)).toBe(-118);
    expect(effectivePrice("spread", -118, flat)).toBe(-110);
    expect(effectivePrice("total", -102, flat)).toBe(-110);
    expect(effectivePrice("moneyline", 145, flat)).toBe(145);
  });
});

describe("validateRuleSet", () => {
  it("accepts the day-one rules", () => {
    expect(validateRuleSet(DAY_ONE_RULES)).toEqual([]);
  });
  it("requires a teaser price for every leg count and points option", () => {
    const prices = structuredClone(DAY_ONE_RULES.betTypes.teaser.prices);
    delete prices["6"]!["7"];
    const r: RuleSet = { ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, teaser: { ...DAY_ONE_RULES.betTypes.teaser, prices } } };
    expect(validateRuleSet(r).map((p) => p.code)).toContain("teaser_prices");
  });
  it("refuses teased moneylines and one-leg parlays", () => {
    const r: RuleSet = {
      ...DAY_ONE_RULES,
      betTypes: {
        ...DAY_ONE_RULES.betTypes,
        parlay: { ...DAY_ONE_RULES.betTypes.parlay, minLegs: 1 },
        teaser: { ...DAY_ONE_RULES.betTypes.teaser, markets: ["spread", "moneyline"] },
      },
    };
    const c = validateRuleSet(r).map((p) => p.code);
    expect(c).toContain("teaser_markets");
    expect(c).toContain("parlay_legs");
  });

  const withTeaser = (t: Partial<RuleSet["betTypes"]["teaser"]>): RuleSet =>
    ({ ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, teaser: { ...DAY_ONE_RULES.betTypes.teaser, ...t } } });
  const withStake = (st: Partial<RuleSet["stake"]>): RuleSet => ({ ...DAY_ONE_RULES, stake: { ...DAY_ONE_RULES.stake, ...st } });

  it("needs at least one bet type, and each teaser points option once", () => {
    const off = (t: keyof RuleSet["betTypes"]) => ({ ...DAY_ONE_RULES.betTypes[t], enabled: false });
    const none: RuleSet = { ...DAY_ONE_RULES, betTypes: { straight: off("straight"), parlay: off("parlay"), teaser: off("teaser") } as RuleSet["betTypes"] };
    expect(validateRuleSet(none).map((p) => p.code)).toContain("bet_types");
    expect(validateRuleSet(withTeaser({ points: [6, 6, 7] })).map((p) => p.code)).toContain("teaser_points");
  });

  it("needs yes-or-no answers for undo after a line move and for both sides across bets", () => {
    const bad = { ...DAY_ONE_RULES, undoAfterLineMove: "no", acrossBets: {} } as unknown as RuleSet;
    const c = validateRuleSet(bad).map((p) => p.code);
    expect(c).toContain("undo_line_move");
    expect(c).toContain("across_bets");
  });

  it("refuses leg limits that aren't whole numbers", () => {
    const r: RuleSet = { ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, parlay: { ...DAY_ONE_RULES.betTypes.parlay, maxLegs: 10.5 } } };
    expect(validateRuleSet(r).map((p) => p.code)).toContain("parlay_legs");
    expect(validateRuleSet(withTeaser({ maxLegs: 9.5 })).map((p) => p.code)).toContain("teaser_legs");
  });
  it("refuses stake limits that aren't whole cents", () => {
    for (const st of [{ incrementUnits: 0.001 }, { minUnits: 1.005 }, { maxUnits: 0 }, { minUnits: Number.NaN }]) {
      expect(validateRuleSet(withStake(st)).map((p) => p.code)).toContain("stake");
    }
    expect(validateRuleSet(withStake({ minUnits: 2.5, incrementUnits: 0.5 }))).toEqual([]);
  });
  it("needs the 2-leg teaser row even when a new card needs 3 legs, since pushes cut cards down", () => {
    const prices = structuredClone(DAY_ONE_RULES.betTypes.teaser.prices);
    delete prices["6"]!["2"];
    expect(validateRuleSet(withTeaser({ minLegs: 3, prices })).map((p) => p.message)).toContain("The teaser table needs a valid price for 2 legs at 6 points.");
    expect(validateRuleSet(withTeaser({ minLegs: 3 }))).toEqual([]);
  });
  it("needs each teaser row to pay more than the row above it", () => {
    const prices = structuredClone(DAY_ONE_RULES.betTypes.teaser.prices);
    prices["6"]!["4"] = 170; // below the 3-leg +180
    expect(validateRuleSet(withTeaser({ prices })).map((p) => p.message)).toContain("At 6 points, 4 legs must pay more than 3 legs.");
  });
  it("refuses numbers the editor couldn't read, or that arrive as null", () => {
    // An unreadable number is NaN in the editor, and NaN becomes null on its way to the server.
    const bad = null as unknown as number;
    const cases: [RuleSet, string][] = [
      [withStake({ maxPctOfBank: Number.NaN }), "stake_pct"],
      [{ ...DAY_ONE_RULES, undoMinutes: Number.NaN }, "undo"],
      [{ ...DAY_ONE_RULES, undoMinutes: bad }, "undo"],
      [{ ...DAY_ONE_RULES, weeklyMinimum: { ...DAY_ONE_RULES.weeklyMinimum, pct: bad } }, "weekly_pct"],
      [{ ...DAY_ONE_RULES, bank: { ...DAY_ONE_RULES.bank, bonusUnits: Number.NaN } }, "bank"],
      [{ ...DAY_ONE_RULES, bank: { ...DAY_ONE_RULES.bank, startUnits: bad } }, "bank"],
    ];
    for (const [r, code] of cases) expect(validateRuleSet(r).map((p) => p.code)).toContain(code);
    expect(validateRuleSet(withStake({ maxPctOfBank: null }))).toEqual([]);
  });
});

describe("validateSlip: payout size", () => {
  it("refuses a win that wouldn't pay back more than the stake", () => {
    // 1 unit at -100000 pays 100.1 cents, which rounds to the 100-cent stake.
    expect(codes({ type: "straight", legs: [ml("home", -100_000)], stakeCents: 100 })).toEqual(["payout_too_small"]);
    expect(codes({ type: "straight", legs: [ml("home", -100_000)], stakeCents: 100_000 })).toEqual([]);
  });
  it("refuses a payout too large to count exactly", () => {
    const tenLongShots = games(10, (g) => ml("away", 1000, g));
    expect(codes(parlay(tenLongShots, 25_000_000))).toEqual(["payout_too_large"]);
    expect(codes(parlay(tenLongShots, 100))).toEqual([]);
  });
});
