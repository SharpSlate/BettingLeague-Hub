// What the verification of the fourth-round fixes found, each reproduced against its fix:
// one bad reading of a start already past closed a game for good, and a closed week's
// minimum redone by an admin void could take units a bet was spending at that moment.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  centerOnWeek4,
  event,
  fails,
  freshDb,
  gameId,
  hoursFromNow,
  ingest,
  makeUser,
  member,
  place,
  service,
  standardLines,
  type Db,
  type Event,
} from "./db.ts";

let db: Db;
let owner: string, alice: string, fay: string;
let aliceEntry: string, fayEntry: string;
const board: Event[] = [];
const ids: Record<string, string> = {};

const GAMES: [id: string, hours: number, home: string, away: string][] = [
  ["ONCE", 5, "Kansas City Chiefs", "Buffalo Bills"],
  ["TWICE", 5, "Baltimore Ravens", "Pittsburgh Steelers"],
  ["LONG", 5, "Dallas Cowboys", "New York Giants"],
  ["FAYWIN", 2, "Seattle Seahawks", "Arizona Cardinals"],
  ["NEXT", 24 * 6, "Chicago Bears", "Minnesota Vikings"],
];
const commence = (id: string, at: Date) => {
  board.find((e) => e.id === id)!.commenceTime = at.toISOString();
};
const pull = () => ingest(db, board);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const leg = (id: string) => ({ gameId: ids[id]!, market: "spread", side: "home", point: -3, price: -110 });
const bet = (entry: string, user: string, id: string, stakeCents = 10_000) =>
  place(db, { entry, user, type: "straight", stakeCents, potentialPayoutCents: Math.floor((stakeCents * 21) / 11), legs: [leg(id)] });
const available = async (entry: string) => Number((await db.su("select app.available_cents($1) as a", [entry]))[0].a);
const awaitingScores = async () => (await db.q(service, "select public.games_awaiting_scores_internal(now()) as n"))[0].n as number;

beforeAll(async () => {
  db = await freshDb("bl_review5");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  alice = await makeUser(db, "alice@example.com", "Alice");
  fay = await makeUser(db, "fay@example.com", "Fay");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  const entry = async (name: string, user: string) => {
    const id = (await db.q(member(owner), "select public.admin_add_entry($1, 1000000) as id", [name]))[0].id as string;
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [id, user]);
    return id;
  };
  aliceEntry = await entry("Alice", alice);
  fayEntry = await entry("Fay", fay);
  for (const [id, hours, home, away] of GAMES) {
    board.push(event(id, hoursFromNow(hours), home, away, [{ book: "draftkings", outcomes: standardLines(-3) }]));
  }
  await pull();
  for (const [id] of GAMES) ids[id] = await gameId(db, id);
  await db.q(member(owner), "select public.admin_open_next_week(null, 'Start')");
});
afterAll(async () => db?.close());

describe("a start the feed first reports after it has passed", () => {
  it("closes betting only until a later reading disagrees", async () => {
    const right = board.find((e) => e.id === "ONCE")!.commenceTime;
    commence("ONCE", new Date(Date.now() - 10 * 60_000));
    await pull();
    await fails(bet(aliceEntry, alice, "ONCE"), "game_started");
    expect(await awaitingScores()).toBe(1);
    board.find((e) => e.id === "ONCE")!.commenceTime = right;
    await pull();
    await bet(aliceEntry, alice, "ONCE");
    expect(await awaitingScores()).toBe(0);
  });

  it("but sticks once a second reading agrees", async () => {
    const right = board.find((e) => e.id === "TWICE")!.commenceTime;
    commence("TWICE", new Date(Date.now() - 10 * 60_000));
    await pull();
    await pull();
    board.find((e) => e.id === "TWICE")!.commenceTime = right;
    await pull();
    await fails(bet(aliceEntry, alice, "TWICE"), "game_started");
  });

  it("while a start reported before it came sticks as soon as it passes", async () => {
    const start = new Date(Date.now() + 1000);
    commence("LONG", start);
    await pull();
    await sleep(Math.max(0, start.getTime() - Date.now()) + 300);
    commence("LONG", hoursFromNow(5));
    await pull();
    await fails(bet(aliceEntry, alice, "LONG"), "game_started");
  });

  it("stays on the admins' problem list however long ago it should have started", async () => {
    await db.su("update public.games set kickoff_at = now() - interval '5 days' where id = $1", [ids.LONG]);
    const rows = await db.q(member(owner), "select error from public.admin_recent_problems(20)");
    expect(rows.some((r) => r.error.startsWith("Giants at Cowboys should have started by now"))).toBe(true);
  });
});

describe("a closed week's minimum redone by an admin void", () => {
  let win: string;
  it("sets up: Fay wagers exactly her minimum in week 4, wins, and the week closes", async () => {
    win = await bet(fayEntry, fay, "FAYWIN", 300_000);
    await db.su("update public.games set kickoff_at = now() - interval '3 hours' where id = $1", [ids.FAYWIN]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 27, 20, 'Feed down')", [ids.FAYWIN]);
    await db.q(service, "select public.settle_slip_internal($1, 'won', 572727, '[]')", [win]);
    expect((await db.q(member(owner), "select public.admin_open_next_week(4, 'Closing early') as w"))[0].w).toBe(5);
    expect(await available(fayEntry)).toBe(1_272_727);
  });

  it("waits for a bet being placed, so it charges only units still free", async () => {
    // Fay stakes all but 9.27 units in week 5 while an admin voids her week-4 win. The
    // void takes back the winnings and refunds the stake, and the bet no longer counts,
    // so she's 3,000 short for week 4 with nothing free: nothing more is taken.
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role service_role");
      await place(db, { entry: fayEntry, user: fay, type: "straight", stakeCents: 1_271_800, potentialPayoutCents: 2_428_345, legs: [leg("NEXT")] }, c);
      const voiding = db.q(member(owner), "select public.admin_void_slip($1, 'Placed in error')", [win]);
      await sleep(300);
      await c.query("commit");
      await voiding;
    } finally {
      c.release();
    }
    expect(await available(fayEntry)).toBe(927 - 572_727 + 300_000);
    const [w] = await db.su("select shortfall_cents::int as short, deducted_cents::int as deducted, unpaid_cents::int as unpaid from public.week_entry_status where week = 4 and entry_id = $1", [fayEntry]);
    expect(w).toEqual({ short: 300_000, deducted: 0, unpaid: 300_000 });
  });
});
