import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gradePending, type GameResult, type PendingSlip } from "./grading.ts";
import { pullLines, runScores, type Settings, type Store } from "./jobs.ts";
import { normalizeOdds, normalizeScores, oddsUrl, readUsage, scoresUrl, type NormalizedEvent, type NormalizedScore } from "./odds-api.ts";
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
    ["a", { id: "a", kickoffAt: new Date("2026-10-04T17:00:00Z"), status: "scheduled", week: 5 }],
    ["old", { id: "old", kickoffAt: new Date("2026-10-01T11:00:00Z"), status: "scheduled", week: 5 }],
    ["next", { id: "next", kickoffAt: new Date("2026-10-11T17:00:00Z"), status: "scheduled", week: 6 }],
  ]);
  const lines: CurrentLine[] = [
    { gameId: "a", market: "spread", side: "home", point: -3, price: -112, source: "draftkings" },
    { gameId: "a", market: "total", side: "over", point: 47.5, price: -110, source: "draftkings" },
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
        { gameId: "a", market: "total" as const, side: "over" as const, point: 47.5, price: -110 },
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
    refreshOnBetSeconds: 120,
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
  claimOk = true;
  failIngest = false;
  failSettle = new Set<string>();
  costs: { error: string; cost: number | null; remaining: number | null }[] = [];

  async settings() { return this.settingsValue; }
  async lastCredits() { return this.credits; }
  async lastGoodLinesPull() { return null; }
  async ingestLines(trigger: string, events: NormalizedEvent[], _cost: number | null, remaining: number | null) {
    if (this.failIngest) throw new Error("connection reset");
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
  async claimBetRefresh() { return this.claimOk; }
  async gamesAwaitingScores() { return this.awaiting; }
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
  it("skips scheduled pulls overnight, but not pulls for a bet", async () => {
    const store = new FakeStore();
    const f = fakeFetch(fixture("odds.json"));
    const threeAm = new Date("2026-10-01T07:00:00Z");
    expect((await pullLines(store, "KEY", f, "schedule", threeAm)).status).toBe("skipped");
    expect((await pullLines(store, "KEY", f, "bet", threeAm)).status).toBe("pulled");
    expect(f.calls).toHaveLength(1);
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
    store.claimOk = false;
    const f = fakeFetch(fixture("odds.json"));
    expect(await pullLines(store, "KEY", f, "bet", inWindow)).toMatchObject({ status: "skipped" });
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
