import { describe, expect, it } from "vitest";
import { DAY_ONE_RULES } from "./defaults.ts";
import { gradeLeg, gradeSlip, type GradableSlip } from "./grade.ts";
import type { Leg, LegResult, RuleSet, TeaserPushRule } from "./types.ts";

const spread = (side: "home" | "away", point: number, gameId = "g1", price = -110): Leg => ({ gameId, market: "spread", side, point, price });
const total = (side: "over" | "under", point: number, gameId = "g1", price = -110): Leg => ({ gameId, market: "total", side, point, price });
const ml = (side: "home" | "away", price: number, gameId = "g1"): Leg => ({ gameId, market: "moneyline", side, point: null, price });
const score = (homeScore: number, awayScore: number) => ({ homeScore, awayScore });

function withPushRule(pushRule: TeaserPushRule): RuleSet {
  return { ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, teaser: { ...DAY_ONE_RULES.betTypes.teaser, pushRule } } };
}

describe("gradeLeg", () => {
  it.each<[string, Leg, number, number, number | null, string]>([
    // home -3, 27-24: 27 - 3 - 24 = 0
    ["spread push on the number", spread("home", -3), 27, 24, null, "push"],
    // away +3.5, 27-24: 24 + 3.5 - 27 = +0.5
    ["dog covers by the hook", spread("away", 3.5), 27, 24, null, "won"],
    // home -7.5, 31-24: 31 - 7.5 - 24 = -0.5
    ["favorite misses by the hook", spread("home", -7.5), 31, 24, null, "lost"],
    // pick'em, 20-17
    ["pick'em winner", spread("home", 0), 20, 17, null, "won"],
    // 27 + 20 = 47 on 47
    ["total push", total("over", 47), 27, 20, null, "push"],
    // 21 + 20 = 41 under 44.5
    ["under wins", total("under", 44.5), 21, 20, null, "won"],
    ["over loses", total("over", 44.5), 21, 20, null, "lost"],
    ["moneyline tie pushes", ml("home", -150), 20, 20, null, "push"],
    // home 17, away 20
    ["away moneyline wins", ml("away", 130), 17, 20, null, "won"],
    ["home moneyline loses", ml("home", -150), 17, 20, null, "lost"],
    // teased: home -7 + 6 = -1; 24 - 1 - 20 = +3 (untouched it loses: 24 - 7 - 20 = -3)
    ["teaser moves a favorite", spread("home", -7), 24, 20, 6, "won"],
    // teased: away +3 + 6 = +9; 21 + 9 - 30 = 0
    ["teaser push on a dog", spread("away", 3), 30, 21, 6, "push"],
    // teased: over 44.5 - 6 = 38.5; 20 + 19 = 39
    ["teaser lowers an over", total("over", 44.5), 20, 19, 6, "won"],
    // teased: under 41 + 7 = 48; 24 + 24 = 48
    ["teaser push on an under", total("under", 41), 24, 24, 7, "push"],
    // teased: home -2.5 + 6.5 = +4; 17 + 4 - 21 = 0
    ["6.5-point teaser push", spread("home", -2.5), 17, 21, 6.5, "push"],
  ])("%s", (_name, leg, home, away, teaser, expected) => {
    expect(gradeLeg(leg, score(home, away), teaser)).toBe(expected);
  });

  it("a voided game voids the leg", () => {
    expect(gradeLeg(spread("home", -3), "void")).toBe("void");
  });

  it("the untouched favorite from the teaser case loses", () => {
    expect(gradeLeg(spread("home", -7), score(24, 20))).toBe("lost");
  });
});

const slip = (type: GradableSlip["type"], legs: Leg[], stakeCents: number, teaserPoints: number | null = null): GradableSlip => ({
  type,
  legs,
  stakeCents,
  teaserPoints,
});
const three = [spread("home", -3, "a"), total("over", 44.5, "b"), spread("away", 2.5, "c")];
const results = (...r: LegResult[]) => r;

describe("gradeSlip: straight", () => {
  const s = slip("straight", [spread("home", -3, "a", -110)], 100_000);
  it("win pays stake x 21/11 = 190909.09 -> 190909 cents", () => {
    expect(gradeSlip(s, results("won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 190_909 });
  });
  it("push and void return the stake", () => {
    expect(gradeSlip(s, results("push"), DAY_ONE_RULES)).toEqual({ result: "push", payoutCents: 100_000 });
    expect(gradeSlip(s, results("void"), DAY_ONE_RULES)).toEqual({ result: "void", payoutCents: 100_000 });
  });
  it("loss pays nothing", () => {
    expect(gradeSlip(s, results("lost"), DAY_ONE_RULES)).toEqual({ result: "lost", payoutCents: 0 });
  });
  it("waits while pending", () => {
    expect(gradeSlip(s, results("pending"), DAY_ONE_RULES).result).toBe("pending");
  });
});

describe("gradeSlip: parlay", () => {
  // -110, -110, +150 at 100 units = 10000 cents
  const p = slip("parlay", [spread("home", -3, "a", -110), total("over", 44.5, "b", -110), ml("away", 150, "c")], 10_000);
  it("all win: 10000 x (21/11)^2 x 5/2 = 91115.70 -> 91116", () => {
    expect(gradeSlip(p, results("won", "won", "won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 91_116 });
  });
  it("a push drops out: 10000 x (21/11)^2 = 36446.28 -> 36446", () => {
    expect(gradeSlip(p, results("won", "won", "push"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 36_446 });
  });
  it("a void leg drops out too: one -110 winner left = 19091", () => {
    const two = slip("parlay", [spread("home", -3, "a", -110), spread("home", -3, "b", -110)], 10_000);
    expect(gradeSlip(two, results("void", "won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 19_091 });
  });
  it("any loss loses, even with legs still pending", () => {
    expect(gradeSlip(p, results("won", "lost", "pending"), DAY_ONE_RULES)).toEqual({ result: "lost", payoutCents: 0 });
  });
  it("waits while a leg is pending and none lost", () => {
    expect(gradeSlip(p, results("won", "pending", "won"), DAY_ONE_RULES).result).toBe("pending");
  });
  it("all pushed refunds; all void is void", () => {
    expect(gradeSlip(p, results("push", "push", "void"), DAY_ONE_RULES)).toEqual({ result: "push", payoutCents: 10_000 });
    expect(gradeSlip(p, results("void", "void", "void"), DAY_ONE_RULES)).toEqual({ result: "void", payoutCents: 10_000 });
  });
  it("10 legs at -110 for 10 units: 1000 x (21/11)^10 = 643081.62 -> 643082", () => {
    const legs = Array.from({ length: 10 }, (_, i) => spread("home", -3, `g${i}`, -110));
    expect(gradeSlip(slip("parlay", legs, 1_000), Array(10).fill("won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 643_082 });
  });
});

describe("gradeSlip: teaser", () => {
  const t3 = slip("teaser", three, 10_000, 6);
  it("3 legs at 6 points, all win: +180 -> 10000 x 14/5 = 28000", () => {
    expect(gradeSlip(t3, results("won", "won", "won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 28_000 });
  });
  it("reduce: one push -> 2-leg price -110 -> 19091", () => {
    expect(gradeSlip(t3, results("won", "push", "won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 19_091 });
  });
  it("reduce: two pushes -> the lone leg gets the 2-leg price -> 19091", () => {
    expect(gradeSlip(t3, results("push", "won", "push"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 19_091 });
  });
  it("reduce: all pushed refunds", () => {
    expect(gradeSlip(t3, results("push", "push", "push"), DAY_ONE_RULES)).toEqual({ result: "push", payoutCents: 10_000 });
  });
  it("refund rule: any push refunds the card", () => {
    expect(gradeSlip(t3, results("won", "push", "won"), withPushRule("refund"))).toEqual({ result: "push", payoutCents: 10_000 });
  });
  it("lose rule: a push loses the card", () => {
    expect(gradeSlip(t3, results("won", "push", "won"), withPushRule("lose"))).toEqual({ result: "lost", payoutCents: 0 });
  });
  it("a void leg always reduces, even under the lose rule", () => {
    expect(gradeSlip(t3, results("won", "void", "won"), withPushRule("lose"))).toEqual({ result: "won", payoutCents: 19_091 });
  });
  it("any loss loses", () => {
    expect(gradeSlip(t3, results("won", "lost", "push"), DAY_ONE_RULES)).toEqual({ result: "lost", payoutCents: 0 });
  });
  it("2 legs at 6.5 points: -120 -> 10000 x 11/6 = 18333.33 -> 18333", () => {
    const t2 = slip("teaser", three.slice(0, 2), 10_000, 6.5);
    expect(gradeSlip(t2, results("won", "won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 18_333 });
  });
  it("3 legs at 7 points: +140 -> 24000", () => {
    expect(gradeSlip(slip("teaser", three, 10_000, 7), results("won", "won", "won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 24_000 });
  });
  it("4 legs at 6 points with a push: 3-leg price +180 -> 28000", () => {
    const t4 = slip("teaser", [...three, spread("home", -8, "d")], 10_000, 6);
    expect(gradeSlip(t4, results("won", "won", "push", "won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 28_000 });
  });
  const ten = Array.from({ length: 10 }, (_, i) => (i % 2 ? total("over", 44.5, `g${i}`) : spread("home", -7, `g${i}`)));
  it("10 legs at 6 points, all win: +2950 -> 10000 x 61/2 = 305000", () => {
    expect(gradeSlip(slip("teaser", ten, 10_000, 6), Array(10).fill("won"), DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 305_000 });
  });
  it("10 legs with one push: 9-leg price +2050 -> 215000", () => {
    const r = Array<LegResult>(10).fill("won");
    r[3] = "push";
    expect(gradeSlip(slip("teaser", ten, 10_000, 6), r, DAY_ONE_RULES)).toEqual({ result: "won", payoutCents: 215_000 });
  });
});

describe("grading uses the rule set the slip was placed under", () => {
  const t3 = slip("teaser", three, 10_000, 6);
  const v2: RuleSet = {
    ...withPushRule("refund"),
    betTypes: {
      ...DAY_ONE_RULES.betTypes,
      teaser: {
        ...DAY_ONE_RULES.betTypes.teaser,
        pushRule: "refund",
        prices: { ...DAY_ONE_RULES.betTypes.teaser.prices, "6": { ...DAY_ONE_RULES.betTypes.teaser.prices["6"], "3": 160 } },
      },
    },
  };
  it("same card, same results, different versions", () => {
    // v1: reduce -> 19091. v2: refund -> 10000.
    expect(gradeSlip(t3, results("won", "push", "won"), DAY_ONE_RULES).payoutCents).toBe(19_091);
    expect(gradeSlip(t3, results("won", "push", "won"), v2).payoutCents).toBe(10_000);
    // v1: +180 -> 28000. v2: +160 -> 26000.
    expect(gradeSlip(t3, results("won", "won", "won"), DAY_ONE_RULES).payoutCents).toBe(28_000);
    expect(gradeSlip(t3, results("won", "won", "won"), v2).payoutCents).toBe(26_000);
  });
});

describe("gradeSlip: a teaser cut down by pushes", () => {
  const threeLegMinimum: RuleSet = { ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, teaser: { ...DAY_ONE_RULES.betTypes.teaser, minLegs: 3 } } };
  const card: GradableSlip = { type: "teaser", stakeCents: 10_000, teaserPoints: 6, legs: [spread("home", -3, "a"), spread("home", -3, "b"), spread("home", -3, "c")] };
  it("pays the 2-leg price even when new cards need 3 legs", () => {
    // 100 units at -110 = 100 x 21/11 = 190.909... -> 19,091 cents, not the full 3-leg +180 (28,000).
    expect(gradeSlip(card, ["won", "push", "won"], threeLegMinimum)).toEqual({ result: "won", payoutCents: 19_091 });
    expect(gradeSlip(card, ["won", "push", "push"], threeLegMinimum)).toEqual({ result: "won", payoutCents: 19_091 });
    expect(gradeSlip(card, ["won", "won", "won"], threeLegMinimum)).toEqual({ result: "won", payoutCents: 28_000 });
  });
});
