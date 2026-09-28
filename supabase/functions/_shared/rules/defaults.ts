import type { RuleSet } from "./types.ts";

// The day-one rule set agreed on 2026-09-28 (see DECISIONS.md). The 2- and
// 3-leg teaser rows are Splash's; 4-10 legs keep the per-leg break-even that
// Splash's 3-leg price implies, rounded down (docs/DESIGN.md section 3).
export const DAY_ONE_RULES: RuleSet = {
  betTypes: {
    straight: { enabled: true, markets: ["spread", "total", "moneyline"] },
    parlay: {
      enabled: true,
      minLegs: 2,
      maxLegs: 10,
      markets: ["spread", "total", "moneyline"],
      sameGame: { spreadTotal: true, moneylineTotal: true, spreadMoneyline: false, bothSides: false },
    },
    teaser: {
      enabled: true,
      minLegs: 2,
      maxLegs: 10,
      markets: ["spread", "total"],
      points: [6, 6.5, 7],
      prices: {
        "6": { "2": -110, "3": 180, "4": 290, "5": 455, "6": 680, "7": 1000, "8": 1450, "9": 2050, "10": 2950 },
        "6.5": { "2": -120, "3": 160, "4": 255, "5": 390, "6": 570, "7": 820, "8": 1150, "9": 1650, "10": 2300 },
        "7": { "2": -130, "3": 140, "4": 220, "5": 330, "6": 475, "7": 670, "8": 930, "9": 1250, "10": 1750 },
      },
      pushRule: "reduce",
      totalsNeedSpread: false,
      sameGame: { spreadTotal: true, moneylineTotal: true, spreadMoneyline: true, bothSides: true },
    },
  },
  pricing: { straight: "book", flatPrice: -110 },
  stake: { minUnits: 1, maxUnits: 250_000, incrementUnits: 1, maxPctOfBank: null },
  undoMinutes: 5,
  weeklyMinimum: { pct: 30, penalty: "deduct_shortfall" },
  visibility: "kickoff_per_leg",
  lock: "game_kickoff",
  bank: { startUnits: 10_000, bonusUnits: 5_000 },
};
