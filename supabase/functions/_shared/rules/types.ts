// Shared types for the league's rules engine. Used by the web app and the
// Edge Functions, so everything here is plain TypeScript with no imports.

export type Market = "spread" | "total" | "moneyline";
/** spread and moneyline use home/away; totals use over/under. */
export type Side = "home" | "away" | "over" | "under";
export type BetType = "straight" | "parlay" | "teaser";
export type LegResult = "pending" | "won" | "lost" | "push" | "void";
export type SlipResult = "pending" | "won" | "lost" | "push" | "void";
export type TeaserPushRule = "reduce" | "refund" | "lose";

/** One selection on a slip, as quoted when the slip was built. */
export interface Leg {
  gameId: string;
  market: Market;
  side: Side;
  /** Spread: this side's handicap (home -3.5). Total: the total (44.5). Moneyline: null. */
  point: number | null;
  /** American odds as quoted, e.g. -110 or +150. */
  price: number;
}

export interface SlipInput {
  type: BetType;
  legs: Leg[];
  /** Stake in cents (1 unit = 100 cents). */
  stakeCents: number;
  /** Teasers only: 6, 6.5, 7, ... */
  teaserPoints?: number | null;
}

/** Which same-game combinations a parlay or teaser allows. */
export interface SameGameRules {
  spreadTotal: boolean;
  moneylineTotal: boolean;
  /** A spread with either team's moneyline. */
  spreadMoneyline: boolean;
  /** Both sides of one market: over + under, both spreads, both moneylines. */
  bothSides: boolean;
}

/** Teaser prices: points ("6", "6.5") -> legs ("2".."10") -> American odds. */
export type TeaserPriceTable = Record<string, Record<string, number>>;

export interface RuleSet {
  betTypes: {
    straight: { enabled: boolean; markets: Market[] };
    parlay: {
      enabled: boolean;
      minLegs: number;
      maxLegs: number;
      markets: Market[];
      sameGame: SameGameRules;
    };
    teaser: {
      enabled: boolean;
      minLegs: number;
      maxLegs: number;
      markets: Market[];
      points: number[];
      prices: TeaserPriceTable;
      pushRule: TeaserPushRule;
      /** Splash's rule: a total may only be teased alongside at least one spread. */
      totalsNeedSpread: boolean;
      sameGame: SameGameRules;
    };
  };
  pricing: {
    /** "book": the posted price. "flat": spreads and totals at flatPrice. */
    straight: "book" | "flat";
    flatPrice: number;
  };
  stake: {
    minUnits: number;
    maxUnits: number;
    /** Stakes must be a multiple of this many units. */
    incrementUnits: number;
    /** Optional cap as a percent of the entry's bank, e.g. 50. */
    maxPctOfBank: number | null;
  };
  /** Minutes after placing during which a member may undo a bet (before kickoff). */
  undoMinutes: number;
  weeklyMinimum: {
    /** Percent of the bank at the start of the week, e.g. 30. */
    pct: number;
    penalty: "deduct_shortfall" | "warn" | "none";
  };
  visibility: "kickoff_per_leg" | "on_placement" | "week_first_kickoff";
  lock: "game_kickoff" | "week_first_kickoff";
  bank: { startUnits: number; bonusUnits: number };
}

export interface Problem {
  code: string;
  message: string;
  /** Index of the leg the problem is about, when it is about one leg. */
  leg?: number;
}

export interface FinalScore {
  homeScore: number;
  awayScore: number;
}
