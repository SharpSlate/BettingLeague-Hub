// Player props: which markets there are, how a player's name is matched across
// sources, and which stat grades each market.
import type { Market, PlayerStats, PropMarket, PropRules, RuleSet, Side } from "./types.ts";

export const PROP_MARKETS: PropMarket[] = ["anytime_td", "receptions", "rush_yds", "rec_yds", "pass_yds"];

/** What the props settings are when a commissioner first turns them on. */
export const DEFAULT_PROPS: PropRules = { enabled: false, markets: [...PROP_MARKETS], maxPerGame: 2, maxStakePct: 50 };

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
