// The Odds API (v4): request URLs, usage headers, and turning its responses into
// the shape the database's ingest functions take. Pure code, so it runs under Deno
// in the Edge Functions and under Node in the tests.
//
// Costs (per the v4 docs): odds = markets x regions, where up to 10 bookmakers count
// as one region, so DraftKings + FanDuel with three markets is 3 credits per call.
// Scores with daysFrom is 2 credits.

export const SPORT = "americanfootball_nfl";
export const BASE_URL = "https://api.the-odds-api.com/v4";

export interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}
export interface OddsApiMarket {
  key: string;
  last_update?: string;
  outcomes: OddsApiOutcome[];
}
export interface OddsApiBookmaker {
  key: string;
  title?: string;
  last_update?: string;
  markets: OddsApiMarket[];
}
export interface OddsApiEvent {
  id: string;
  sport_key?: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: OddsApiBookmaker[];
}
export interface OddsApiScoreEvent {
  id: string;
  sport_key?: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: { name: string; score: string }[] | null;
  last_update?: string | null;
}

export interface NormalizedOutcome {
  market: "spread" | "total" | "moneyline";
  side: "home" | "away" | "over" | "under";
  point: number | null;
  price: number;
}
export interface NormalizedEvent {
  id: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  books: { book: string; outcomes: NormalizedOutcome[] }[];
}
export interface NormalizedScore {
  id: string;
  completed: boolean;
  homeScore: number;
  awayScore: number;
}

export function oddsUrl(apiKey: string, books: string[]): string {
  const q = new URLSearchParams({
    apiKey,
    bookmakers: books.join(","),
    markets: "h2h,spreads,totals",
    oddsFormat: "american",
    dateFormat: "iso",
  });
  return `${BASE_URL}/sports/${SPORT}/odds?${q}`;
}

export function scoresUrl(apiKey: string): string {
  const q = new URLSearchParams({ apiKey, daysFrom: "1", dateFormat: "iso" });
  return `${BASE_URL}/sports/${SPORT}/scores?${q}`;
}

export interface Usage {
  used: number | null;
  remaining: number | null;
  /** The cost of this call. */
  last: number | null;
}

export function readUsage(headers: Headers): Usage {
  const n = (name: string) => {
    const v = headers.get(name);
    const x = v === null ? NaN : Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return { used: n("x-requests-used"), remaining: n("x-requests-remaining"), last: n("x-requests-last") };
}

const isHalf = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && Number.isInteger(x * 2);
const isAmerican = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && Math.abs(x) >= 100;

const isText = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/**
 * Keeps each book's spread, total and moneyline when both sides are present and sane:
 * whole or half points, valid American prices, spreads that mirror, totals that match.
 * Anything malformed (a missing field, an event with no teams or time) is skipped
 * rather than failing the whole pull, which has already been paid for.
 */
export function normalizeOdds(events: unknown): NormalizedEvent[] {
  if (!Array.isArray(events)) return [];
  const out: NormalizedEvent[] = [];
  for (const ev of events as OddsApiEvent[]) {
    if (!ev || !isText(ev.id) || !isText(ev.home_team) || !isText(ev.away_team) || !isText(ev.commence_time)) continue;
    if (!Number.isFinite(Date.parse(ev.commence_time))) continue;
    const books = (Array.isArray(ev.bookmakers) ? ev.bookmakers : [])
      .filter((b) => b && isText(b.key))
      .map((b) => ({
        book: b.key,
        outcomes: (Array.isArray(b.markets) ? b.markets : []).flatMap((m) => normalizeMarket(ev, m)),
      }));
    out.push({ id: ev.id, commenceTime: ev.commence_time, homeTeam: ev.home_team, awayTeam: ev.away_team, books });
  }
  return out;
}

function normalizeMarket(ev: OddsApiEvent, m: OddsApiMarket): NormalizedOutcome[] {
  if (!m || !isText(m.key) || !Array.isArray(m.outcomes)) return [];
  const byName = (name: string) => m.outcomes.find((o) => o && o.name === name);
  if (m.key === "h2h") {
    const home = byName(ev.home_team);
    const away = byName(ev.away_team);
    if (!home || !away || !isAmerican(home.price) || !isAmerican(away.price)) return [];
    return [
      { market: "moneyline", side: "home", point: null, price: home.price },
      { market: "moneyline", side: "away", point: null, price: away.price },
    ];
  }
  if (m.key === "spreads") {
    const home = byName(ev.home_team);
    const away = byName(ev.away_team);
    if (!home || !away || !isHalf(home.point) || !isHalf(away.point) || home.point + away.point !== 0) return [];
    if (!isAmerican(home.price) || !isAmerican(away.price)) return [];
    return [
      { market: "spread", side: "home", point: home.point, price: home.price },
      { market: "spread", side: "away", point: away.point, price: away.price },
    ];
  }
  if (m.key === "totals") {
    const over = m.outcomes.find((o) => typeof o?.name === "string" && o.name.toLowerCase() === "over");
    const under = m.outcomes.find((o) => typeof o?.name === "string" && o.name.toLowerCase() === "under");
    if (!over || !under || !isHalf(over.point) || over.point !== under.point || over.point <= 0) return [];
    if (!isAmerican(over.price) || !isAmerican(under.price)) return [];
    return [
      { market: "total", side: "over", point: over.point, price: over.price },
      { market: "total", side: "under", point: under.point, price: under.price },
    ];
  }
  return [];
}

/** A score as the feed sends it ("24", or 24), or null for anything else: blank, null, "12.5", "-3". */
function scoreOf(x: unknown): number | null {
  if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? x : null;
  if (typeof x === "string" && /^\s*\d{1,3}\s*$/.test(x)) return Number(x);
  return null;
}

/** Games that have started, with both scores as whole numbers. */
export function normalizeScores(events: unknown): NormalizedScore[] {
  if (!Array.isArray(events)) return [];
  const out: NormalizedScore[] = [];
  for (const ev of events as OddsApiScoreEvent[]) {
    if (!ev || !isText(ev.id) || !Array.isArray(ev.scores)) continue;
    const home = ev.scores.find((s) => s?.name === ev.home_team);
    const away = ev.scores.find((s) => s?.name === ev.away_team);
    const h = scoreOf(home?.score);
    const a = scoreOf(away?.score);
    if (h === null || a === null) continue;
    out.push({ id: ev.id, completed: ev.completed === true, homeScore: h, awayScore: a });
  }
  return out;
}
