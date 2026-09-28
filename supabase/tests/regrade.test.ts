// Grades that race a score correction, and the weekly minimum of a week that has
// already closed when one of its bets changes. From the second review pass.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { centerOnWeek4, event, fails, freshDb, gameId, hoursFromNow, ingest, makeUser, member, place, service, standardLines, type Db } from "./db.ts";

let db: Db;
let owner: string, carol: string, dave: string;
let carolEntry: string, daveEntry: string;
let gRace: string, gVoid: string;

const available = async (entry: string) => Number((await db.su("select app.available_cents($1) as a", [entry]))[0].a);
const version = async (game: string) => (await db.su("select updated_at::text as v from public.games where id = $1", [game]))[0].v as string;
const settle = (id: string, result: string, payout: number, versions: { gameId: string; version: string }[] | null) =>
  db.q(service, "select public.settle_slip_internal($1, $2, $3, '[]'::jsonb, $4::jsonb) as ok", [id, result, payout, versions && JSON.stringify(versions)])
    .then((r) => r[0].ok as boolean);
const weekStatus = async (entry: string) =>
  (await db.su("select wagered_cents::int as wagered, shortfall_cents::int as short, deducted_cents::int as deducted from public.week_entry_status where week = 4 and entry_id = $1", [entry]))[0];

beforeAll(async () => {
  db = await freshDb("bl_regrade");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  carol = await makeUser(db, "carol@example.com", "Carol");
  dave = await makeUser(db, "dave@example.com", "Dave");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  carolEntry = (await db.q(member(owner), "select public.admin_add_entry('Carol', 1000000) as id"))[0].id;
  daveEntry = (await db.q(member(owner), "select public.admin_add_entry('Dave', 1000000) as id"))[0].id;
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [carolEntry, carol]);
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [daveEntry, dave]);
  await ingest(db, [
    event("RACE", hoursFromNow(2), "Kansas City Chiefs", "Buffalo Bills", [{ book: "draftkings", outcomes: standardLines(-3) }]),
    event("VOID", hoursFromNow(2), "Baltimore Ravens", "Pittsburgh Steelers", [{ book: "draftkings", outcomes: standardLines(-3) }]),
    event("NEXT", hoursFromNow(24 * 6), "Dallas Cowboys", "New York Giants", [{ book: "draftkings", outcomes: standardLines(-3) }]),
  ]);
  gRace = await gameId(db, "RACE");
  gVoid = await gameId(db, "VOID");
  await db.q(member(owner), "select public.admin_open_next_week(null, 'Start')");
});
afterAll(async () => db?.close());

describe("a grade that races a score correction", () => {
  it("is refused if the game changed after the grader read it, and the next run grades it right", async () => {
    // Dave: 100 units on KC -3; the game goes final 27-20 (a win).
    const id = await place(db, { entry: daveEntry, user: dave, type: "straight", stakeCents: 10_000, potentialPayoutCents: 19_091, legs: [{ gameId: gRace, market: "spread", side: "home", point: -3, price: -110 }] });
    await db.su("update public.games set kickoff_at = now() - interval '3 hours' where id = $1", [gRace]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 27, 20, 'Feed down')", [gRace]);
    const read = await version(gRace); // the grader reads the game here and grades a win...
    // ...and before it settles, an admin corrects the score to 20-27 (nothing is graded yet).
    await db.q(member(owner), "select public.admin_set_final_score($1, 20, 27, 'Teams were reversed')", [gRace]);
    expect(await settle(id, "won", 19_091, [{ gameId: gRace, version: read }])).toBe(false);
    expect((await db.su("select status from public.slips where id = $1", [id]))[0].status).toBe("pending");
    // The next run reads the corrected game and grades the loss.
    expect(await settle(id, "lost", 0, [{ gameId: gRace, version: await version(gRace) }])).toBe(true);
    expect((await db.su("select status from public.slips where id = $1", [id]))[0].status).toBe("lost");
  });
});

describe("the minimum of a week that has closed", () => {
  let bet: string;
  it("counts a bet on a game that was called off, and a regrade leaves it counting", async () => {
    // Carol has 10,000 units, so she must wager 3,000, and she bets exactly that on a game that's then called off.
    bet = await place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 300_000, potentialPayoutCents: 572_727, legs: [{ gameId: gVoid, market: "spread", side: "home", point: -3, price: -110 }] });
    await db.su("update public.games set kickoff_at = now() - interval '3 hours' where id = $1", [gVoid]);
    await db.q(member(owner), "select public.admin_set_game_status($1, 'void', null, 'Called off')", [gVoid]);
    expect(await settle(bet, "void", 300_000, [{ gameId: gVoid, version: await version(gVoid) }])).toBe(true);
    // Every game of week 4 is final or void, so the week closes. The voided bet counts, so
    // she met her minimum and gets her stake back.
    expect((await db.q(service, "select public.advance_week_internal() as w"))[0].w).toBe(5);
    expect(await weekStatus(carolEntry)).toEqual({ wagered: 300_000, short: 0, deducted: 0 });
    expect(await available(carolEntry)).toBe(1_000_000);

    // The game was played after all: the real score regrades the bet, which still counts.
    await db.q(member(owner), "select public.admin_set_final_score($1, 27, 20, 'It was played')", [gVoid]);
    expect(await weekStatus(carolEntry)).toEqual({ wagered: 300_000, short: 0, deducted: 0 });
    expect(await settle(bet, "won", 572_727, [{ gameId: gVoid, version: await version(gVoid) }])).toBe(true);
    // 10,000 - 3,000 staked + 5,727.27 back = 12,727.27, and no minimum was ever taken.
    expect(await available(carolEntry)).toBe(1_272_727);
    expect((await db.su("select count(*)::int as n from public.ledger where entry_id = $1 and kind = 'weekly_minimum'", [carolEntry]))[0].n).toBe(0);
  });

  it("is redone when an admin voids a bet that counted", async () => {
    await db.q(member(owner), "select public.admin_void_slip($1, 'Placed in error')", [bet]);
    expect(await weekStatus(carolEntry)).toEqual({ wagered: 0, short: 300_000, deducted: 300_000 });
    // The stake comes back, the winnings go back, and the shortfall is charged: 10,000 - 3,000.
    expect(await available(carolEntry)).toBe(700_000);
    const [redo] = await db.q(member(dave), "select amount_cents::int as a, note from public.ledger where entry_id = $1 and kind = 'weekly_minimum' order by id desc limit 1", [carolEntry]);
    expect(redo).toEqual({ a: -300_000, note: "Week 4 minimum redone after a bet changed: wagered 0.00 of 3000.00 units" });
  });
});

describe("problems for the admins", () => {
  it("admins see recent failed pulls with their error text; members can't", async () => {
    await db.q(service, "select public.record_pull_internal('scores', 'schedule', false, 'grading: s1: Error: settle: bad_payout', null, null)");
    const rows = await db.q(member(owner), "select kind, error from public.admin_recent_problems(5)");
    expect(rows[0]).toEqual({ kind: "scores", error: "grading: s1: Error: settle: bad_payout" });
    await fails(db.q(member(dave), "select * from public.admin_recent_problems(5)"), "admin_only");
  });
});
