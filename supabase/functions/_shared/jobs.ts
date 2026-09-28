// The scheduled jobs: pull lines, pull scores, grade, and advance the week.
// They talk to the database through the Store interface (supabase-store.ts in
// production, a fake in the tests) and to The Odds API through an injected fetch.
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
  refreshOnBetSeconds: number;
  creditFloor: number;
  books: string[];
}

export interface Store {
  settings(): Promise<Settings>;
  /** Credits left as of the latest Odds API response, and when. */
  lastCredits(): Promise<{ remaining: number; at: Date } | null>;
  lastGoodLinesPull(): Promise<Date | null>;
  ingestLines(trigger: Trigger, events: NormalizedEvent[], cost: number | null, remaining: number | null): Promise<number>;
  ingestScores(trigger: Trigger, scores: NormalizedScore[], cost: number | null, remaining: number | null): Promise<number>;
  recordPull(kind: "lines" | "scores", trigger: Trigger, ok: boolean, error: string, cost: number | null, remaining: number | null): Promise<void>;
  /** For a bet-triggered pull: true for the one bet per interval that should pull, false for the rest. */
  claimBetRefresh(minSeconds: number): Promise<boolean>;
  /** How many games have kicked off in the last 3 days and aren't final or void yet. */
  gamesAwaitingScores(now: Date): Promise<number>;
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

export async function pullLines(store: Store, apiKey: string, fetchImpl: Fetch, trigger: Trigger, now = new Date()): Promise<PullOutcome> {
  const s = await store.settings();
  if (trigger === "schedule" && !inPullWindow(now, s.pullWindowStart, s.pullWindowEnd, s.timezone)) {
    return { status: "skipped", reason: "outside the pull window" };
  }
  const low = await belowCreditFloor(store, s.creditFloor, now);
  if (low !== null) {
    await store.recordPull("lines", trigger, false, `stopped at the credit floor (${low} left)`, null, null);
    return { status: "skipped", reason: "credit floor" };
  }
  // Bets that find the lines stale share one refresh: the first one pulls, the rest
  // use what it brings in (or the lines they already have).
  if (trigger === "bet" && !(await store.claimBetRefresh(s.refreshOnBetSeconds))) {
    return { status: "skipped", reason: "another bet just refreshed the lines" };
  }
  const r = await callApi<OddsApiEvent[]>(store, "lines", trigger, oddsUrl(apiKey, s.books), fetchImpl);
  if ("error" in r) return { status: "failed", reason: r.error };
  const count = await storePaid(store, "lines", trigger, r, () => store.ingestLines(trigger, normalizeOdds(r.data), r.cost, r.remaining));
  if (typeof count !== "number") return { status: "failed", reason: count.error, remaining: r.remaining };
  return { status: "pulled", count, remaining: r.remaining };
}

export interface ScoresRun {
  scores: PullOutcome;
  settled: number;
  advancedTo: number | null;
  /** Bets that couldn't be settled this run, and why. The rest are settled anyway. */
  errors: string[];
}

/**
 * Pulls scores if any game needs them, grades what can be graded, then advances the
 * week if it's done. One bet that can't be settled doesn't hold up the others or the
 * week: it's reported and tried again on the next run.
 */
export async function runScores(store: Store, apiKey: string, fetchImpl: Fetch, trigger: Trigger, now = new Date()): Promise<ScoresRun> {
  let scores: PullOutcome = { status: "skipped", reason: "no games waiting on scores" };
  if ((await store.gamesAwaitingScores(now)) > 0) {
    const s = await store.settings();
    const low = await belowCreditFloor(store, s.creditFloor, now);
    if (low !== null) {
      await store.recordPull("scores", trigger, false, `stopped at the credit floor (${low} left)`, null, null);
      scores = { status: "skipped", reason: "credit floor" };
    } else {
      const r = await callApi<OddsApiScoreEvent[]>(store, "scores", trigger, scoresUrl(apiKey), fetchImpl);
      if ("error" in r) {
        scores = { status: "failed", reason: r.error };
      } else {
        const count = await storePaid(store, "scores", trigger, r, () => store.ingestScores(trigger, normalizeScores(r.data), r.cost, r.remaining));
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
  return { scores, settled, advancedTo, errors };
}
