// Player props: which markets there are, how a player's name is matched across
// sources, and which stat grades each market.
import type { Market, PlayerStats, PropMarket, PropRules, RuleSet, Side } from "./types.ts";

export const PROP_MARKETS: PropMarket[] = ["anytime_td", "receptions", "rush_yds", "rec_yds", "pass_yds"];

/**
 * What the props settings are when a commissioner first turns them on: one prop per game
 * in a parlay (two from one game, like a quarterback's yards and his receiver's, tend to
 * hit together, and a parlay pays as if they didn't), a stake of at most 2% of the
 * league's maximum, and at most 3 props in a parlay.
 */
export const DEFAULT_PROPS: PropRules = { enabled: false, markets: [...PROP_MARKETS], maxPerGame: 1, maxStakePct: 2, maxPerParlay: 3 };

/**
 * Teams name their inactive players this long before kickoff, and prop lines move on it.
 * From then on a game's props can only be bet on lines pulled after that point.
 */
export const PROP_INACTIVES_MINUTES = 90;

/**
 * Why a game's props can't be bet right now, or null when they can: "stale" when the
 * latest props are older than the league allows (or there are none), "inactives" when
 * the game is within PROP_INACTIVES_MINUTES of locking and the latest props were pulled
 * before that. place_slip_internal checks the same.
 */
export function propsClosed(
  locksAt: Date | string,
  pulledAt: Date | string | null | undefined,
  now: Date | number,
  maxAgeMinutes: number,
): "stale" | "inactives" | null {
  if (!pulledAt) return "stale";
  const pulled = new Date(pulledAt).getTime();
  const t = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(pulled) || t - pulled > maxAgeMinutes * 60_000) return "stale";
  const cutoff = new Date(locksAt).getTime() - PROP_INACTIVES_MINUTES * 60_000;
  return t >= cutoff && pulled < cutoff ? "inactives" : null;
}

export function isProp(market: Market | string): market is PropMarket {
  return (PROP_MARKETS as string[]).includes(market);
}

/** The sides a prop market takes: an anytime TD is a yes, the stats over or under. */
export function propSides(market: PropMarket): Side[] {
  return market === "anytime_td" ? ["yes"] : ["over", "under"];
}

/** The rule set's props settings when props are on, else null. */
export function activeProps(rules: RuleSet): PropRules | null {
  return rules.props?.enabled ? rules.props : null;
}

/**
 * A player's name reduced for matching the line source against the box score:
 * lowercase letters and spaces only, with suffixes (Jr., Sr., II...) dropped, so
 * "Aaron Jones Sr." and "Aaron Jones" match. The database's app.player_key does the same.
 */
export function playerKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .split(" ")
    .filter((w) => w && !["jr", "sr", "ii", "iii", "iv", "v"].includes(w))
    .join(" ");
}

/** The stat a market grades on (anytime TD: touchdowns scored). */
export function propStat(market: PropMarket, s: PlayerStats): number {
  switch (market) {
    case "anytime_td":
      return s.tds;
    case "receptions":
      return s.receptions;
    case "rush_yds":
      return s.rushYds;
    case "rec_yds":
      return s.recYds;
    case "pass_yds":
      return s.passYds;
  }
}

export const PROP_LABEL: Record<PropMarket, string> = {
  anytime_td: "Anytime TD",
  receptions: "Receptions",
  rush_yds: "Rushing yards",
  rec_yds: "Receiving yards",
  pass_yds: "Passing yards",
};
