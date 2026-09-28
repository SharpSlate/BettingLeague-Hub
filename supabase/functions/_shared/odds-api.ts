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

/**
 * Keeps each book's spread, total and moneyline when both sides are present and sane:
 * whole or half points, valid American prices, spreads that mirror, totals that match.
 */
export function normalizeOdds(events: OddsApiEvent[]): NormalizedEvent[] {
  return events.map((ev) => ({
    id: ev.id,
    commenceTime: ev.commence_time,
    homeTeam: ev.home_team,
    awayTeam: ev.away_team,
    books: (ev.bookmakers ?? []).map((b) => ({
      book: b.key,
      outcomes: b.markets.flatMap((m) => normalizeMarket(ev, m)),
    })),
  }));
}

function normalizeMarket(ev: OddsApiEvent, m: OddsApiMarket): NormalizedOutcome[] {
  const byName = (name: string) => m.outcomes.find((o) => o.name === name);
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
    const over = m.outcomes.find((o) => o.name.toLowerCase() === "over");
    const under = m.outcomes.find((o) => o.name.toLowerCase() === "under");
    if (!over || !under || !isHalf(over.point) || over.point !== under.point || over.point <= 0) return [];
    if (!isAmerican(over.price) || !isAmerican(under.price)) return [];
    return [
      { market: "total", side: "over", point: over.point, price: over.price },
      { market: "total", side: "under", point: under.point, price: under.price },
    ];
  }
  return [];
}

/** Games that have started, with both scores as whole numbers. */
export function normalizeScores(events: OddsApiScoreEvent[]): NormalizedScore[] {
  const out: NormalizedScore[] = [];
  for (const ev of events) {
    if (!ev.scores) continue;
    const home = ev.scores.find((s) => s.name === ev.home_team);
    const away = ev.scores.find((s) => s.name === ev.away_team);
    const h = home ? Number(home.score) : NaN;
    const a = away ? Number(away.score) : NaN;
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) continue;
    out.push({ id: ev.id, completed: ev.completed === true, homeScore: h, awayScore: a });
  }
  return out;
}
