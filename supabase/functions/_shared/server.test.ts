import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gradePending, type GameResult, type PendingSlip } from "./grading.ts";
import { pullLines, refreshForUndo, runScores, type Settings, type Store } from "./jobs.ts";
import { normalizeOdds, normalizeScores, oddsUrl, readUsage, scoresUrl, type NormalizedEvent, type NormalizedScore } from "./odds-api.ts";
import { confirmFinals, espnDays, espnUrl, parseEspn } from "./espn.ts";
import { checkPlacement, type CurrentLine, type GameInfo } from "./placement.ts";
import { DAY_ONE_RULES } from "./rules/defaults.ts";
import { inPullWindow, isStale } from "./schedule.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("Odds API requests", () => {
  it("asks for DraftKings and FanDuel spreads, totals and moneylines in American odds (3 credits)", () => {
    const u = new URL(oddsUrl("KEY", ["draftkings", "fanduel"]));
    expect(u.origin + u.pathname).toBe("https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      apiKey: "KEY",
      bookmakers: "draftkings,fanduel",
      markets: "h2h,spreads,totals",
      oddsFormat: "american",
      dateFormat: "iso",
    });
  });
  it("asks for scores including yesterday's finals", () => {
    const u = new URL(scoresUrl("KEY"));
    expect(u.pathname).toBe("/v4/sports/americanfootball_nfl/scores");
    expect(u.searchParams.get("daysFrom")).toBe("1");
  });
  it("reads the usage headers", () => {
    const h = new Headers({ "x-requests-used": "1203", "x-requests-remaining": "98797", "x-requests-last": "3" });
    expect(readUsage(h)).toEqual({ used: 1203, remaining: 98797, last: 3 });
    expect(readUsage(new Headers())).toEqual({ used: null, remaining: null, last: null });
  });
});

describe("normalizeOdds", () => {
  const events = normalizeOdds(fixture("odds.json"));
  it("maps each book's markets to home/away and over/under", () => {
    const dk = events[0]!.books.find((b) => b.book === "draftkings")!;
    expect(dk.outcomes).toEqual([
      { market: "moneyline", side: "home", point: null, price: -155 },
      { market: "moneyline", side: "away", point: null, price: 130 },
      { market: "spread", side: "home", point: -3, price: -112 },
      { market: "spread", side: "away", point: 3, price: -108 },
      { market: "total", side: "over", point: 47.5, price: -110 },
      { market: "total", side: "under", point: 47.5, price: -110 },
    ]);
    expect(events[0]).toMatchObject({ id: "evt_kc_buf", homeTeam: "Kansas City Chiefs", awayTeam: "Buffalo Bills", commenceTime: "2026-10-04T17:00:00Z" });
  });
  it("keeps a book that offers only some markets", () => {
    const fd = events[0]!.books.find((b) => b.book === "fanduel")!;
    expect(fd.outcomes.map((o) => o.market)).toEqual(["moneyline", "moneyline", "spread", "spread"]);
  });
  it("drops markets that don't add up: unmirrored spreads, quarter points, one-sided moneylines", () => {
    expect(events[2]!.books[0]!.outcomes).toEqual([]);
  });
});

describe("normalizeScores", () => {
  it("keeps games that have started, with whole-number scores", () => {
    expect(normalizeScores(fixture("scores.json"))).toEqual([
      { id: "evt_kc_buf", completed: true, homeScore: 27, awayScore: 24 },
      { id: "evt_bal_pit", completed: false, homeScore: 10, awayScore: 7 },
    ]);
  });
});

describe("pull window (Eastern time)", () => {
  const w = (iso: string) => inPullWindow(new Date(iso), "08:00", "01:00", "America/New_York");
  it("covers 8am through 1am, both ends included", () => {
    expect(w("2026-10-01T12:00:00Z")).toBe(true); // 8:00 EDT
    expect(w("2026-10-01T11:59:00Z")).toBe(false); // 7:59 EDT
    expect(w("2026-10-02T05:00:00Z")).toBe(true); // 1:00 EDT
    expect(w("2026-10-02T05:30:00Z")).toBe(false); // 1:30 EDT
    expect(w("2026-10-02T03:59:00Z")).toBe(true); // 11:59 pm EDT
  });
  it("follows the clock change", () => {
    expect(w("2026-11-10T13:00:00Z")).toBe(true); // 8:00 EST
    expect(w("2026-11-10T12:30:00Z")).toBe(false); // 7:30 EST (would be 8:30 EDT)
  });
  it("knows when lines are stale for a bet", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    expect(isStale(null, now, 120)).toBe(true);
    expect(isStale(new Date("2026-10-01T11:58:30Z"), now, 120)).toBe(false);
    expect(isStale(new Date("2026-10-01T11:57:59Z"), now, 120)).toBe(true);
  });
});

const final = (id: string, homeScore: number, awayScore: number): GameResult => ({ id, status: "final", homeScore, awayScore });
const live = (id: string): GameResult => ({ id, status: "live", homeScore: 7, awayScore: 3 });

describe("gradePending", () => {
  const slip = (over: Partial<PendingSlip>): PendingSlip => ({
    id: "s",
    type: "straight",
    stakeCents: 10_000,
    teaserPoints: null,
    rules: DAY_ONE_RULES,
    legs: [{ legNo: 1, gameId: "a", market: "spread", side: "home", point: -3, price: -110 }],
    ...over,
  });
  it("settles finished slips and leaves the rest", () => {
    const games = new Map([["a", final("a", 27, 20)], ["b", live("b")]]);
    const out = gradePending(
      [
        slip({ id: "won" }),
        slip({ id: "waiting", legs: [{ legNo: 1, gameId: "b", market: "total", side: "over", point: 41, price: -110 }] }),
      ],
      games,
    );
    expect(out).toEqual([{ slipId: "won", result: "won", payoutCents: 19_091, legResults: [{ legNo: 1, result: "won" }], gameVersions: [] }]);
  });
  it("loses a parlay as soon as a leg loses, leaving later legs pending", () => {
    const p = slip({
      id: "p",
      type: "parlay",
      legs: [
        { legNo: 1, gameId: "a", market: "spread", side: "away", point: 3, price: -110 },
        { legNo: 2, gameId: "b", market: "total", side: "over", point: 41, price: -110 },
      ],
    });
    const out = gradePending([p], new Map([["a", final("a", 27, 20)], ["b", live("b")]]));
    expect(out[0]).toEqual({ slipId: "p", result: "lost", payoutCents: 0, legResults: [{ legNo: 1, result: "lost" }, { legNo: 2, result: "pending" }], gameVersions: [] });
  });
  it("teases the legs by the slip's points", () => {
    // home -7 teased 6 -> -1 on a 24-20 win: won. over 44.5 teased 6 -> 38.5 on 44 total: won.
    const t = slip({
      id: "t",
      type: "teaser",
      teaserPoints: 6,
      legs: [
        { legNo: 1, gameId: "a", market: "spread", side: "home", point: -7, price: -110 },
        { legNo: 2, gameId: "a", market: "total", side: "over", point: 44.5, price: -110 },
      ],
    });
    const out = gradePending([t], new Map([["a", final("a", 24, 20)]]));
    expect(out[0]).toMatchObject({ result: "won", payoutCents: 19_091 });
  });
  it("voids legs on a voided game", () => {
    const out = gradePending([slip({ id: "v" })], new Map([["a", { id: "a", status: "void", homeScore: null, awayScore: null } as GameResult]]));
    expect(out[0]).toMatchObject({ result: "void", payoutCents: 10_000 });
  });
});

describe("checkPlacement", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const games = new Map<string, GameInfo>([
    ["a", { id: "a", locksAt: new Date("2026-10-04T17:00:00Z"), status: "scheduled", week: 5 }],
    ["b", { id: "b", locksAt: new Date("2026-10-04T17:00:00Z"), status: "scheduled", week: 5 }],
    ["old", { id: "old", locksAt: new Date("2026-10-01T11:00:00Z"), status: "scheduled", week: 5 }],
    ["next", { id: "next", locksAt: new Date("2026-10-11T17:00:00Z"), status: "scheduled", week: 6 }],
  ]);
  const lines: CurrentLine[] = [
    { gameId: "a", market: "spread", side: "home", point: -3, price: -112, source: "draftkings" },
    { gameId: "a", market: "total", side: "over", point: 47.5, price: -110, source: "draftkings" },
    { gameId: "b", market: "total", side: "over", point: 41.5, price: -105, source: "draftkings" },
  ];
  const ctx = { availableCents: 1_000_000 };
  const straight = (point: number, price: number, gameId = "a") => ({
    entryId: "e",
    type: "straight" as const,
    stakeCents: 10_000,
    legs: [{ gameId, market: "spread" as const, side: "home" as const, point, price }],
  });

  it("quotes a slip that matches the current line", () => {
    const r = checkPlacement(straight(-3, -112), DAY_ONE_RULES, ctx, 5, games, lines, now);
    // 10000 x (1 + 100/112) = 18928.57 -> 18929
    expect(r).toEqual({ ok: true, quote: expect.objectContaining({ american: -112, payoutCents: 18_929 }) });
  });
  it("reports moved numbers so the member can accept them", () => {
    expect(checkPlacement(straight(-3, -110), DAY_ONE_RULES, ctx, 5, games, lines, now)).toEqual({
      ok: false,
      kind: "moved",
      lines: [{ leg: 0, point: -3, price: -112 }],
    });
  });
  it("refuses started games, other weeks and missing lines", () => {
    const codes = (r: ReturnType<typeof checkPlacement>) => (r.ok || r.kind !== "invalid" ? [] : r.problems.map((p) => p.code));
    expect(codes(checkPlacement(straight(-3, -110, "old"), DAY_ONE_RULES, ctx, 5, games, lines, now))).toEqual(["game_started"]);
    expect(codes(checkPlacement(straight(-3, -110, "next"), DAY_ONE_RULES, ctx, 5, games, lines, now))).toEqual(["game_not_this_week"]);
    const ml = { ...straight(0, -150), legs: [{ gameId: "a", market: "moneyline" as const, side: "home" as const, point: null, price: -150 }] };
    expect(codes(checkPlacement(ml, DAY_ONE_RULES, ctx, 5, games, lines, now))).toEqual(["line_unavailable"]);
  });
  it("ignores leg prices on teasers but checks the numbers", () => {
    const t = {
      entryId: "e",
      type: "teaser" as const,
      teaserPoints: 6,
      stakeCents: 10_000,
      legs: [
        { gameId: "a", market: "spread" as const, side: "home" as const, point: -3, price: -110 },
        { gameId: "b", market: "total" as const, side: "over" as const, point: 41.5, price: -110 },
      ],
    };
    expect(checkPlacement(t, DAY_ONE_RULES, ctx, 5, games, lines, now)).toMatchObject({ ok: true, quote: { american: -110, payoutCents: 19_091 } });
  });
});

class FakeStore implements Store {
  settingsValue: Settings = {
    timezone: "America/New_York",
    pullWindowStart: "08:00",
    pullWindowEnd: "01:00",
    pullEveryMinutes: 30,
    pullNearKickoffMinutes: 10,
    nearKickoffHours: 3,
    refreshOnBetSeconds: 120,
    maxLineAgeMinutes: 35,
    creditFloor: 5_000,
    books: ["draftkings", "fanduel"],
  };
  credits: { remaining: number; at: Date } | null = null;
  pulls: { kind: string; trigger: string; ok: boolean; error: string }[] = [];
  lines: NormalizedEvent[] = [];
  scores: NormalizedScore[] = [];
  awaiting = 0;
  pending: PendingSlip[] = [];
  gameMap = new Map<string, GameResult>();
  settled: string[] = [];
  advanceTo: number | null = null;
  advanced = 0;
  claimOk: "claimed" | "recent" | "limit" = "claimed";
  failIngest = false;
  failSettle = new Set<string>();
  costs: { error: string; cost: number | null; remaining: number | null }[] = [];

  async settings() { return this.settingsValue; }
  async lastCredits() { return this.credits; }
  lastPull: Date | null = null;
  startingSoon = 0;
  claims: { userId: string | null; forUndo: boolean }[] = [];
  /** The order things happened in: the database clock read, the request, the store. */
  log: string[] = [];
  fetchedAfter: string | null = null;
  /** Whether the board's lines were fetched after the undo was asked for; a stored pull makes them so. */
  fresh = false;
  async linesFetchedSince() { return this.fresh; }
  async lastGoodLinesPull() { return this.lastPull; }
  async dbNow() {
    this.log.push("clock");
    return "2026-10-01 16:00:00.123456+00";
  }
  async ingestLines(trigger: string, events: NormalizedEvent[], _cost: number | null, remaining: number | null, fetchedAfter: string) {
    if (this.failIngest) throw new Error("connection reset");
    this.log.push("store");
    this.fetchedAfter = fetchedAfter;
    this.fresh = true;
    this.lines = events;
    this.pulls.push({ kind: "lines", trigger, ok: true, error: "" });
    if (remaining !== null) this.credits = { remaining, at: new Date() };
    return events.length;
  }
  async ingestScores(trigger: string, scores: NormalizedScore[]) {
    this.scores = scores;
    this.pulls.push({ kind: "scores", trigger, ok: true, error: "" });
    return scores.length;
  }
  async recordPull(kind: string, trigger: string, ok: boolean, error: string, cost: number | null, remaining: number | null) {
    this.pulls.push({ kind, trigger, ok, error });
    this.costs.push({ error, cost, remaining });
  }
  async claimBetRefresh(_s: number, userId: string | null, forUndo: boolean) {
    this.claims.push({ userId, forUndo });
    return this.claimOk;
  }
  async gamesAwaitingScores() { return this.awaiting; }
  async gamesStartingSoon() { return this.startingSoon; }
  async pendingSlips() { return this.pending; }
  async games(ids: string[]) { return new Map([...this.gameMap].filter(([k]) => ids.includes(k))); }
  async settle(s: { slipId: string }) {
    if (this.failSettle.has(s.slipId)) throw new Error("settle: bad_payout");
    this.settled.push(s.slipId);
    return true;
  }
  async advanceWeek() { this.advanced++; return this.advanceTo; }
}

function fakeFetch(body: unknown, status = 200, headers: Record<string, string> = { "x-requests-remaining": "90000", "x-requests-last": "3" }) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status, headers });
  };
  return Object.assign(f, { calls });
}

describe("pullLines", () => {
  const inWindow = new Date("2026-10-01T16:00:00Z"); // noon Eastern
  it("pulls, normalizes and stores", async () => {
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    expect(await pullLines(store, "KEY", f, "schedule", inWindow)).toEqual({ status: "pulled", count: 3, remaining: 90000 });
    expect(f.calls).toHaveLength(1);
    expect(store.lines[1]!.books[0]!.outcomes).toHaveLength(6);
  });
  it("stores the database's time from just before the request went out, exactly as given", async () => {
    const store = new FakeStore();
    const inner = fakeFetch(fixture("odds.json"));
    const f = async (url: string) => {
      store.log.push("fetch");
      return inner(url);
    };
    await pullLines(store, "KEY", f, "schedule", inWindow);
    expect(store.log).toEqual(["clock", "fetch", "store"]);
    expect(store.fetchedAfter).toBe("2026-10-01 16:00:00.123456+00");
  });
  it("skips scheduled pulls overnight, but not pulls for a bet", async () => {
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    const threeAm = new Date("2026-10-01T07:00:00Z");
    expect((await pullLines(store, "KEY", f, "schedule", threeAm)).status).toBe("skipped");
    expect((await pullLines(store, "KEY", f, "bet", threeAm)).status).toBe("pulled");
    expect(f.calls).toHaveLength(1);
  });
  it("pulls every 30 minutes, and every 10 in the 3 hours before a kickoff", async () => {
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    const ago = (min: number) => new Date(inWindow.getTime() - min * 60_000);
    const run = async () => (await pullLines(store, "KEY", f, "schedule", inWindow)).status;
    // The scheduler calls every 10 minutes: a pull is due once the next call would be
    // more than about 30 minutes after the last good pull.
    store.lastPull = ago(20.5);
    expect(await run()).toBe("skipped");
    store.lastPull = ago(21.5);
    expect(await run()).toBe("pulled");
    // Near kickoff, every call pulls, unless something pulled in the last 2 minutes.
    store.startingSoon = 1;
    store.lastPull = ago(1.5);
    expect(await run()).toBe("skipped");
    store.lastPull = ago(2.5);
    expect(await run()).toBe("pulled");
    expect(f.calls).toHaveLength(2);
  });
  it("keeps the regular pull on every third call, whichever second each call and pull land on", async () => {
    // The last pull landed a few seconds after its call; this call, two calls on, starts
    // a moment later than that one did. Pulling now would make it 3 pulls an hour.
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    for (const seconds of [-5, 0, 5, 30]) {
      store.lastPull = new Date(inWindow.getTime() - 20 * 60_000 - seconds * 1000);
      expect((await pullLines(store, "KEY", f, "schedule", inWindow)).status).toBe("skipped");
    }
    expect(f.calls).toHaveLength(0);
  });
  it("tries again at the next call after a failed pull, since only good pulls count", async () => {
    // The last good pull was 30 minutes ago; the one due 10 minutes ago failed.
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    store.lastPull = new Date(inWindow.getTime() - 30 * 60_000);
    expect((await pullLines(store, "KEY", f, "schedule", inWindow)).status).toBe("pulled");
  });
  it("a bet's refresh isn't held to the schedule; its own limits decide", async () => {
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    store.lastPull = new Date(inWindow.getTime() - 60_000);
    expect((await pullLines(store, "KEY", f, "bet", inWindow, "u1")).status).toBe("pulled");
    expect(store.claims).toEqual([{ userId: "u1", forUndo: false }]);
  });
  it("stops at the credit floor, then probes again after six hours", async () => {
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    store.credits = { remaining: 4_000, at: new Date(inWindow.getTime() - 3_600_000) };
    expect(await pullLines(store, "KEY", f, "schedule", inWindow)).toMatchObject({ status: "skipped", reason: "credit floor" });
    expect(f.calls).toHaveLength(0);
    store.credits = { remaining: 4_000, at: new Date(inWindow.getTime() - 7 * 3_600_000) };
    expect((await pullLines(store, "KEY", f, "schedule", inWindow)).status).toBe("pulled");
  });
  it("keeps the board when the feed answers with no games while games are still to come", async () => {
    const store = new FakeStore();
    store.startingSoon = 5;
    const f = fakeFetch([]);
    expect(await pullLines(store, "KEY", f, "schedule", inWindow)).toEqual({ status: "failed", reason: "no games in the answer", remaining: 90000 });
    expect(store.pulls).toEqual([{ kind: "lines", trigger: "schedule", ok: false, error: "the feed answered with no games; the board was kept as it was" }]);
    expect(store.costs[0]).toMatchObject({ cost: 3, remaining: 90000 });
    // With nothing left to play (after the season), an empty answer is stored as it is.
    store.startingSoon = 0;
    expect((await pullLines(store, "KEY", f, "schedule", inWindow)).status).toBe("pulled");
  });
  it("records a failed call without storing anything", async () => {
    const store = new FakeStore();
    const f = fakeFetch({ message: "Invalid API key" }, 401);
    expect(await pullLines(store, "KEY", f, "schedule", inWindow)).toEqual({ status: "failed", reason: "HTTP 401" });
    expect(store.pulls).toEqual([{ kind: "lines", trigger: "schedule", ok: false, error: 'HTTP 401: {"message":"Invalid API key"}' }]);
    expect(store.lines).toEqual([]);
  });
});

describe("pullLines under stress", () => {
  const inWindow = new Date("2026-10-01T16:00:00Z");
  it("lets only one bet at a time pull; the rest don't call the API", async () => {
    const store = new FakeStore();
    store.claimOk = "recent";
    const f = fakeFetch(fixture("odds.json"));
    expect(await pullLines(store, "KEY", f, "bet", inWindow)).toEqual({ status: "skipped", reason: "recent" });
    // A used-up limit says so, so the bet doesn't wait for a refresh that isn't coming.
    store.claimOk = "limit";
    expect(await pullLines(store, "KEY", f, "bet", inWindow)).toEqual({ status: "skipped", reason: "limit" });
    expect(f.calls).toHaveLength(0);
  });
  it("never stores the API key from a network error", async () => {
    const store = new FakeStore();
    const f = async (url: string) => {
      throw new TypeError(`error sending request for url (${url}): connection refused`);
    };
    expect(await pullLines(store, "SECRETKEY123", f, "schedule", inWindow)).toEqual({ status: "failed", reason: "network error" });
    expect(store.pulls).toHaveLength(1);
    expect(store.pulls[0]!.error).not.toContain("SECRETKEY123");
    expect(store.pulls[0]!.error).toContain("network error");
  });
  it("records a paid pull that couldn't be stored, with its cost, so the credit floor counts it", async () => {
    const store = new FakeStore();
    store.failIngest = true;
    const f = fakeFetch(fixture("odds.json"), 200, { "x-requests-remaining": "4800", "x-requests-last": "3" });
    expect(await pullLines(store, "KEY", f, "schedule", inWindow)).toMatchObject({ status: "failed", remaining: 4800 });
    expect(store.costs).toEqual([{ error: "couldn't store the pull (Error: connection reset)", cost: 3, remaining: 4800 }]);
  });
  it("skips malformed events and books instead of failing the pull", () => {
    const events = [
      { id: "x", commence_time: "2026-10-04T17:00:00Z", home_team: "Kansas City Chiefs", away_team: "Buffalo Bills", bookmakers: [{ key: "draftkings" }] },
      { id: "y", home_team: "A", away_team: "B" },
      null,
    ];
    expect(normalizeOdds(events)).toEqual([
      { id: "x", commenceTime: "2026-10-04T17:00:00Z", homeTeam: "Kansas City Chiefs", awayTeam: "Buffalo Bills", books: [{ book: "draftkings", outcomes: [] }] },
    ]);
    expect(normalizeOdds({ message: "not a list" })).toEqual([]);
  });
});

describe("normalizeScores", () => {
  const ev = (home: unknown, away: unknown) => ({
    id: "g", commence_time: "", completed: true, home_team: "H", away_team: "A",
    scores: [{ name: "H", score: home }, { name: "A", score: away }],
  });
  it("reads scores sent as text or numbers", () => {
    expect(normalizeScores([ev("24", 17)])).toEqual([{ id: "g", completed: true, homeScore: 24, awayScore: 17 }]);
  });
  it("skips blank, missing or odd scores instead of reading them as 0", () => {
    for (const bad of ["", " ", null, undefined, "12.5", "-3", "abc", 1.5]) {
      expect(normalizeScores([ev(bad, "17")])).toEqual([]);
    }
  });
});

describe("runScores", () => {
  it("settles the other bets and still advances the week when one bet can't be settled", async () => {
    const store = new FakeStore();
    const slip = (id: string) => ({
      id, type: "straight" as const, stakeCents: 10_000, teaserPoints: null, rules: DAY_ONE_RULES,
      legs: [{ legNo: 1, gameId: "a", market: "total" as const, side: "under" as const, point: 47.5, price: -110 }],
    });
    store.pending = [slip("bad"), slip("good")];
    store.failSettle.add("bad");
    store.gameMap.set("a", final("a", 27, 20));
    store.advanceTo = 6;
    const r = await runScores(store, "KEY", fakeFetch([]), "schedule");
    expect(store.settled).toEqual(["good"]);
    expect(r.errors).toEqual(["bad: Error: settle: bad_payout"]);
    expect(r.advancedTo).toBe(6);
    // Recorded for the Admin page, since nobody reads a scheduled run's reply.
    expect(store.pulls).toContainEqual({ kind: "scores", trigger: "schedule", ok: false, error: "grading: bad: Error: settle: bad_payout" });
  });
  it("sends the versions of the games each grade used", () => {
    const slip = {
      id: "s", type: "straight" as const, stakeCents: 10_000, teaserPoints: null, rules: DAY_ONE_RULES,
      legs: [{ legNo: 1, gameId: "a", market: "total" as const, side: "under" as const, point: 47.5, price: -110 }],
    };
    const games = new Map([["a", { ...final("a", 27, 20), version: "2026-10-04T20:15:03.123456+00:00" }]]);
    expect(gradePending([slip], games)[0]!.gameVersions).toEqual([{ gameId: "a", version: "2026-10-04T20:15:03.123456+00:00" }]);
  });
  it("reports a bet that can't be graded and grades the rest", async () => {
    const store = new FakeStore();
    const noTable = { ...DAY_ONE_RULES, betTypes: { ...DAY_ONE_RULES.betTypes, teaser: { ...DAY_ONE_RULES.betTypes.teaser, prices: {} } } };
    store.pending = [
      { id: "t", type: "teaser", stakeCents: 10_000, teaserPoints: 6, rules: noTable, legs: [
        { legNo: 1, gameId: "a", market: "total", side: "under", point: 47.5, price: -110 },
        { legNo: 2, gameId: "a", market: "spread", side: "home", point: -3, price: -110 },
      ] },
      { id: "s", type: "straight", stakeCents: 10_000, teaserPoints: null, rules: DAY_ONE_RULES, legs: [{ legNo: 1, gameId: "a", market: "total", side: "under", point: 47.5, price: -110 }] },
    ];
    store.gameMap.set("a", final("a", 27, 20));
    const r = await runScores(store, "KEY", fakeFetch([]), "schedule");
    expect(store.settled).toEqual(["s"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("t: Error: no teaser price");
    expect(store.advanced).toBe(1);
  });

  it("doesn't call the API when no game needs scores, but still grades and advances", async () => {
    const store = new FakeStore();
    store.advanceTo = 6;
    const f = fakeFetch(fixture("scores.json"));
    expect(await runScores(store, "KEY", f, "schedule")).toEqual({ scores: { status: "skipped", reason: "no games waiting on scores" }, settled: 0, advancedTo: 6, errors: [] });
    expect(f.calls).toHaveLength(0);
  });
  it("pulls scores while games are on, then grades what's final", async () => {
    const store = new FakeStore();
    store.awaiting = 2;
    store.pending = [
      { id: "s1", type: "straight", stakeCents: 10_000, teaserPoints: null, rules: DAY_ONE_RULES, legs: [{ legNo: 1, gameId: "a", market: "total", side: "under", point: 47.5, price: -110 }] },
    ];
    store.gameMap.set("a", final("a", 27, 20));
    const f = fakeFetch(fixture("scores.json"), 200, { "x-requests-remaining": "89998", "x-requests-last": "2" });
    const r = await runScores(store, "KEY", f, "schedule");
    expect(r.scores).toEqual({ status: "pulled", count: 2, remaining: 89998 });
    expect(r.settled).toBe(1);
    expect(store.settled).toEqual(["s1"]);
  });
});

describe("pulling the lines for an undo", () => {
  const t0 = new Date("2026-10-04T15:00:00Z");
  const since = "2026-10-04 15:00:00.5+00";
  const noSleep = async () => {};
  it("pulls unless the board's lines were fetched after the undo was asked for", async () => {
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    store.lastPull = new Date(t0.getTime() - 10_000); // seconds old, but from before the ask
    expect(await refreshForUndo(store, "KEY", f, "u1", since, t0, noSleep)).toBe("ok");
    expect(store.claims).toEqual([{ userId: "u1", forUndo: true }]);
    expect(f.calls).toHaveLength(1);
    const already = new FakeStore();
    already.fresh = true;
    const g = fakeFetch(fixture("odds.json"));
    expect(await refreshForUndo(already, "KEY", g, "u1", since, t0, noSleep)).toBe("ok");
    expect(g.calls).toHaveLength(0);
    expect(already.claims).toEqual([]);
  });
  it("waits for the pull another of the member's undos just made, rather than making its own", async () => {
    const store = new FakeStore();
    store.claimOk = "recent";
    const f = fakeFetch(fixture("odds.json"));
    let waits = 0;
    const lands = async () => { if (++waits === 2) store.fresh = true; };
    expect(await refreshForUndo(store, "KEY", f, "u1", since, t0, lands)).toBe("ok");
    expect(f.calls).toHaveLength(0);
  });
  it("says why when it can't: a limit or the credit floor (no use trying soon), or a failed pull", async () => {
    const limit = new FakeStore();
    limit.claimOk = "limit";
    expect(await refreshForUndo(limit, "KEY", fakeFetch(fixture("odds.json")), "u1", since, t0, noSleep)).toBe("limit");
    const floor = new FakeStore();
    floor.credits = { remaining: 100, at: t0 };
    expect(await refreshForUndo(floor, "KEY", fakeFetch(fixture("odds.json")), "u1", since, t0, noSleep)).toBe("credit_floor");
    expect(await refreshForUndo(new FakeStore(), "KEY", fakeFetch({ message: "down" }, 503), "u1", since, t0, noSleep)).toBe("failed");
    const unstored = new FakeStore();
    unstored.failIngest = true;
    expect(await refreshForUndo(unstored, "KEY", fakeFetch(fixture("odds.json")), "u1", since, t0, noSleep)).toBe("failed");
    const stuck = new FakeStore();
    stuck.claimOk = "recent";
    expect(await refreshForUndo(stuck, "KEY", fakeFetch(fixture("odds.json")), "u1", since, t0, noSleep)).toBe("failed");
  });
});

describe("checking finals against ESPN", () => {
  // ESPN's scoreboard, trimmed to the fields the check reads.
  const espnGame = (home: [string, number], away: [string, number], start: string, completed = true) => ({
    date: start,
    competitions: [{
      date: start,
      status: { type: { state: completed ? "post" : "in", completed } },
      competitors: [
        { homeAway: "home", team: { displayName: home[0], abbreviation: "H" }, score: String(home[1]) },
        { homeAway: "away", team: { displayName: away[0], abbreviation: "A" }, score: String(away[1]) },
      ],
    }],
  });
  const kcBuf = (kc: number, buf: number, completed = true) =>
    espnGame(["Kansas City Chiefs", kc], ["Buffalo Bills", buf], "2026-10-04T17:00Z", completed);
  // The Odds API's answer from the fixture, ESPN's from `espn` (or the status given).
  const feeds = (espn: unknown[] | number) => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://site.api.espn.com/")) {
        return typeof espn === "number"
          ? new Response("down", { status: espn })
          : new Response(JSON.stringify({ events: espn }), { status: 200 });
      }
      return new Response(JSON.stringify(fixture("scores.json")), { status: 200, headers: { "x-requests-remaining": "89998", "x-requests-last": "2" } });
    };
    return Object.assign(f, { calls });
  };
  const run = async (espn: unknown[] | number) => {
    const store = new FakeStore();
    store.awaiting = 2;
    const f = feeds(espn);
    await runScores(store, "KEY", f, "schedule");
    return { store, f, held: store.pulls.filter((p) => p.error.startsWith("final held")).map((p) => p.error) };
  };

  it("asks ESPN for the game's day, Eastern and UTC", () => {
    expect(espnDays(["2026-10-04T17:00:00Z", "2026-10-05T00:20:00Z"], "America/New_York")).toEqual(["20261004", "20261005"]);
    expect(new URL(espnUrl("20261004")).searchParams.get("dates")).toBe("20261004");
  });
  it("lets a final through when ESPN has the same final, matching teams by name rather than home and away", async () => {
    const { store, f, held } = await run([espnGame(["Buffalo Bills", 24], ["Kansas City Chiefs", 27], "2026-10-04T17:00Z")]);
    expect(store.scores).toContainEqual({ id: "evt_kc_buf", completed: true, homeScore: 27, awayScore: 24 });
    expect(held).toEqual([]);
    expect(f.calls.filter((u) => u.includes("espn")).map((u) => new URL(u).searchParams.get("dates"))).toEqual(["20261004", null]);
  });
  it("holds a final ESPN scores differently, and says so", async () => {
    const { store, held } = await run([kcBuf(27, 21)]);
    expect(store.scores).toContainEqual({ id: "evt_kc_buf", completed: false, homeScore: 27, awayScore: 24 });
    expect(held).toEqual(["final held: Buffalo Bills at Kansas City Chiefs (24-27): ESPN's final is 21-27. Enter the right final score by hand."]);
  });
  it("holds a final quietly while ESPN still shows the game on", async () => {
    const { store, held } = await run([kcBuf(20, 24, false)]);
    expect(store.scores).toContainEqual({ id: "evt_kc_buf", completed: false, homeScore: 27, awayScore: 24 });
    expect(held).toEqual([]);
  });
  it("holds a final when ESPN is down or doesn't list the game", async () => {
    const down = await run(503);
    expect(down.store.scores).toContainEqual({ id: "evt_kc_buf", completed: false, homeScore: 27, awayScore: 24 });
    expect(down.held).toEqual(["final held: Buffalo Bills at Kansas City Chiefs (24-27): couldn't check ESPN: 20261004 (HTTP 503), this week (HTTP 503)"]);
    const missing = await run([espnGame(["Kansas City Chiefs", 27], ["Buffalo Bills", 24], "2026-10-11T17:00Z")]);
    expect(missing.store.scores).toContainEqual({ id: "evt_kc_buf", completed: false, homeScore: 27, awayScore: 24 });
    expect(missing.held).toEqual(["final held: Buffalo Bills at Kansas City Chiefs (24-27): ESPN doesn't list this game"]);
  });
  it("leaves games still on alone, and doesn't call ESPN when nothing is final", async () => {
    const { store } = await run([kcBuf(27, 24)]);
    expect(store.scores).toContainEqual({ id: "evt_bal_pit", completed: false, homeScore: 10, awayScore: 7 });
    const none = await confirmFinals([], [{ id: "x", completed: false, homeScore: 3, awayScore: 0 }], async () => { throw new Error("no call"); }, "America/New_York");
    expect(none.held).toEqual([]);
  });
  it("skips malformed ESPN games", () => {
    expect(parseEspn({ events: [null, { competitions: [{ date: "2026-10-04T17:00Z", competitors: [{ team: { displayName: "A" }, score: "x" }, {}] }] }] })).toEqual([]);
    expect(parseEspn(null)).toEqual([]);
  });
});
