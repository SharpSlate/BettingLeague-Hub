// ESPN's public NFL scoreboard (free, no key), used as a second source for final
// scores. A game goes final only when ESPN shows the same final as The Odds API, so
// one feed's wrong score doesn't move banks. Pure code apart from the injected fetch,
// so it runs under Deno in the Edge Functions and under Node in the tests.
//
// ESPN answers 403 to a browser-style User-Agent sent from a server, so requests go
// out with the runtime's own.

import type { NormalizedScore, OddsApiScoreEvent } from "./odds-api.ts";

export const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

/** One day's scoreboard (`day` is YYYYMMDD), or the current week's when `day` is empty. */
export function espnUrl(day: string): string {
  return `${ESPN_SCOREBOARD}?${new URLSearchParams(day ? { dates: day, limit: "100" } : { limit: "100" })}`;
}

export interface EspnGame {
  /** ESPN's event id, for its box score. */
  id: string;
  start: string;
  completed: boolean;
  /** Each team's score by its full name ("Baltimore Ravens"), as ESPN and The Odds API both write it. */
  scores: Map<string, number>;
}

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

function scoreOf(x: unknown): number | null {
  if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? x : null;
  if (typeof x === "string" && /^\s*\d{1,3}\s*$/.test(x)) return Number(x);
  return null;
}

/** The games in a scoreboard answer that have two named teams with scores. Anything malformed is skipped. */
export function parseEspn(body: unknown): EspnGame[] {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  const out: EspnGame[] = [];
  for (const ev of events) {
    const c = ev?.competitions?.[0];
    const start = c?.date ?? ev?.date;
    if (typeof start !== "string" || !Array.isArray(c?.competitors) || c.competitors.length !== 2) continue;
    const scores = new Map<string, number>();
    for (const t of c.competitors) {
      const name = t?.team?.displayName;
      const s = scoreOf(t?.score);
      if (typeof name === "string" && name && s !== null) scores.set(key(name), s);
    }
    if (scores.size !== 2) continue;
    const type = c.status?.type ?? ev.status?.type;
    out.push({ id: String(ev?.id ?? ""), start, completed: type?.completed === true, scores });
  }
  return out;
}

/** The YYYYMMDD days to ask ESPN for: each game's date in the league's time zone and in UTC. */
export function espnDays(starts: string[], timeZone: string): string[] {
  const fmt = (d: Date, tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");
  const days = new Set<string>();
  for (const s of starts) {
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) continue;
    days.add(fmt(d, timeZone));
    days.add(fmt(d, "UTC"));
  }
  return [...days].sort();
}

export interface Confirmed {
  /** The scores to store: a final ESPN doesn't confirm is sent as not completed, so the game stays live. */
  scores: NormalizedScore[];
  /** Why finals were held, for the Admin page. A final ESPN simply hasn't posted yet isn't listed. */
  held: string[];
}

/**
 * Checks each final The Odds API reports against ESPN. It's kept final only when ESPN
 * has the same two teams, starting within 12 hours, final with the same scores. If
 * ESPN can't be reached, doesn't list the game, or has a different final, the game is
 * held (it stays live) and the reason is returned; an admin can enter the final by
 * hand. Games ESPN shows still in progress are held without a note: ESPN usually
 * posts its final within minutes, and a game still live 5 hours after kickoff is
 * already flagged on the Admin page.
 */
export async function confirmFinals(
  events: OddsApiScoreEvent[],
  scores: NormalizedScore[],
  fetchImpl: (url: string) => Promise<Response>,
  timeZone: string,
): Promise<Confirmed> {
  const byId = new Map(events.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]));
  const finals = scores.filter((s) => s.completed && byId.has(s.id));
  if (!finals.length) return { scores, held: [] };

  const espn: EspnGame[] = [];
  const failed: string[] = [];
  // Each final's day, plus the current week's scoreboard in case a dated request
  // comes back without the game. Games are matched by teams and start time, so extra
  // games in an answer don't matter.
  for (const day of [...espnDays(finals.map((s) => byId.get(s.id)!.commence_time), timeZone), ""]) {
    try {
      const res = await fetchImpl(espnUrl(day));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      espn.push(...parseEspn(await res.json()));
    } catch (e) {
      failed.push(`${day || "this week"} (${e instanceof Error ? e.message : String(e)})`.slice(0, 80));
    }
  }

  const held: string[] = [];
  const out = scores.map((s) => {
    const ev = byId.get(s.id);
    if (!s.completed || !ev) return s;
    const home = key(ev.home_team);
    const away = key(ev.away_team);
    const start = Date.parse(ev.commence_time);
    const match = espn.find((g) =>
      g.scores.has(home) && g.scores.has(away) && home !== away && Math.abs(Date.parse(g.start) - start) <= 12 * 3_600_000,
    );
    const label = `${ev.away_team} at ${ev.home_team} (${s.awayScore}-${s.homeScore})`;
    if (!match) {
      held.push(failed.length ? `${label}: couldn't check ESPN: ${failed.join(", ")}` : `${label}: ESPN doesn't list this game`);
    } else if (match.completed) {
      if (match.scores.get(home) === s.homeScore && match.scores.get(away) === s.awayScore) return s;
      held.push(`${label}: ESPN's final is ${match.scores.get(away)}-${match.scores.get(home)}. Enter the right final score by hand.`);
    }
    return { ...s, completed: false };
  });
  return { scores: out, held };
}

// ---------------------------------------------------------------- box scores (player props)

export const ESPN_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary";

export const espnSummaryUrl = (eventId: string) => `${ESPN_SUMMARY}?${new URLSearchParams({ event: eventId })}`;

/** One player's line in a box score, as ingest_box_internal takes it. */
export interface BoxPlayer {
  player: string;
  team: string | null;
  passYds: number;
  rushYds: number;
  recYds: number;
  receptions: number;
  /** Touchdowns he scored himself: rushing, receiving, kick and punt returns, defensive returns. */
  tds: number;
}

const TD_KEYS = ["rushingTouchdowns", "receivingTouchdowns", "kickReturnTouchdowns", "puntReturnTouchdowns",
  "interceptionTouchdowns", "defensiveTouchdowns"];

function statNum(x: unknown): number {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x.trim()) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Every player in a game summary's box score (any category: passing, rushing,
 * receiving, returns, defense...), with the stats props grade on. Someone in no
 * category isn't in the result. A touchdown counted in two categories (a pick-six as
 * both an interception and a defensive TD) can count twice, which only matters past
 * "scored at least one".
 */
export function parseBox(body: unknown): BoxPlayer[] {
  const teams = (body as { boxscore?: { players?: unknown } })?.boxscore?.players;
  if (!Array.isArray(teams)) return [];
  const byId = new Map<string, BoxPlayer & { tdKeys: Set<string> }>();
  for (const t of teams) {
    const team = typeof t?.team?.abbreviation === "string" ? t.team.abbreviation : null;
    for (const cat of Array.isArray(t?.statistics) ? t.statistics : []) {
      const keys: unknown[] = Array.isArray(cat?.keys) ? cat.keys : [];
      for (const a of Array.isArray(cat?.athletes) ? cat.athletes : []) {
        const name = a?.athlete?.displayName;
        if (typeof name !== "string" || !name.trim()) continue;
        const id = String(a?.athlete?.id ?? `${team}|${name}`);
        let p = byId.get(id);
        if (!p) {
          p = { player: name.trim(), team, passYds: 0, rushYds: 0, recYds: 0, receptions: 0, tds: 0, tdKeys: new Set() };
          byId.set(id, p);
        }
        const stats: unknown[] = Array.isArray(a?.stats) ? a.stats : [];
        const st = new Map(keys.map((k, i) => [String(k), stats[i]]));
        if (cat.name === "passing") p.passYds = statNum(st.get("passingYards"));
        if (cat.name === "rushing") p.rushYds = statNum(st.get("rushingYards"));
        if (cat.name === "receiving") {
          p.recYds = statNum(st.get("receivingYards"));
          p.receptions = statNum(st.get("receptions"));
        }
        for (const k of TD_KEYS) {
          if (st.has(k) && !p.tdKeys.has(k)) {
            p.tds += Math.max(0, statNum(st.get(k)));
            p.tdKeys.add(k);
          }
        }
      }
    }
  }
  return [...byId.values()].map(({ tdKeys: _k, ...p }) => p);
}

/** The ESPN game with these two teams (full names) starting within 12 hours of `start`. */
export function findEspnGame(games: EspnGame[], homeTeam: string, awayTeam: string, start: string): EspnGame | undefined {
  const home = key(homeTeam);
  const away = key(awayTeam);
  const t = Date.parse(start);
  return games.find((g) => g.scores.has(home) && g.scores.has(away) && home !== away && Math.abs(Date.parse(g.start) - t) <= 12 * 3_600_000);
}
