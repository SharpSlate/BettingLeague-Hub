// The demo backend: the whole site on made-up sample data, in memory, with no
// server. It uses the same shared rules code as the real site, so the slip
// checks, payouts and grading are the real ones. Everything resets on reload.
import { DAY_ONE_RULES, requiredMinimumCents, type BetType, type Leg, type RuleSet } from "@rules";
import { gradePending, type GameResult, type PendingSlip } from "../../../supabase/functions/_shared/grading.ts";
import { checkPlacement, type GameInfo } from "../../../supabase/functions/_shared/placement.ts";
import { TEAMS, team } from "./teams.ts";
import type {
  AdminProblem, AdminUser, Api, AuditRow, Entrant, GameStatus, GameView, HiddenPick, League, LegView, Me, MyEntry, PlacementRequest,
  PlaceResult, RuleVersion, SlipView, SplashImport, StandingRow, WeekInfo,
} from "./types.ts";

const H = 3_600_000;
const D = 24 * H;
const OPEN_WEEK = 5;

type Line = { market: Leg["market"]; side: Leg["side"]; point: number | null; price: number; source: string; asOf: number };
interface DGame {
  id: string; week: number; kickoffAt: number; home: string; away: string; status: GameStatus;
  homeScore: number | null; awayScore: number | null; lines: Line[];
}
interface DLeg extends Leg { legNo: number; teasedPoint: number | null; book: string; result: LegView["result"] }
interface DSlip {
  id: string; entryId: string; placedBy: string; week: number; type: BetType;
  teaserPoints: number | null; stakeCents: number; quotedAmerican: number; potentialPayoutCents: number;
  status: SlipView["status"]; payoutCents: number | null; placedAt: number; settledAt: number | null; legs: DLeg[];
  voidedByAdmin?: boolean;
}
interface DEntry {
  id: string; name: string; startingBankCents: number; managers: string[];
  ledger: { amount: number; kind: string; at: number; note: string; week?: number }[];
  baseline: { wins: number; losses: number; pushes: number; risk: number; ret: number; winnings: number };
}
interface DUser { id: string; displayName: string; email: string; isAdmin: boolean }

const YOU = "u-you";

/** Eastern date parts for a moment. */
function etParts(t: number) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!) };
}

/** The moment it's hh:mm Eastern, `days` days from today (Eastern). */
function etSlot(now: number, days: number, hh: number, mm: number): number {
  const t = etParts(now);
  let guess = Date.UTC(t.y, t.m - 1, t.d + days, hh + 4, mm); // EDT is UTC-4
  const g = etParts(guess);
  if (g.h !== hh) guess += (hh - g.h) * H; // EST is UTC-5
  return guess;
}

function lines(now: number, spread: number, total: number, mlHome: number, mlAway: number, juice: [number, number] = [-110, -110], source = "draftkings"): Line[] {
  const asOf = now - 7 * 60_000;
  return [
    { market: "spread", side: "home", point: spread, price: juice[0], source, asOf },
    { market: "spread", side: "away", point: -spread, price: juice[1], source, asOf },
    { market: "total", side: "over", point: total, price: -110, source, asOf },
    { market: "total", side: "under", point: total, price: -110, source, asOf },
    { market: "moneyline", side: "home", point: null, price: mlHome, source, asOf },
    { market: "moneyline", side: "away", point: null, price: mlAway, source, asOf },
  ];
}

function seed(now: number) {
  const users: DUser[] = [
    { id: YOU, displayName: "You", email: "you@example.com", isAdmin: true },
    { id: "u-commish", displayName: "Commish", email: "commish@example.com", isAdmin: true },
    ...["Dan", "Mo", "Rico", "Tess", "Jay", "Lou"].map((n) => ({ id: `u-${n.toLowerCase()}`, displayName: n, email: `${n.toLowerCase()}@example.com`, isAdmin: false })),
  ];
  const mk = (id: string, name: string, managers: string[], bank: number, net: number, rec: [number, number, number]): DEntry => ({
    id, name, managers, startingBankCents: bank - net,
    ledger: [{ amount: bank, kind: "import", at: now - 9 * D, note: "Splash standings after week 3 (sample)" }],
    baseline: { wins: rec[0], losses: rec[1], pushes: rec[2], risk: 900_000 + Math.abs(net) * 2, ret: 900_000 + Math.abs(net) * 2 + net, winnings: Math.max(net, 0) + 250_000 },
  });
  const entries: DEntry[] = [
    mk("e-crab", "Crab Cake Kings", [YOU], 1_922_730, 422_730, [9, 6, 1]),
    mk("e-oldbay", "Old Bay Bettors", [YOU], 1_052_730, -447_270, [5, 9, 0]),
    mk("e-harbor", "Inner Harbor Sharps", ["u-commish"], 2_690_915, 1_190_915, [12, 4, 0]),
    mk("e-fells", "Fells Point Fades", ["u-dan"], 1_455_000, -45_000, [7, 7, 1]),
    mk("e-canton", "Canton Crushers", ["u-mo"], 1_730_050, 230_050, [8, 6, 0]),
    mk("e-fedhill", "Federal Hill Hammers", ["u-rico", "u-tess"], 1_210_000, -290_000, [6, 8, 1]),
    mk("e-hampden", "Hampden Hustle", ["u-jay"], 890_500, -609_500, [4, 10, 0]),
    mk("e-vernon", "Mount Vernon Money", ["u-lou"], 1_604_400, 104_400, [8, 7, 0]),
  ];

  const sun = (7 - etParts(now).dow) % 7 || 7; // days until next Sunday
  const g = (id: string, week: number, kickoffAt: number, home: string, away: string, status: GameStatus, hs: number | null, as: number | null, l: Line[]): DGame =>
    ({ id, week, kickoffAt, home, away, status, homeScore: hs, awayScore: as, lines: l });
  const games: DGame[] = [
    g("g4-1", 4, now - 6 * D, "CLE", "CIN", "final", 20, 23, lines(now, 2.5, 42.5, 120, -140)),
    g("g4-2", 4, now - 5 * D, "BAL", "PIT", "final", 27, 17, lines(now, -6.5, 41, -300, 240)),
    g("g4-3", 4, now - 5 * D, "SEA", "WAS", "final", 24, 24, lines(now, -7.5, 40.5, -375, 300)),
    // Last night's game is final, one is live now, and the rest kick off in the usual
    // Sunday and Monday slots.
    g("g-thu", OPEN_WEEK, etSlot(now, -1, 20, 15), "DAL", "NYG", "final", 31, 20, lines(now, -4, 44.5, -200, 170)),
    g("g-live", OPEN_WEEK, now - 80 * 60_000, "PHI", "WAS", "live", 14, 10, lines(now, -5.5, 46.5, -230, 190)),
    g("g-1", OPEN_WEEK, etSlot(now, sun, 13, 0), "KC", "BUF", "scheduled", null, null, lines(now, -3, 47.5, -155, 130, [-112, -108])),
    g("g-2", OPEN_WEEK, etSlot(now, sun, 13, 0), "BAL", "CLE", "scheduled", null, null, lines(now, -8.5, 40, -420, 330)),
    g("g-3", OPEN_WEEK, etSlot(now, sun, 13, 0), "DET", "GB", "scheduled", null, null, lines(now, -2.5, 49.5, -135, 115)),
    g("g-4", OPEN_WEEK, etSlot(now, sun, 16, 5), "SF", "LAR", "scheduled", null, null, lines(now, -3.5, 45, -175, 150, [-105, -115])),
    g("g-5", OPEN_WEEK, etSlot(now, sun, 16, 25), "MIA", "NYJ", "scheduled", null, null, lines(now, -1, 43.5, -118, -102, [-110, -110], "fanduel")),
    g("g-6", OPEN_WEEK, etSlot(now, sun, 20, 20), "CIN", "PIT", "scheduled", null, null, lines(now, 1.5, 44, 105, -125)),
    g("g-7", OPEN_WEEK, etSlot(now, sun + 1, 20, 15), "TB", "NO", "scheduled", null, null, lines(now, -6, 43, -250, 205)),
  ];

  let n = 0;
  const leg = (gameId: string, market: Leg["market"], side: Leg["side"], extra: Partial<DLeg> = {}): DLeg => {
    const game = games.find((x) => x.id === gameId)!;
    const line = game.lines.find((l) => l.market === market && l.side === side)!;
    return { legNo: 0, gameId, market, side, point: line.point, price: line.price, teasedPoint: null, book: line.source, result: "pending", ...extra };
  };
  const slip = (entryId: string, placedBy: string, week: number, type: DSlip["type"], stake: number, legs: DLeg[], o: Partial<DSlip>): DSlip => ({
    id: `s-${++n}`, entryId, placedBy, week, type, teaserPoints: null, stakeCents: stake, quotedAmerican: -110, potentialPayoutCents: stake * 2,
    status: "pending", payoutCents: null, placedAt: now - 3 * D, settledAt: null, legs: legs.map((l, i) => ({ ...l, legNo: i + 1 })), ...o,
  });
  const slips: DSlip[] = [
    // Last week, settled.
    slip("e-crab", YOU, 4, "teaser", 200_000, [leg("g4-2", "spread", "home", { point: -6.5, teasedPoint: -0.5, result: "won" }), leg("g4-1", "spread", "away", { point: -2.5, teasedPoint: 3.5, result: "won" })],
      { teaserPoints: 6, quotedAmerican: -110, potentialPayoutCents: 381_818, status: "won", payoutCents: 381_818, placedAt: now - 7 * D, settledAt: now - 5 * D }),
    slip("e-crab", YOU, 4, "straight", 150_000, [leg("g4-3", "spread", "home", { result: "lost", price: -110 })],
      { quotedAmerican: -110, potentialPayoutCents: 286_364, status: "lost", payoutCents: 0, placedAt: now - 6 * D, settledAt: now - 5 * D }),
    slip("e-oldbay", YOU, 4, "straight", 100_000, [leg("g4-3", "moneyline", "home", { result: "push" })],
      { quotedAmerican: -375, potentialPayoutCents: 126_667, status: "push", payoutCents: 100_000, placedAt: now - 6 * D, settledAt: now - 5 * D }),
    // This week: Thursday's game is final and graded.
    slip("e-harbor", "u-commish", OPEN_WEEK, "straight", 300_000, [leg("g-thu", "spread", "home", { result: "won" })],
      { potentialPayoutCents: 572_727, status: "won", payoutCents: 572_727, placedAt: now - 2 * D, settledAt: now - 22 * H }),
    slip("e-fells", "u-dan", OPEN_WEEK, "straight", 250_000, [leg("g-thu", "total", "under", { result: "lost" })],
      { potentialPayoutCents: 477_273, status: "lost", payoutCents: 0, placedAt: now - 2 * D, settledAt: now - 22 * H }),
    // Live now, so revealed.
    slip("e-canton", "u-mo", OPEN_WEEK, "straight", 400_000, [leg("g-live", "moneyline", "away")], { quotedAmerican: 190, potentialPayoutCents: 1_160_000, placedAt: now - 20 * H }),
    slip("e-crab", YOU, OPEN_WEEK, "parlay", 50_000, [leg("g-live", "total", "over"), leg("g-7", "spread", "away")], { quotedAmerican: 264, potentialPayoutCents: 182_231, placedAt: now - 10 * H }),
    // Half revealed: its odds and payout stay hidden until the second leg kicks off.
    // 1,000 units x 21/11 x 5/2 = 4,772.73.
    slip("e-vernon", "u-lou", OPEN_WEEK, "parlay", 100_000, [leg("g-live", "spread", "home"), leg("g-4", "moneyline", "away")], { quotedAmerican: 377, potentialPayoutCents: 477_273, placedAt: now - 4 * H }),
    // Hidden until kickoff.
    slip("e-crab", YOU, OPEN_WEEK, "straight", 300_000, [leg("g-1", "spread", "home", { price: -112 })], { quotedAmerican: -112, potentialPayoutCents: 567_857, placedAt: now - 3 * H }),
    slip("e-harbor", "u-commish", OPEN_WEEK, "teaser", 500_000, [leg("g-2", "spread", "home", { teasedPoint: -2.5 }), leg("g-3", "spread", "home", { teasedPoint: 3.5 })],
      { teaserPoints: 6, potentialPayoutCents: 954_545, placedAt: now - 5 * H }),
    slip("e-vernon", "u-lou", OPEN_WEEK, "straight", 200_000, [leg("g-4", "total", "under")], { potentialPayoutCents: 381_818, placedAt: now - 2 * H }),
    slip("e-fedhill", "u-tess", OPEN_WEEK, "parlay", 100_000, [leg("g-5", "moneyline", "home"), leg("g-6", "total", "over")], { quotedAmerican: 263, potentialPayoutCents: 362_712, placedAt: now - 40 * 60_000 }),
  ];
  // Stakes and payouts in the ledger, as the database would have them.
  for (const s of slips) {
    const e = entries.find((x) => x.id === s.entryId)!;
    e.ledger.push({ amount: -s.stakeCents, kind: "stake", at: s.placedAt, note: "" });
    if (s.payoutCents) e.ledger.push({ amount: s.payoutCents, kind: s.status === "won" ? "payout" : "refund", at: s.settledAt!, note: "" });
  }
  entries.find((x) => x.id === "e-hampden")!.ledger.push({ amount: -45_000, kind: "weekly_minimum", at: now - 2 * D, note: "Week 4 minimum: wagered 2,220 of 2,670 units", week: 4 });

  const audit: AuditRow[] = [
    { id: 4, actorName: "Commish", action: "line_set", targetType: "game", targetId: "g-2", before: null, after: { market: "spread" }, reason: "Feed was behind on the Ravens injury news", createdAt: new Date(now - 30 * H).toISOString() },
    { id: 3, actorName: null, action: "week_opened", targetType: "week", targetId: "5", before: { closed: 4 }, after: { opened: 5 }, reason: "The previous week finished", createdAt: new Date(now - 2 * D - 3 * H).toISOString() },
    { id: 2, actorName: "Commish", action: "bank_adjusted", targetType: "entry", targetId: "e-fells", before: { bankCents: 1_450_000 }, after: { bankCents: 1_455_000, amountCents: 5_000 }, reason: "Splash rounding correction", createdAt: new Date(now - 8 * D).toISOString() },
    { id: 1, actorName: "Commish", action: "splash_import", targetType: "entry", targetId: "e-crab", before: null, after: { bankCents: 1_922_730 }, reason: "Splash standings after week 3", createdAt: new Date(now - 9 * D).toISOString() },
  ];
  return { users, entries, games, slips, audit, rules: [{ version: 1, effectiveWeek: 1, document: DAY_ONE_RULES, note: "Day-one rules agreed on 2026-09-28.", createdAt: new Date(now - 10 * D).toISOString() }] as RuleVersion[], lastPullAt: now - 7 * 60_000, credits: 91_240 };
}

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

export class DemoApi implements Api {
  readonly demo = true;
  private s = seed(Date.now());
  private signedIn = false;
  private listeners = new Set<() => void>();
  private nextId = 1000;
  /** Bets placed, by the id the site sent with each, so a retry returns the same bet. */
  private placedRefs = new Map<string, { slipId: string; payoutCents: number; american: number; bet: string }>();

  private emit() { for (const l of this.listeners) l(); }
  private entry(id: string) { return this.s.entries.find((e) => e.id === id)!; }
  private available(e: DEntry) { return e.ledger.reduce((a, l) => a + l.amount, 0); }
  private pending(e: DEntry) { return this.s.slips.filter((s) => s.entryId === e.id && s.status === "pending").reduce((a, s) => a + s.stakeCents, 0); }
  private bank(e: DEntry) { return this.available(e) + this.pending(e); }
  private mine(entryId: string) { return this.entry(entryId).managers.includes(YOU); }
  private game(id: string) { return this.s.games.find((g) => g.id === id)!; }
  private firstKickoff(s: DSlip) { return Math.min(...s.legs.map((l) => this.game(l.gameId).kickoffAt)); }
  private revealed(s: DSlip, now = Date.now()) { return this.firstKickoff(s) <= now; }
  /** Counts toward the weekly minimum: everything but an undone bet or one an admin voided. */
  private counts(s: DSlip) { return s.status !== "undone" && !(s.status === "void" && s.voidedByAdmin); }
  /** Every leg's game has kicked off, so a parlay's odds no longer give anything away. */
  private fullyRevealed(s: DSlip, now = Date.now()) { return s.legs.every((l) => this.game(l.gameId).kickoffAt <= now); }
  private audit(action: string, targetType: string, targetId: string, after: unknown, reason: string) {
    this.s.audit.unshift({ id: this.nextId++, actorName: "You", action, targetType, targetId, before: null, after, reason, createdAt: new Date().toISOString() });
  }

  async getSession() { return this.signedIn ? { userId: YOU } : null; }
  onAuthChange(cb: () => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  async sendCode(email: string) { await wait(); if (!email.includes("@")) throw new Error("Enter your email address."); }
  async verifyCode(_email: string, code: string) {
    await wait();
    if (!/^\d{6}$/.test(code.trim())) throw new Error("Codes are 6 digits. In the demo, any 6 digits work.");
    this.signedIn = true;
    this.emit();
  }
  async signInWithGoogle() { await wait(); this.signedIn = true; this.emit(); }
  async signOut() { this.signedIn = false; this.emit(); }
  async me(): Promise<Me> { return { id: YOU, displayName: this.s.users[0]!.displayName, isAdmin: true }; }

  async league(): Promise<League> {
    const now = Date.now();
    return {
      name: "BALTIMORE DEGENERATES",
      openWeek: { week: OPEN_WEEK, label: `Week ${OPEN_WEEK}`, startsAt: new Date(now - 2 * D).toISOString(), endsAt: new Date(now + 5 * D).toISOString(), status: "open", ruleSetVersion: this.s.rules[0]!.version },
      timezone: "America/New_York", pullWindowStart: "08:00", pullWindowEnd: "01:00", pullEveryMinutes: 30,
      books: ["draftkings", "fanduel"], lastPullAt: new Date(this.s.lastPullAt).toISOString(), creditsRemaining: this.s.credits,
    };
  }
  async teams() { return TEAMS; }

  async standings(range?: { from?: string; to?: string; week?: number }): Promise<StandingRow[]> {
    await wait(60);
    const from = range?.from ? Date.parse(range.from) : -Infinity;
    const to = range?.to ? Date.parse(range.to) : Infinity;
    const week = range?.week;
    const season = !range?.from && !range?.to && week === undefined;
    return this.s.entries.map((e) => {
      const settled = this.s.slips.filter((s) => s.entryId === e.id && ["won", "lost", "push"].includes(s.status)
        && (week === undefined || s.week === week) && s.settledAt! >= from && s.settledAt! < to);
      const count = (st: string) => settled.filter((s) => s.status === st).length;
      const risk = settled.reduce((a, s) => a + s.stakeCents, 0);
      const ret = settled.reduce((a, s) => a + (s.payoutCents ?? 0), 0);
      const winnings = settled.filter((s) => s.status === "won").reduce((a, s) => a + s.payoutCents! - s.stakeCents, 0);
      const other = e.ledger.filter((l) => ["weekly_minimum", "adjustment"].includes(l.kind) && (week === undefined || l.week === week) && l.at >= from && l.at < to)
        .reduce((a, l) => a + l.amount, 0);
      const mine = this.mine(e.id);
      const pend = this.s.slips.filter((s) => s.entryId === e.id && s.status === "pending" && (mine || this.revealed(s)));
      const wk = this.s.slips.filter((s) => s.entryId === e.id && s.week === OPEN_WEEK && this.counts(s) && (mine || this.revealed(s)));
      const b = e.baseline;
      const seasonWinnings = b.winnings + this.s.slips.filter((s) => s.entryId === e.id && s.status === "won").reduce((a, s) => a + s.payoutCents! - s.stakeCents, 0);
      return {
        entryId: e.id, name: e.name, isMine: mine, bankCents: this.bank(e), seasonNetCents: this.bank(e) - e.startingBankCents, seasonWinningsCents: seasonWinnings,
        wins: count("won") + (season ? b.wins : 0), losses: count("lost") + (season ? b.losses : 0), pushes: count("push") + (season ? b.pushes : 0),
        riskCents: risk + (season ? b.risk : 0), returnCents: ret + (season ? b.ret : 0),
        netCents: season ? this.bank(e) - e.startingBankCents : ret - risk + other, winningsCents: winnings + (season ? b.winnings : 0),
        atRiskCents: pend.reduce((a, s) => a + s.stakeCents, 0), week: OPEN_WEEK,
        requiredCents: requiredMinimumCents(this.weekStartBank(e), 30), wageredCents: wk.reduce((a, s) => a + s.stakeCents, 0),
      };
    });
  }
  private weekStartBank(e: DEntry) {
    const weekStart = Date.now() - 2 * D;
    const before = e.ledger.filter((l) => l.at < weekStart).reduce((a, l) => a + l.amount, 0);
    const pendingThen = this.s.slips.filter((s) => s.entryId === e.id && s.placedAt < weekStart && (s.status === "pending" || (s.settledAt ?? 0) >= weekStart)).reduce((a, s) => a + s.stakeCents, 0);
    return before + pendingThen;
  }

  async games(week: number): Promise<GameView[]> {
    await wait(60);
    return this.s.games.filter((g) => g.week === week).sort((a, b) => a.kickoffAt - b.kickoffAt).map((g) => ({
      id: g.id, week: g.week, kickoffAt: new Date(g.kickoffAt).toISOString(), locksAt: new Date(g.kickoffAt).toISOString(),
      home: team(g.home), away: team(g.away), status: g.status,
      homeScore: g.homeScore, awayScore: g.awayScore,
      lines: g.status === "scheduled" ? g.lines.map((l) => ({ ...l, asOf: new Date(l.asOf).toISOString() })) : [],
    }));
  }

  async myEntries(): Promise<MyEntry[]> {
    return this.s.entries.filter((e) => this.mine(e.id)).map((e) => ({
      entryId: e.id, name: e.name, availableCents: this.available(e), pendingCents: this.pending(e), bankCents: this.bank(e), week: OPEN_WEEK,
      requiredCents: requiredMinimumCents(this.weekStartBank(e), 30),
      wageredCents: this.s.slips.filter((s) => s.entryId === e.id && s.week === OPEN_WEEK && this.counts(s)).reduce((a, s) => a + s.stakeCents, 0),
    }));
  }

  async slips(q: { entryId?: string; mine?: boolean; week?: number; settled?: boolean; limit?: number }): Promise<SlipView[]> {
    await wait(60);
    const now = Date.now();
    return this.s.slips
      .filter((s) => s.status !== "undone")
      .filter((s) => this.mine(s.entryId) || this.revealed(s, now))
      .filter((s) => (q.entryId ? s.entryId === q.entryId : true))
      .filter((s) => (q.mine ? this.mine(s.entryId) : true))
      .filter((s) => (q.week !== undefined ? s.week === q.week : true))
      .filter((s) => (q.settled === undefined ? true : q.settled ? s.status !== "pending" : s.status === "pending"))
      .sort((a, b) => b.placedAt - a.placedAt)
      .slice(0, q.limit ?? 200)
      .map((s) => ({
        id: s.id, entryId: s.entryId, entryName: this.entry(s.entryId).name,
        placedByName: this.s.users.find((u) => u.id === s.placedBy)?.displayName ?? null, week: s.week, type: s.type, teaserPoints: s.teaserPoints,
        stakeCents: s.stakeCents, legCount: s.legs.length,
        // Like the real site: another entry's parlay shows odds and payout once every leg is revealed.
        quotedAmerican: this.mine(s.entryId) || this.fullyRevealed(s, now) ? s.quotedAmerican : null,
        potentialPayoutCents: this.mine(s.entryId) || this.fullyRevealed(s, now) ? s.potentialPayoutCents : null,
        ruleSetVersion: 1, status: s.status, payoutCents: s.payoutCents, placedAt: new Date(s.placedAt).toISOString(),
        settledAt: s.settledAt ? new Date(s.settledAt).toISOString() : null,
        legs: s.legs.filter((l) => this.mine(s.entryId) || this.game(l.gameId).kickoffAt <= now).map((l) => {
          const g = this.game(l.gameId);
          return {
            ...l,
            game: { home: team(g.home), away: team(g.away), kickoffAt: new Date(g.kickoffAt).toISOString(), locksAt: new Date(g.kickoffAt).toISOString(), status: g.status, homeScore: g.homeScore, awayScore: g.awayScore },
          };
        }),
      }));
  }

  async hiddenActivity(): Promise<HiddenPick[]> {
    return this.s.slips
      .filter((s) => s.status === "pending" && !this.mine(s.entryId) && !this.revealed(s))
      .sort((a, b) => b.placedAt - a.placedAt)
      .map((s) => ({ entryId: s.entryId, name: this.entry(s.entryId).name, placedAt: new Date(s.placedAt).toISOString() }));
  }

  async ruleVersions() { return [...this.s.rules].sort((a, b) => b.version - a.version); }

  async weeks(): Promise<WeekInfo[]> {
    const now = Date.now();
    return Array.from({ length: 23 }, (_, i) => i + 1).map((w) => ({
      week: w,
      label: w <= 18 ? `Week ${w}` : ["Wild Card", "Divisional", "Conference Championships", "Super Bowl", "Super Bowl"][w - 19]!,
      startsAt: new Date(now - 2 * D + (w - OPEN_WEEK) * 7 * D).toISOString(),
      endsAt: new Date(now + 5 * D + (w - OPEN_WEEK) * 7 * D).toISOString(),
      status: w < OPEN_WEEK ? "closed" : w === OPEN_WEEK ? "open" : "upcoming",
      ruleSetVersion: w <= OPEN_WEEK ? 1 : null,
    }));
  }

  async entrants(): Promise<Entrant[]> {
    return this.s.entries.map((e) => ({
      entryId: e.id, name: e.name, status: "active",
      managers: e.managers.map((m) => this.s.users.find((u) => u.id === m)!.displayName),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async auditLog() { return this.s.audit; }

  async placeSlip(req: PlacementRequest): Promise<PlaceResult> {
    await wait(350);
    // As the server does: a resend of the same bet gets the bet back; the same id on a
    // different bet, or on one since undone or voided, is refused.
    const bet = JSON.stringify([req.entryId, req.type, req.type === "teaser" ? req.teaserPoints : null, req.stakeCents,
      req.legs.map((l) => `${l.gameId}|${l.market}|${l.side}`).sort()]);
    const prior = this.placedRefs.get(req.clientRef);
    if (prior) {
      if (prior.bet !== bet) return { ok: false, kind: "error", code: "client_ref_conflict", message: "That bet couldn't be matched to your slip. Reload and try again." };
      const status = this.s.slips.find((x) => x.id === prior.slipId)?.status;
      if (status === "undone" || status === "void") {
        return { ok: false, kind: "error", code: "client_ref_used", message: "That bet was undone or voided. Place it again as a new bet." };
      }
      return { ok: true, slipId: prior.slipId, payoutCents: prior.payoutCents, american: prior.american };
    }
    const e = this.entry(req.entryId);
    if (!e || !this.mine(e.id)) return { ok: false, kind: "error", message: "You don't manage that entry." };
    const rules = this.s.rules[0]!.document;
    const games = new Map<string, GameInfo>(this.s.games.map((g) => [g.id, { id: g.id, locksAt: new Date(g.kickoffAt), status: g.status, week: g.week }]));
    const lines = this.s.games.flatMap((g) => (g.status === "scheduled" ? g.lines.map((l) => ({ gameId: g.id, ...l })) : []));
    const check = checkPlacement({ ...req }, rules, { availableCents: this.available(e), bankCents: this.bank(e) }, OPEN_WEEK, games, lines, new Date());
    if (!check.ok) {
      return check.kind === "moved"
        ? { ok: false, kind: "moved", message: "A line moved. Check the new number.", lines: check.lines }
        : { ok: false, kind: "invalid", problems: check.problems };
    }
    const id = `s-${this.nextId++}`;
    const legs: DLeg[] = req.legs.map((l, i) => {
      const line = lines.find((x) => x.gameId === l.gameId && x.market === l.market && x.side === l.side)!;
      const t = req.type === "teaser" ? req.teaserPoints! : null;
      const teased = t === null || l.point === null ? null : l.market === "spread" ? l.point + t : l.side === "over" ? l.point - t : l.point + t;
      return { ...l, legNo: i + 1, teasedPoint: teased, book: line.source, result: "pending" };
    });
    this.s.slips.push({
      id, entryId: e.id, placedBy: YOU, week: OPEN_WEEK, type: req.type, teaserPoints: req.type === "teaser" ? req.teaserPoints : null,
      stakeCents: req.stakeCents, quotedAmerican: check.quote.american, potentialPayoutCents: check.quote.payoutCents, status: "pending",
      payoutCents: null, placedAt: Date.now(), settledAt: null, legs,
    });
    e.ledger.push({ amount: -req.stakeCents, kind: "stake", at: Date.now(), note: "" });
    this.placedRefs.set(req.clientRef, { slipId: id, payoutCents: check.quote.payoutCents, american: check.quote.american, bet });
    return { ok: true, slipId: id, payoutCents: check.quote.payoutCents, american: check.quote.american };
  }

  async undoSlip(slipId: string) {
    await wait();
    const s = this.s.slips.find((x) => x.id === slipId);
    if (!s || !this.mine(s.entryId)) throw new Error("not_found");
    if (s.status !== "pending") throw new Error("not_pending");
    if (Date.now() > s.placedAt + DAY_ONE_RULES.undoMinutes * 60_000) throw new Error("undo_window_passed");
    if (this.revealed(s)) throw new Error("game_started");
    s.status = "undone";
    this.entry(s.entryId).ledger.push({ amount: s.stakeCents, kind: "undo", at: Date.now(), note: "" });
  }

  async setDisplayName(name: string) { this.s.users[0]!.displayName = name.trim(); }

  async adminUsers(): Promise<AdminUser[]> {
    return this.s.users.map((u) => ({
      userId: u.id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin,
      entryNames: this.s.entries.filter((e) => e.managers.includes(u.id)).map((e) => e.name),
    }));
  }
  async adminRecentProblems(): Promise<AdminProblem[]> {
    return [];
  }
  async adminAddMember(email: string, displayName: string, entryId: string | null) {
    await wait();
    if (!displayName.trim()) throw new Error("Give the new member a display name.");
    const id = `u-${this.nextId++}`;
    this.s.users.push({ id, displayName: displayName.trim(), email, isAdmin: false });
    if (entryId) this.entry(entryId).managers.push(id);
    this.audit("member_added", "profile", id, { displayName }, "");
  }
  async adminAddEntry(name: string, startingBankCents: number) {
    const id = `e-${this.nextId++}`;
    this.s.entries.push({ id, name, startingBankCents, managers: [], ledger: startingBankCents ? [{ amount: startingBankCents, kind: "opening", at: Date.now(), note: "Starting bank" }] : [], baseline: { wins: 0, losses: 0, pushes: 0, risk: 0, ret: 0, winnings: 0 } });
    this.audit("entry_added", "entry", id, { name, startingBankCents }, "");
    return id;
  }
  async adminSetManager(entryId: string, userId: string, add: boolean) {
    const e = this.entry(entryId);
    const riding = this.s.slips.some((s) => s.entryId === e.id && s.status === "pending");
    if (add && userId === YOU && (e.managers.some((m) => m !== YOU) || riding)) throw new Error("self_add_blocked");
    if (!add && !e.managers.some((m) => m !== userId) && riding) throw new Error("last_manager");
    e.managers = add ? [...new Set([...e.managers, userId])] : e.managers.filter((m) => m !== userId);
    this.audit(add ? "manager_added" : "manager_removed", "entry", entryId, { userId, member: this.s.users.find((u) => u.id === userId)?.displayName, entry: e.name }, "");
  }
  async adminSetAdmin(userId: string, isAdmin: boolean) {
    const u = this.s.users.find((x) => x.id === userId);
    if (!u) throw new Error("not_found");
    if (!isAdmin && this.s.users.filter((x) => x.isAdmin && x.id !== userId).length === 0) throw new Error("last_admin");
    u.isAdmin = isAdmin;
    this.audit(isAdmin ? "admin_granted" : "admin_removed", "profile", userId, null, "");
  }
  async adminImportSplash(a: SplashImport) {
    const e = this.entry(a.entryId);
    if (this.s.slips.some((s) => s.entryId === e.id)) throw new Error("entry_has_bets");
    e.ledger.push({ amount: a.bankCents - this.available(e), kind: "import", at: Date.now(), note: a.note });
    e.startingBankCents = a.bankCents - a.netCents;
    e.baseline = { wins: a.wins, losses: a.losses, pushes: a.pushes, risk: a.riskCents, ret: a.returnCents, winnings: a.winningsCents };
    this.audit("splash_import", "entry", e.id, { bankCents: a.bankCents }, a.note);
  }
  async adminAdjustBank(entryId: string, amountCents: number, reason: string) {
    if (reason.trim().length < 3) throw new Error("reason_required");
    const e = this.entry(entryId);
    if (this.available(e) + amountCents < 0) throw new Error("insufficient_units");
    const bank = this.bank(e);
    e.ledger.push({ amount: amountCents, kind: "adjustment", at: Date.now(), note: reason, week: OPEN_WEEK });
    this.audit("bank_adjusted", "entry", entryId, { bankCents: bank + amountCents, amountCents }, reason);
  }
  async adminOpenNextWeek(expectedOpenWeek: number | null): Promise<number | null> {
    if (expectedOpenWeek !== OPEN_WEEK) throw new Error("week_changed");
    throw new Error("The demo stays on week 5.");
  }
  async adminCloseSeason(expectedOpenWeek: number): Promise<void> {
    if (expectedOpenWeek !== OPEN_WEEK) throw new Error("week_changed");
    throw new Error("next_week_loaded");
  }
  async adminSetLine(gameId: string, market: Leg["market"], a: { point: number | null; price: number }, b: { point: number | null; price: number }, offered: boolean, reason: string) {
    if (reason.trim().length < 3) throw new Error("reason_required");
    const g = this.game(gameId);
    const [sa, sb] = market === "total" ? ["over", "under"] : ["home", "away"];
    g.lines = g.lines.filter((l) => l.market !== market);
    if (offered) {
      g.lines.push({ market, side: sa as Leg["side"], point: a.point, price: a.price, source: "override", asOf: Date.now() });
      g.lines.push({ market, side: sb as Leg["side"], point: b.point, price: b.price, source: "override", asOf: Date.now() });
    }
    this.audit("line_set", "game", gameId, { market, a, b, offered }, reason);
  }
  async adminClearLine(gameId: string, market: Leg["market"], reason: string) {
    this.audit("line_cleared", "game", gameId, { market }, reason);
  }
  async adminSetGameStatus(gameId: string, status: "scheduled" | "postponed" | "void", kickoffAt: string | null, reason: string) {
    if (reason.trim().length < 3) throw new Error("reason_required");
    const g = this.game(gameId);
    const now = Date.now();
    const to = kickoffAt ? Date.parse(kickoffAt) : g.kickoffAt;
    // The same rules as the real site: no kickoff in the past, no moving one that has
    // passed, and no reopening a game that has started.
    if (g.status === "void") throw new Error("game_void");
    if (g.status === "final" && status !== "void") throw new Error("game_final");
    if (to !== g.kickoffAt && g.kickoffAt <= now) throw new Error("kickoff_passed");
    if (to !== g.kickoffAt && to <= now) throw new Error("kickoff_in_past");
    if (to < g.kickoffAt) throw new Error("kickoff_earlier");
    if (status === "scheduled" && (!["scheduled", "postponed"].includes(g.status) || g.kickoffAt <= now)) throw new Error("game_started");
    const before = { status: g.status, kickoffAt: new Date(g.kickoffAt).toISOString() };
    const regraded = status === "void" && g.status === "final" ? this.reopen(gameId, reason) : 0;
    g.status = status;
    g.kickoffAt = to;
    this.s.audit.unshift({ id: this.nextId++, actorName: "You", action: "game_status_set", targetType: "game", targetId: gameId, before,
      after: { status, kickoffAt: new Date(to).toISOString(), betsRegraded: regraded }, reason, createdAt: new Date().toISOString() });
    this.grade();
  }
  async adminSetFinalScore(gameId: string, home: number, away: number, reason: string) {
    if (reason.trim().length < 3) throw new Error("reason_required");
    const g = this.game(gameId);
    if (g.kickoffAt > Date.now()) throw new Error("game_not_started");
    const same = g.status === "final" && g.homeScore === home && g.awayScore === away;
    const before = { status: g.status, home: g.homeScore, away: g.awayScore };
    const corrected = g.status === "final" || g.status === "void";
    const regraded = corrected ? this.reopen(gameId, reason) : 0;
    Object.assign(g, { status: "final", homeScore: home, awayScore: away });
    this.s.audit.unshift({ id: this.nextId++, actorName: "You", action: same ? "bets_regraded" : corrected ? "score_corrected" : "score_set", targetType: "game", targetId: gameId,
      before, after: { home, away, betsRegraded: regraded }, reason, createdAt: new Date().toISOString() });
    this.grade();
  }
  /** Sends the game's graded bets back to be graded again, taking back what they paid. Admin-voided bets stay void. */
  private reopen(gameId: string, reason: string): number {
    let n = 0;
    for (const s of this.s.slips) {
      if (!s.legs.some((l) => l.gameId === gameId)) continue;
      if (!["won", "lost", "push"].includes(s.status) && !(s.status === "void" && !s.voidedByAdmin)) continue;
      if (s.payoutCents) this.entry(s.entryId).ledger.push({ amount: -s.payoutCents, kind: "regrade_reversal", at: Date.now(), note: reason });
      Object.assign(s, { status: "pending", payoutCents: null, settledAt: null });
      for (const l of s.legs) l.result = "pending";
      n++;
    }
    return n;
  }
  private grade() {
    const rules: RuleSet = this.s.rules[0]!.document;
    const pending: PendingSlip[] = this.s.slips.filter((s) => s.status === "pending").map((s) => ({
      id: s.id, type: s.type, stakeCents: s.stakeCents, teaserPoints: s.teaserPoints, rules, legs: s.legs,
    }));
    const games = new Map<string, GameResult>(this.s.games.map((g) => [g.id, { id: g.id, status: g.status, homeScore: g.homeScore, awayScore: g.awayScore }]));
    for (const st of gradePending(pending, games)) {
      const s = this.s.slips.find((x) => x.id === st.slipId)!;
      s.status = st.result;
      s.payoutCents = st.payoutCents;
      s.settledAt = Date.now();
      for (const r of st.legResults) s.legs.find((l) => l.legNo === r.legNo)!.result = r.result;
      if (st.payoutCents > 0) this.entry(s.entryId).ledger.push({ amount: st.payoutCents, kind: st.result === "won" ? "payout" : "refund", at: Date.now(), note: "" });
    }
  }
  async adminVoidSlip(slipId: string, reason: string) {
    const s = this.s.slips.find((x) => x.id === slipId)!;
    const e = this.entry(s.entryId);
    if (s.status !== "pending" && s.payoutCents) e.ledger.push({ amount: -s.payoutCents, kind: "void_reversal", at: Date.now(), note: reason });
    e.ledger.push({ amount: s.stakeCents, kind: "void_refund", at: Date.now(), note: reason });
    Object.assign(s, { status: "void", payoutCents: s.stakeCents, settledAt: Date.now(), voidedByAdmin: true });
    this.audit("bet_voided", "slip", slipId, { status: "void" }, reason);
  }
  async adminRunJob(job: "pull-lines" | "pull-scores") {
    await wait(400);
    if (job === "pull-lines") {
      this.s.lastPullAt = Date.now();
      this.s.credits -= 3;
      return "Pulled lines for 8 games (3 credits).";
    }
    this.grade();
    return "No games waiting on scores. Graded everything that could be graded.";
  }
  async adminPublishRules(document: RuleSet, effectiveWeek: number, note: string) {
    if (effectiveWeek <= OPEN_WEEK) throw new Error("effective_week_must_be_future");
    const version = Math.max(...this.s.rules.map((r) => r.version)) + 1;
    this.s.rules.push({ version, effectiveWeek, document, note, createdAt: new Date().toISOString() });
    this.audit("rules_published", "rule_set", String(version), { version, effectiveWeek }, note);
    return version;
  }
}
