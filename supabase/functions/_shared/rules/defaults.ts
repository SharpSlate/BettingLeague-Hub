import { DEFAULT_PROPS } from "./props.ts";
import type { RuleSet } from "./types.ts";

// The day-one rule set agreed on 2026-09-28 (see DECISIONS.md). The 2- and
// 3-leg teaser rows are Splash's; for 4-10 legs, each leg past 3 needs 0.35 points
// more to break even than a 3-leg card's legs, rounded down (docs/DESIGN.md section 3).
export const DAY_ONE_RULES: RuleSet = {
  betTypes: {
    straight: { enabled: true, markets: ["spread", "total", "moneyline"] },
    parlay: {
      enabled: true,
      minLegs: 2,
      maxLegs: 10,
      markets: ["spread", "total", "moneyline"],
      sameGame: { spreadTotal: false, moneylineTotal: false, spreadMoneyline: false, bothSides: false },
    },
    teaser: {
      enabled: true,
      minLegs: 2,
      maxLegs: 10,
      markets: ["spread", "total"],
      points: [6, 6.5, 7],
      prices: {
        "6": { "2": -110, "3": 180, "4": 285, "5": 425, "6": 615, "7": 860, "8": 1150, "9": 1550, "10": 2100 },
        "6.5": { "2": -120, "3": 160, "4": 250, "5": 365, "6": 520, "7": 710, "8": 955, "9": 1250, "10": 1600 },
        "7": { "2": -130, "3": 140, "4": 215, "5": 310, "6": 425, "7": 575, "8": 755, "9": 975, "10": 1200 },
      },
      pushRule: "reduce",
      totalsNeedSpread: false,
      sameGame: { spreadTotal: false, moneylineTotal: false, spreadMoneyline: false, bothSides: false },
    },
  },
  pricing: { straight: "book", flatPrice: -110 },
  stake: { minUnits: 1, maxUnits: 250_000, incrementUnits: 1, maxPctOfBank: null },
  undoMinutes: 5,
  undoAfterLineMove: false,
  acrossBets: { oppositeSides: false },
  weeklyMinimum: { pct: 30, penalty: "deduct_shortfall" },
  visibility: "kickoff_per_leg",
  lock: "game_kickoff",
  bank: { startUnits: 10_000, bonusUnits: 5_000 },
  // Off until a commissioner turns them on (2026-10-05).
  props: DEFAULT_PROPS,
};
