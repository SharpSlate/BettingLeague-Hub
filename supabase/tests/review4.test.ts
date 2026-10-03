// What the review of the third-round fixes found, each reproduced against its fix:
// betting that stayed open on a game the feed showed under way, a closed week's minimum
// that came out differently depending on the order corrections arrived in, a stuck game
// nobody was told about, rules values the database reads unchecked, and resent bets
// with upper-case ids. The minimum tests follow the owner's rule (Sept 28) that bets on
// a game that's called off count toward it, like pushes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY_ONE_RULES } from "../functions/_shared/rules/defaults.ts";
import {
  centerOnWeek4,
  event,
  fails,
  freshDb,
  gameId,
  hoursFromNow,
  ingest,
  makeLeague,
  makeUser,
  member,
  place,
  service,
  standardLines,
  undo,
  type Db,
  type Event,
} from "./db.ts";

let db: Db;
let owner: string, alice: string, bob: string, dan: string, mia: string;
let aliceEntry: string, bobEntry: string, danEntry: string, miaEntry: string;
const board: Event[] = [];
const ids: Record<string, string> = {};

const GAMES: [id: string, hours: number, home: string, away: string][] = [
  ["FEED1", 3, "Kansas City Chiefs", "Buffalo Bills"],
  ["STUCK", 3, "Baltimore Ravens", "Pittsburgh Steelers"],
  ["REF", 4, "Philadelphia Eagles", "Washington Commanders"],
  ["GX", 2, "Seattle Seahawks", "Arizona Cardinals"],
  ["GY", 2, "Denver Broncos", "Las Vegas Raiders"],
  ["GV", 2, "Dallas Cowboys", "New York Giants"],
  ["GW", 2, "Detroit Lions", "Green Bay Packers"],
  ["NEXT", 24 * 6, "Chicago Bears", "Minnesota Vikings"],
];
const commence = (id: string, at: Date) => {
  board.find((e) => e.id === id)!.commenceTime = at.toISOString();
};
const pull = () => ingest(db, board);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const game = async (id: string) =>
  (await db.su("select status, kickoff_at, feed_commence, kickoff_at <= now() as started from public.games where id = $1", [ids[id]]))[0];
const scores = (rows: unknown[]) => db.q(service, "select public.ingest_scores_internal('schedule', $1::jsonb, 2, 90000)", [JSON.stringify(rows)]);
const leg = (id: string) => ({ gameId: ids[id]!, market: "spread", side: "home", point: -3, price: -110 });
const bet = (entry: string, user: string, id: string, stakeCents = 10_000, clientRef?: string) =>
  place(db, { entry, user, type: "straight", stakeCents, potentialPayoutCents: Math.floor((stakeCents * 21) / 11), legs: [leg(id)], clientRef });
const settle = (id: string, result: string, payout: number) =>
  db.q(service, "select public.settle_slip_internal($1, $2, $3, '[]') as ok", [id, result, payout]);
const available = async (entry: string) => Number((await db.su("select app.available_cents($1) as a", [entry]))[0].a);
const minimumRows = async (entry: string) =>
  Number((await db.su("select coalesce(sum(amount_cents), 0) as s from public.ledger where entry_id = $1 and kind = 'weekly_minimum' and week = 4", [entry]))[0].s);
const awaitingScores = async () => (await db.q(service, "select public.games_awaiting_scores_internal(now()) as n"))[0].n as number;

beforeAll(async () => {
  db = await freshDb("bl_review4");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  alice = await makeUser(db, "alice@example.com", "Alice");
  bob = await makeUser(db, "bob@example.com", "Bob");
  dan = await makeUser(db, "dan@example.com", "Dan");
  mia = await makeUser(db, "mia@example.com", "Mia");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  await makeLeague(db, owner);
  const entry = async (name: string, user: string) => {
    const id = (await db.q(member(owner), "select public.admin_add_entry($1, 1000000) as id", [name]))[0].id as string;
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [id, user]);
    return id;
  };
  aliceEntry = await entry("Alice", alice);
  bobEntry = await entry("Bob", bob);
  danEntry = await entry("Dan", dan);
  miaEntry = await entry("Mia", mia);
  for (const [id, hours, home, away] of GAMES) {
    board.push(event(id, hoursFromNow(hours), home, away, [{ book: "draftkings", outcomes: standardLines(-3) }]));
  }
  await pull();
  for (const [id] of GAMES) ids[id] = await gameId(db, id);
  await db.q(member(owner), "select public.admin_open_next_week(null, 'Start')");
});
afterAll(async () => db?.close());

describe("betting closes when the feed's start time passes", () => {
  let aliceBet: string;
  it("even while the kickoff here is hours away and the new time hasn't stuck yet", async () => {
    aliceBet = await bet(aliceEntry, alice, "FEED1");
    expect(await awaitingScores()).toBe(0);
    // The feed moves the game to a moment from now; one reading doesn't move the kickoff.
    const start = new Date(Date.now() + 1500);
    commence("FEED1", start);
    await pull();
    const g = await game("FEED1");
    expect(g.started).toBe(false);
    expect((g.feed_commence as Date).getTime()).toBe(start.getTime());
    await sleep(Math.max(0, start.getTime() - Date.now()) + 300);
    await fails(bet(bobEntry, bob, "FEED1"), "game_started");
    // Undoing a bet counts the same start.
    await fails(undo(db, aliceBet, alice), "game_started");
    // Score pulls start for it, though no game has kicked off here.
    expect(await awaitingScores()).toBe(1);
  });

  it("and a later reading can't reopen it", async () => {
    commence("FEED1", hoursFromNow(5));
    await pull();
    await fails(bet(bobEntry, bob, "FEED1"), "game_started");
  });

  it("its first score starts it here too, which shows its picks", async () => {
    expect((await db.q(member(bob), "select count(*)::int as n from public.slip_legs where slip_id = $1", [aliceBet]))[0].n).toBe(0);
    await scores([{ id: "FEED1", completed: false, homeScore: 0, awayScore: 0 }]);
    expect(await game("FEED1")).toMatchObject({ status: "live", started: true });
    expect((await db.q(member(bob), "select count(*)::int as n from public.slip_legs where slip_id = $1", [aliceBet]))[0].n).toBe(1);
  });
});

describe("the admins' problem list", () => {
  it("flags a game that should have started an hour ago but has no score", async () => {
    await db.su("update public.games set kickoff_at = now() - interval '2 hours' where id = $1", [ids.STUCK]);
    const rows = await db.q(member(owner), "select kind, error from public.admin_recent_problems(20)");
    expect(rows).toContainEqual({
      kind: "game",
      error: "Steelers at Ravens should have started by now but has no score yet, so betting on it is closed. If it was postponed, mark it postponed; otherwise the score feed may be behind.",
    });
  });
});

describe("rules the database reads", () => {
  const refused = async (doc: unknown) =>
    fails(db.q(service, "select public.publish_rule_set_internal($1, (select id from public.leagues), $2::jsonb, 6, 'typo')", [owner, JSON.stringify(doc)]), "bad_rules");
  it("are refused with a leg limit, market list, teaser points or flat price missing", async () => {
    const bt = DAY_ONE_RULES.betTypes;
    await refused({ ...DAY_ONE_RULES, betTypes: { ...bt, parlay: { ...bt.parlay, minLegs: null } } });
    await refused({ ...DAY_ONE_RULES, betTypes: { ...bt, teaser: { ...bt.teaser, maxLegs: "10" } } });
    await refused({ ...DAY_ONE_RULES, betTypes: { ...bt, straight: { ...bt.straight, markets: null } } });
    await refused({ ...DAY_ONE_RULES, betTypes: { ...bt, teaser: { ...bt.teaser, points: null } } });
    await refused({ ...DAY_ONE_RULES, betTypes: { ...bt, teaser: { ...bt.teaser, points: [6, "7"] } } });
    await refused({ ...DAY_ONE_RULES, pricing: { ...DAY_ONE_RULES.pricing, flatPrice: null } });
  });
});

describe("resending a bet", () => {
  it("with its game id in capitals is still the same bet", async () => {
    const ref = "0a4f5c2e-0000-4000-8000-00000000000b";
    const id = await bet(aliceEntry, alice, "REF", 10_000, ref);
    const again = await place(db, {
      entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, potentialPayoutCents: 19_090,
      legs: [{ ...leg("REF"), gameId: ids.REF!.toUpperCase() }], clientRef: ref,
    });
    expect(again).toBe(id);
  });
});

describe("the minimum of a week that has closed", () => {
  const status = async (entry: string) =>
    (await db.su(
      "select wagered_cents::int as wagered, shortfall_cents::int as short, deducted_cents::int as deducted, waived_cents::int as waived, unpaid_cents::int as unpaid from public.week_entry_status where week = 4 and entry_id = $1",
      [entry],
    ))[0];
  let x: string, x2: string;

  it("counts a bet on a game called off before the close", async () => {
    // Dan: 1,000 on GX (wins, paying 1,909.09) and 500 on GY (loses).
    x = await bet(danEntry, dan, "GX", 100_000);
    const y = await bet(danEntry, dan, "GY", 50_000);
    // Mia: 1,000 on GV (called off before the week closes) and 1,500 on GW (loses), then an
    // adjustment leaves her 100 units free at the close.
    x2 = await bet(miaEntry, mia, "GV", 100_000);
    const y2 = await bet(miaEntry, mia, "GW", 150_000);
    await db.su("update public.games set kickoff_at = now() - interval '3 hours' where id = any($1::uuid[])", [[ids.GX, ids.GY, ids.GV, ids.GW]]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 27, 20, 'Feed down')", [ids.GX]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 20, 27, 'Feed down')", [ids.GY]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 20, 27, 'Feed down')", [ids.GW]);
    await db.q(member(owner), "select public.admin_set_game_status($1, 'void', null, 'Called off')", [ids.GV]);
    await settle(x, "won", 190_909);
    await settle(y, "lost", 0);
    await settle(x2, "void", 100_000);
    await settle(y2, "lost", 0);
    await db.q(member(owner), "select public.admin_adjust_bank($1, -840000, 'Side bet')", [miaEntry]);
    // Her progress toward the minimum counts it during the week too.
    expect((await db.q(member(mia), "select wagered_cents::int as w from public.my_entries()"))[0].w).toBe(250_000);
    expect((await db.q(member(mia), "select wagered_cents::int as w from public.standings() where entry_id = $1", [miaEntry]))[0].w).toBe(250_000);
    expect((await db.q(member(owner), "select public.admin_open_next_week(4, 'Closing early') as w"))[0].w).toBe(5);

    // Dan wagered 1,500 of 3,000 and had plenty: 1,500 taken.
    expect(await status(danEntry)).toEqual({ wagered: 150_000, short: 150_000, deducted: 150_000, waived: 0, unpaid: 0 });
    // Mia's bet on the called-off game counts: 2,500 of 3,000, so 500 short, with 100 free: 100 taken, 400 waived.
    expect(await status(miaEntry)).toEqual({ wagered: 250_000, short: 50_000, deducted: 10_000, waived: 40_000, unpaid: 0 });
  });

  it("a game called off after the close, then played, leaves the minimum and the bank as they were", async () => {
    // Dan bets most of what's left in week 5, leaving 209.09 free.
    await bet(danEntry, dan, "NEXT", 870_000);
    expect(await available(danEntry)).toBe(20_909);
    // GX is called off: the win is taken back and the stake refunded, and the bet still counts.
    await db.q(member(owner), "select public.admin_set_game_status($1, 'void', null, 'Wrong game')", [ids.GX]);
    await settle(x, "void", 100_000);
    expect(await status(danEntry)).toMatchObject({ wagered: 150_000, short: 150_000, deducted: 150_000, unpaid: 0 });
    // The score is put back, and the bet wins again.
    await db.q(member(owner), "select public.admin_set_final_score($1, 27, 20, 'It was played')", [ids.GX]);
    await settle(x, "won", 190_909);
    expect(await available(danEntry)).toBe(20_909);
    expect(await minimumRows(danEntry)).toBe(-150_000);
  });

  it("an admin void adds the bet's stake to the shortfall, taken only from units free now", async () => {
    // An admin voids Dan's win: it's taken back and the stake refunded, and the bet stops
    // counting, so he's 1,000 more short. He has nothing free, so it's left unpaid.
    await db.q(member(owner), "select public.admin_void_slip($1, 'Placed in error')", [x]);
    expect(await status(danEntry)).toMatchObject({ wagered: 50_000, short: 250_000, deducted: 150_000, unpaid: 100_000 });
    expect(await available(danEntry)).toBe(20_909 - 190_909 + 100_000);
    expect(await minimumRows(danEntry)).toBe(-150_000);
  });

  it("and the part waived at the close stays waived", async () => {
    // GV was played after all: Mia's bet is graded (a loss) and still counts.
    await db.q(member(owner), "select public.admin_set_final_score($1, 20, 27, 'It was played')", [ids.GV]);
    expect(await status(miaEntry)).toMatchObject({ short: 50_000, deducted: 10_000, waived: 40_000 });
    await settle(x2, "lost", 0);
    // With units again, an admin voids that bet: she's 1,500 short, less the 400 waived at
    // the close, so 1,100 is owed and 1,000 more is taken.
    await db.q(member(owner), "select public.admin_adjust_bank($1, 500000, 'Bonus')", [miaEntry]);
    await db.q(member(owner), "select public.admin_void_slip($1, 'Placed in error')", [x2]);
    expect(await status(miaEntry)).toMatchObject({ short: 150_000, deducted: 110_000, waived: 40_000, unpaid: 0 });
    expect(await minimumRows(miaEntry)).toBe(-110_000);
  });
});
