// The scheduled jobs: pull lines, pull scores, grade, and advance the week.
// They talk to the database through the Store interface (supabase-store.ts in
// production, a fake in the tests) and to The Odds API through an injected fetch.
import { confirmFinals } from "./espn.ts";
import { gradePending, type GameResult, type PendingSlip, type Settlement } from "./grading.ts";
import {
  normalizeOdds,
  normalizeScores,
  oddsUrl,
  readUsage,
  scoresUrl,
  type NormalizedEvent,
  type NormalizedScore,
  type OddsApiEvent,
  type OddsApiScoreEvent,
} from "./odds-api.ts";
import { inPullWindow } from "./schedule.ts";

export type Trigger = "schedule" | "bet" | "admin";
export type Fetch = (url: string) => Promise<Response>;

export interface Settings {
  timezone: string;
  pullWindowStart: string;
  pullWindowEnd: string;
  /** Scheduled pulls come this often... */
  pullEveryMinutes: number;
  /** ...or this often while a game locks within nearKickoffHours. */
  pullNearKickoffMinutes: number;
  nearKickoffHours: number;
  refreshOnBetSeconds: number;
  /** Bets are refused when the last good pull is older than this. */
  maxLineAgeMinutes: number;
  creditFloor: number;
  books: string[];
  /** Off until the site's owner turns the feed on: no pull of any kind calls the Odds API. */
  oddsPullsEnabled: boolean;
}

export interface Store {
  settings(): Promise<Settings>;
  /** Credits left as of the latest Odds API response, and when. */
  lastCredits(): Promise<{ remaining: number; at: Date } | null>;
  lastGoodLinesPull(): Promise<Date | null>;
  /** The database's clock, exactly as it gives it (a timestamp string). */
  dbNow(): Promise<string>;
  /** Whether the board's lines came from a pull whose request went out at or after `since` (a database time). */
  linesFetchedSince(since: string): Promise<boolean>;
  /** fetchedAfter: the database's time just before the request went out (see undo_slip_internal). */
  ingestLines(trigger: Trigger, events: NormalizedEvent[], cost: number | null, remaining: number | null, fetchedAfter: string): Promise<number>;
  ingestScores(trigger: Trigger, scores: NormalizedScore[], cost: number | null, remaining: number | null): Promise<number>;
  recordPull(kind: "lines" | "scores", trigger: Trigger, ok: boolean, error: string, cost: number | null, remaining: number | null): Promise<void>;
  /**
   * For a bet-triggered pull: "claimed" for the bet that should pull; "recent" while a
   * refresh has just run or is running; "limit" when the member's or the day's limit is
   * used up.
   */
  claimBetRefresh(minSeconds: number, userId: string | null, forUndo: boolean): Promise<"claimed" | "recent" | "limit">;
  /** How many games have kicked off in the last 3 days and aren't final or void yet. */
  gamesAwaitingScores(now: Date): Promise<number>;
  /** How many scheduled games lock for betting within the next `hours`. */
  gamesStartingSoon(now: Date, hours: number): Promise<number>;
  /** Whether anyone has started a league on the site yet. */
  hasLeagues(): Promise<boolean>;
  pendingSlips(): Promise<PendingSlip[]>;
  games(ids: string[]): Promise<Map<string, GameResult>>;
  settle(s: Settlement): Promise<boolean>;
  advanceWeek(): Promise<number | null>;
}

export interface PullOutcome {
  status: "pulled" | "skipped" | "failed";
  reason?: string;
  count?: number;
  remaining?: number | null;
}

/**
 * Error text that is safe to store and show. Members can't read pull errors, but they
 * reach the admins' screens, and a fetch error can quote the request URL, API key and
 * all, so keys are masked and messages are kept short.
 */
export function safeError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return redact(text).slice(0, 200);
}

export function redact(text: string): string {
  return text
    .replace(/(api[_-]?key=)[^&\s"']+/gi, "$1[hidden]")
    .replace(/https?:\/\/\S+/g, (url) => url.split("?")[0] + (url.includes("?") ? "?[hidden]" : ""));
}

/** Why a pull skipped while the site's odds feed is off (Settings.oddsPullsEnabled). */
export const ODDS_OFF = "odds pulls are off";

/** pg_cron calls the lines job this often (supabase/migrations/20260928000005_schedule.sql). */
const TICK_MS = 10 * 60_000;
/** The schedule never pulls again this soon after a good pull, a bet's included. */
const MIN_GAP_MS = 2 * 60_000;
/**
 * Room for the few seconds each call and pull take, so the regular pull stays on the
 * same call each interval (every third one, at the default 30 minutes) rather than
 * landing one call early at random.
 */
const SLACK_MS = 60_000;

/** After this long without an API response, probe once even if the last count was under the floor (plans reset monthly). */
const PROBE_AFTER_MS = 6 * 3_600_000;

async function belowCreditFloor(store: Store, floor: number, now: Date): Promise<number | null> {
  const last = await store.lastCredits();
  if (last && last.remaining < floor && now.getTime() - last.at.getTime() < PROBE_AFTER_MS) return last.remaining;
  return null;
}

async function callApi<T>(
  store: Store,
  kind: "lines" | "scores",
  trigger: Trigger,
  url: string,
  fetchImpl: Fetch,
): Promise<{ data: T; cost: number | null; remaining: number | null } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    await store.recordPull(kind, trigger, false, `network error (${safeError(e)})`, null, null);
    return { error: "network error" };
  }
  const usage = readUsage(res.headers);
  if (!res.ok) {
    const body = redact((await res.text().catch(() => "")).slice(0, 200));
    await store.recordPull(kind, trigger, false, `HTTP ${res.status}: ${body}`, usage.last, usage.remaining);
    return { error: `HTTP ${res.status}` };
  }
  try {
    return { data: (await res.json()) as T, cost: usage.last, remaining: usage.remaining };
  } catch (e) {
    await store.recordPull(kind, trigger, false, `bad JSON (${safeError(e)})`, usage.last, usage.remaining);
    return { error: "bad JSON" };
  }
}

/** Stores a paid-for response; if that fails, records the failure with its cost so the credit floor still counts it. */
async function storePaid<T>(
  store: Store,
  kind: "lines" | "scores",
  trigger: Trigger,
  r: { cost: number | null; remaining: number | null },
  save: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await save();
  } catch (e) {
    await store.recordPull(kind, trigger, false, `couldn't store the pull (${safeError(e)})`, r.cost, r.remaining).catch(() => undefined);
    return { error: "couldn't store the pull" };
  }
}

export async function pullLines(
  store: Store, apiKey: string, fetchImpl: Fetch, trigger: Trigger, now = new Date(), userId: string | null = null,
  opts: { forUndo?: boolean } = {},
): Promise<PullOutcome> {
  const s = await store.settings();
  if (!s.oddsPullsEnabled) return { status: "skipped", reason: ODDS_OFF };
  if (trigger === "schedule") {
    if (!inPullWindow(now, s.pullWindowStart, s.pullWindowEnd, s.timezone)) return { status: "skipped", reason: "outside the pull window" };
    // No credits go to a site nobody plays on yet; a site admin can still pull by hand.
    if (!(await store.hasLeagues())) return { status: "skipped", reason: "no leagues yet" };
    // Every pullEveryMinutes, or every pullNearKickoffMinutes while a game is about to
    // lock: a pull is due once waiting for the next call would leave the lines older than
    // that, give or take a minute. Only a good pull counts, a bet's included, so after a
    // failed one (the feed was down, the credit floor) the next call tries again; the
    // Admin page lists a failure that keeps happening once, with a count.
    const last = await store.lastGoodLinesPull();
    const soon = (await store.gamesStartingSoon(now, s.nearKickoffHours)) > 0;
    const every = (soon ? s.pullNearKickoffMinutes : s.pullEveryMinutes) * 60_000;
    if (last && now.getTime() - last.getTime() < Math.max(every - TICK_MS + SLACK_MS, MIN_GAP_MS)) return { status: "skipped", reason: "not due yet" };
  }
  const low = await belowCreditFloor(store, s.creditFloor, now);
  if (low !== null) {
    await store.recordPull("lines", trigger, false, `stopped at the credit floor (${low} left)`, null, null);
    return { status: "skipped", reason: "credit floor" };
  }
  // Bets that find the lines stale share one refresh: the first one pulls, the rest
  // use what it brings in (or the lines they already have). An undo gets its own. Each
  // member's bets, and bets as a whole, also have limits (see claim_bet_refresh_internal).
  if (trigger === "bet") {
    const claim = await store.claimBetRefresh(s.refreshOnBetSeconds, userId, opts.forUndo ?? false);
    if (claim !== "claimed") return { status: "skipped", reason: claim };
  }
  const fetchedAfter = await store.dbNow();
  const r = await callApi<OddsApiEvent[]>(store, "lines", trigger, oddsUrl(apiKey, s.books), fetchImpl);
  if ("error" in r) return { status: "failed", reason: r.error };
  const events = normalizeOdds(r.data);
  // An answer with no games while games are still to come is the feed's glitch, not an
  // empty slate. Stored, it would take every line off the board (and an undo would read
  // its bet's line as moved), so it's recorded as a failed pull and the board kept.
  if (!events.length && (await store.gamesStartingSoon(now, 14 * 24)) > 0) {
    await store.recordPull("lines", trigger, false, "the feed answered with no games; the board was kept as it was", r.cost, r.remaining);
    return { status: "failed", reason: "no games in the answer", remaining: r.remaining };
  }
  const count = await storePaid(store, "lines", trigger, r, () => store.ingestLines(trigger, events, r.cost, r.remaining, fetchedAfter));
  if (typeof count !== "number") return { status: "failed", reason: count.error, remaining: r.remaining };
  return { status: "pulled", count, remaining: r.remaining };
}

/** Why an undo's lines couldn't be pulled: a refresh limit or the credit floor, or a pull that failed. */
export type UndoRefresh = "ok" | "limit" | "credit_floor" | "failed";

/**
 * Makes sure the board's lines were fetched after an undo was asked for (`since`, the
 * database's time then), pulling them if not: undo is refused once a line on the bet
 * has moved, and undo_slip_internal won't check against older lines. Undo pulls have
 * limits of their own, apart from the bets' (claim_bet_refresh_internal), and a
 * member's undos pull at most once every 10 seconds; an undo arriving within that
 * waits for the pull already made, or for the 10 seconds to pass. Says why not when the
 * lines can't be had: a limit or the credit floor, which trying again soon won't fix,
 * or a failed pull, which it might.
 */
export async function refreshForUndo(
  store: Store, apiKey: string, fetchImpl: Fetch, userId: string, since: string,
  now = new Date(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<UndoRefresh> {
  for (let i = 0; i < 15; i++) {
    if (await store.linesFetchedSince(since)) return "ok";
    const pulled = await pullLines(store, apiKey, fetchImpl, "bet", now, userId, { forUndo: true });
    if (pulled.status === "pulled") return "ok";
    if (pulled.status === "failed" || pulled.reason === ODDS_OFF) return "failed";
    if (pulled.reason === "credit floor") return "credit_floor";
    if (pulled.reason === "limit") return "limit";
    await sleep(1000); // "recent": another of the member's undos pulled a moment ago
  }
  return "failed";
}

export interface ScoresRun {
  scores: PullOutcome;
  settled: number;
  advancedTo: number | null;
  /** Bets that couldn't be settled this run, and why. The rest are settled anyway. */
  errors: string[];
}

/**
 * Pulls scores if any game needs them, checks each final against ESPN, grades what
 * can be graded, then advances the week if it's done. One bet that can't be settled doesn't hold up the others or the
 * week: it's reported and tried again on the next run.
 */
export async function runScores(store: Store, apiKey: string, fetchImpl: Fetch, trigger: Trigger, now = new Date()): Promise<ScoresRun> {
  let scores: PullOutcome = { status: "skipped", reason: "no games waiting on scores" };
  if ((await store.gamesAwaitingScores(now)) > 0) {
    const s = await store.settings();
    const low = await belowCreditFloor(store, s.creditFloor, now);
    if (!s.oddsPullsEnabled) {
      scores = { status: "skipped", reason: ODDS_OFF };
    } else if (low !== null) {
      await store.recordPull("scores", trigger, false, `stopped at the credit floor (${low} left)`, null, null);
      scores = { status: "skipped", reason: "credit floor" };
    } else {
      const r = await callApi<OddsApiScoreEvent[]>(store, "scores", trigger, scoresUrl(apiKey), fetchImpl);
      if ("error" in r) {
        scores = { status: "failed", reason: r.error };
      } else {
        // A final goes in only once ESPN shows the same one (espn.ts); the rest stay live.
        const checked = await confirmFinals(Array.isArray(r.data) ? r.data : [], normalizeScores(r.data), fetchImpl, s.timezone);
        for (const h of checked.held) {
          await store.recordPull("scores", trigger, false, `final held: ${h}`.slice(0, 500), null, null).catch(() => undefined);
        }
        const count = await storePaid(store, "scores", trigger, r, () => store.ingestScores(trigger, checked.scores, r.cost, r.remaining));
        scores = typeof count === "number"
          ? { status: "pulled", count, remaining: r.remaining }
          : { status: "failed", reason: count.error, remaining: r.remaining };
      }
    }
  }

  const errors: string[] = [];
  const pending = await store.pendingSlips();
  const ids = [...new Set(pending.flatMap((s) => s.legs.map((l) => l.gameId)))];
  const games = ids.length ? await store.games(ids) : new Map<string, GameResult>();
  let settled = 0;
  for (const s of gradePending(pending, games, (slipId, e) => errors.push(`${slipId}: ${safeError(e)}`))) {
    try {
      if (await store.settle(s)) settled++;
    } catch (e) {
      errors.push(`${s.slipId}: ${safeError(e)}`);
    }
  }
  let advancedTo: number | null = null;
  try {
    advancedTo = await store.advanceWeek();
  } catch (e) {
    errors.push(`advance week: ${safeError(e)}`);
  }
  // Scheduled runs have no one reading their reply, so problems are recorded where the
  // Admin page shows them.
  if (errors.length) {
    await store.recordPull("scores", trigger, false, `grading: ${errors.join("; ")}`.slice(0, 500), null, null).catch(() => undefined);
  }
  return { scores, settled, advancedTo, errors };
}
