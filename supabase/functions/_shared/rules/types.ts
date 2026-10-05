// Shared types for the league's rules engine. Used by the web app and the
// Edge Functions, so everything here is plain TypeScript with no imports.

/** A game's own markets. */
export type GameMarket = "spread" | "total" | "moneyline";
/** Player props: one player's anytime touchdown, or the over/under on one of his stats. */
export type PropMarket = "anytime_td" | "receptions" | "rush_yds" | "rec_yds" | "pass_yds";
export type Market = GameMarket | PropMarket;
/** spread and moneyline use home/away; totals and stat props over/under; an anytime TD is "yes". */
export type Side = "home" | "away" | "over" | "under" | "yes";
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
  /** A player prop's player, as the line source names him. Null or absent for a game's own markets. */
  player?: string | null;
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

/**
 * Player props. Fixed rules on top of these settings: props go in straight bets and
 * parlays (never teasers), one pick per player per slip, and a prop can't share a
 * parlay with its game's spread, total or moneyline.
 */
export interface PropRules {
  enabled: boolean;
  markets: PropMarket[];
  /** In a parlay, at most this many legs from one game once one of them is a prop. */
  maxPerGame: number;
  /** A bet with a prop can stake at most this percent of the league's maximum stake. */
  maxStakePct: number;
}

export interface RuleSet {
  betTypes: {
    straight: { enabled: boolean; markets: GameMarket[] };
    parlay: {
      enabled: boolean;
      minLegs: number;
      maxLegs: number;
      markets: GameMarket[];
      sameGame: SameGameRules;
    };
    teaser: {
      enabled: boolean;
      minLegs: number;
      maxLegs: number;
      markets: GameMarket[];
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
  /**
   * Whether a bet can still be undone once one of its lines has changed since it was
   * placed. Off, undo is only for fixing mistakes: it can't be used to take back a bet
   * after news has moved the line against it.
   */
  undoAfterLineMove: boolean;
  /** What an entry's separate bets may do together. (One slip follows its own same-game rules.) */
  acrossBets: {
    /**
     * Whether an entry may back both teams in one game (by spread or moneyline, in any
     * mix), or both the over and the under, in separate bets. Off, the weekly minimum
     * can't be met by betting both sides for the cost of the vig.
     */
    oppositeSides: boolean;
  };
  weeklyMinimum: {
    /** Percent of the bank at the start of the week, e.g. 30. */
    pct: number;
    penalty: "deduct_shortfall" | "warn" | "none";
  };
  visibility: "kickoff_per_leg" | "on_placement" | "week_first_kickoff";
  lock: "game_kickoff" | "week_first_kickoff";
  bank: { startUnits: number; bonusUnits: number };
  /** Missing from rule sets published before props existed, which means no props. */
  props?: PropRules;
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

/** One player's stats from a final box score, for grading props. */
export interface PlayerStats {
  passYds: number;
  rushYds: number;
  recYds: number;
  receptions: number;
  /** Touchdowns he scored himself: rushing, receiving, returns. Passing TDs don't count. */
  tds: number;
}
