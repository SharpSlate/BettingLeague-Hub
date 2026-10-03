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
} from "./db.ts";

let db: Db;
let owner: string, alice: string, bob: string;
let aliceEntry: string, bobEntry: string;
let gA: string, gB: string;

const available = async (entry: string) => Number((await db.su("select app.available_cents($1) as a", [entry]))[0].a);
const settle = (id: string, result: string, payout: number) =>
  db.q(service, "select public.settle_slip_internal($1, $2, $3, '[]')", [id, result, payout]);
const scores = (rows: { id: string; completed: boolean; homeScore: number; awayScore: number }[]) =>
  db.q(service, "select public.ingest_scores_internal('schedule', $1::jsonb, 2, 90000)", [JSON.stringify(rows)]);

beforeAll(async () => {
  db = await freshDb("bl_weeks");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  await makeLeague(db, owner);
  aliceEntry = (await db.q(member(owner), "select public.admin_add_entry('Alice', 1000000) as id"))[0].id;
  bobEntry = (await db.q(member(owner), "select public.admin_add_entry('Bob', 1000000) as id"))[0].id;
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [aliceEntry, alice]);
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [bobEntry, bob]);
  await ingest(db, [
    event("A", hoursFromNow(2), "Kansas City Chiefs", "Buffalo Bills", [{ book: "draftkings", outcomes: standardLines(-3) }]),
    event("B", hoursFromNow(3), "Baltimore Ravens", "Pittsburgh Steelers", [{ book: "draftkings", outcomes: standardLines(-6.5, 41) }]),
  ]);
  gA = await gameId(db, "A");
  gB = await gameId(db, "B");
});
afterAll(async () => db?.close());

describe("starting the season", () => {
  it("the scheduled job never opens the first week by itself", async () => {
    const [r] = await db.q(service, "select public.advance_week_internal() as w");
    expect(r.w).toBeNull();
    expect((await db.su("select count(*)::int as n from public.league_weeks where status = 'open'"))[0].n).toBe(0);
  });

  it("an admin opens it", async () => {
    const [r] = await db.q(member(owner), "select public.admin_open_next_week(null, 'Trial') as w");
    expect(r.w).toBe(4);
  });
});

describe("rule changes", () => {
  const doc = { ...DAY_ONE_RULES, undoMinutes: 3 };
  it("can't take effect in the open week", async () => {
    await fails(db.q(service, "select public.publish_rule_set_internal($1, (select id from public.leagues), $2::jsonb, 4, 'too soon')", [owner, JSON.stringify(doc)]), "effective_week_must_be_future");
    await fails(db.su("insert into public.rule_sets (version, league_id, effective_week, document) select 9, id, 4, '{}' from public.leagues"), "future week");
  });
  it("only an admin can publish", async () => {
    await fails(db.q(service, "select public.publish_rule_set_internal($1, (select id from public.leagues), $2::jsonb, 5, 'x')", [alice, JSON.stringify(doc)]), "commissioner_only");
  });
  it("publishes a new version from week 6; week 5 keeps the league's first", async () => {
    const [r] = await db.q(service, "select public.publish_rule_set_internal($1, (select id from public.leagues), $2::jsonb, 6, 'Shorter undo window') as v", [owner, JSON.stringify(doc)]);
    // Version 1 is the day-one template; the league started on a copy, version 2.
    expect(r.v).toBe(3);
    const [w5] = await db.su("select app.rule_set_for_week(id, 5) as v from public.leagues");
    const [w6] = await db.su("select app.rule_set_for_week(id, 6) as v from public.leagues");
    expect([w5.v, w6.v]).toEqual([2, 3]);
    await fails(db.su("update public.league_weeks set rule_set_version = 3 where week = 4"), "fixed once it opens");
  });
});

describe("closing a week", () => {
  let aliceSlips: string[] = [];
  let bobSlip: string;
  beforeAll(async () => {
    // Alice: 1,000 + 1,000 wagered (one will push), plus 500 she undoes. Bob: 5,000.
    const leg = (g: string) => ({ gameId: g, market: "spread", side: "home", point: g === gA ? -3 : -6.5, price: -110 });
    aliceSlips.push(await place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 100_000, potentialPayoutCents: 190_910, legs: [leg(gA)] }));
    aliceSlips.push(await place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 100_000, potentialPayoutCents: 190_910, legs: [leg(gB)] }));
    const undone = await place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 50_000, legs: [leg(gB)] });
    await undo(db, undone, alice);
    bobSlip = await place(db, { entry: bobEntry, user: bob, type: "straight", stakeCents: 500_000, potentialPayoutCents: 954_546, legs: [leg(gA)] });
  });

  it("doesn't advance while a game isn't final", async () => {
    await ingest(db, [event("N", hoursFromNow(24 * 6), "Detroit Lions", "Green Bay Packers", [{ book: "draftkings", outcomes: standardLines() }])]);
    const [r] = await db.q(service, "select public.advance_week_internal() as w");
    expect(r.w).toBeNull();
  });

  it("takes in final scores; a later disagreement is flagged, not applied", async () => {
    await db.su("update public.games set kickoff_at = now() - interval '4 hours' where id in ($1, $2)", [gA, gB]);
    await scores([{ id: "A", completed: false, homeScore: 7, awayScore: 3 }]);
    expect((await db.su("select status from public.games where id = $1", [gA]))[0].status).toBe("live");
    const finals = [
      { id: "A", completed: true, homeScore: 27, awayScore: 24 },
      { id: "B", completed: true, homeScore: 20, awayScore: 17 },
    ];
    await scores(finals);
    // One reading isn't enough: a game goes final when the next pull reports the same score.
    expect((await db.su("select status, home_score from public.games where id = $1", [gA]))[0]).toEqual({ status: "live", home_score: 27 });
    await scores(finals);
    expect((await db.su("select status, home_score from public.games where id = $1", [gA]))[0]).toEqual({ status: "final", home_score: 27 });
    await scores([{ id: "A", completed: true, homeScore: 28, awayScore: 24 }]);
    await scores([{ id: "A", completed: true, homeScore: 28, awayScore: 24 }]);
    expect((await db.su("select home_score from public.games where id = $1", [gA]))[0].home_score).toBe(27);
    expect((await db.su("select count(*)::int as n from public.audit_log where action = 'score_mismatch'"))[0].n).toBe(1);
  });

  it("doesn't advance while a bet is ungraded", async () => {
    const [r] = await db.q(service, "select public.advance_week_internal() as w");
    expect(r.w).toBeNull();
  });

  it("closes the week, deducts shortfalls, and opens the next week with new minimums", async () => {
    // KC -3 won 27-24 by exactly 3: push. BAL -6.5 won by 3: lost. Bob's KC -3: push.
    await settle(aliceSlips[0]!, "push", 100_000);
    await settle(aliceSlips[1]!, "lost", 0);
    await settle(bobSlip, "push", 500_000);
    const aliceBefore = await available(aliceEntry);
    expect(aliceBefore).toBe(900_000);

    const [r] = await db.q(service, "select public.advance_week_internal() as w");
    expect(r.w).toBe(5);

    // Alice needed 3,000 units; she wagered 2,000 (the push counts, the undo doesn't): 1,000 short.
    const [a] = await db.su("select * from public.week_entry_status where week = 4 and entry_id = $1", [aliceEntry]);
    expect([Number(a.required_cents), Number(a.wagered_cents), Number(a.shortfall_cents), Number(a.deducted_cents)]).toEqual([300_000, 200_000, 100_000, 100_000]);
    expect(await available(aliceEntry)).toBe(800_000);
    const [b] = await db.su("select * from public.week_entry_status where week = 4 and entry_id = $1", [bobEntry]);
    expect(Number(b.deducted_cents)).toBe(0);

    // Week 5 starts from the new banks: 30% of 8,000 = 2,400; 30% of 10,000 = 3,000.
    const w5 = await db.su("select entry_id, bank_at_start_cents::int as bank, required_cents::int as req from public.week_entry_status where week = 5 order by bank");
    expect(w5).toEqual([
      { entry_id: aliceEntry, bank: 800_000, req: 240_000 },
      { entry_id: bobEntry, bank: 1_000_000, req: 300_000 },
    ]);
    const weeks = await db.su("select week, status, rule_set_version from public.league_weeks where week in (4, 5) order by week");
    expect(weeks).toEqual([
      { week: 4, status: "closed", rule_set_version: 2 },
      { week: 5, status: "open", rule_set_version: 2 },
    ]);
  });

  it("members see the deduction in their ledger and in the standings", async () => {
    const [l] = await db.q(member(alice), "select amount_cents::int as a, note from public.ledger where entry_id = $1 and kind = 'weekly_minimum'", [aliceEntry]);
    expect(l).toEqual({ a: -100_000, note: "Week 4 minimum: wagered 2000.00 of 3000.00 units" });
    const [s] = await db.q(member(bob), "select * from public.standings() where entry_id = $1", [aliceEntry]);
    expect(Number(s.bank_cents)).toBe(800_000);
    expect(Number(s.season_net_cents)).toBe(-200_000);
    expect([s.wins, s.losses, s.pushes]).toEqual([0, 1, 1]);
    expect(Number(s.risk_cents)).toBe(200_000);
    expect(Number(s.return_cents)).toBe(100_000);
  });
});

describe("postponed games", () => {
  it("block the automatic advance, and an admin can open the next week anyway", async () => {
    await ingest(db, [event("W6", hoursFromNow(24 * 12), "Miami Dolphins", "New York Jets", [{ book: "draftkings", outcomes: standardLines() }])]);
    const n = await gameId(db, "N");
    await db.su("update public.games set kickoff_at = now() - interval '4 hours' where id = $1", [n]);
    await db.q(member(owner), "select public.admin_set_game_status($1, 'postponed', null, 'Weather: moved to Tuesday')", [n]);
    expect((await db.q(service, "select public.advance_week_internal() as w"))[0].w).toBeNull();
    const [r] = await db.q(member(owner), "select public.admin_open_next_week(5, 'Opening week 6 around the postponed game') as w");
    expect(r.w).toBe(6);
    expect((await db.su("select rule_set_version from public.league_weeks where week = 6"))[0].rule_set_version).toBe(3);
  });
});

describe("Splash import", () => {
  it("sets the bank, keeps season net, and adds the Splash record to the standings", async () => {
    const e = (await db.q(member(owner), "select public.admin_add_entry('Carol') as id"))[0].id;
    await db.q(member(owner), "select public.admin_import_splash($1, 1922730, 422730, 9, 6, 1, 3150000, 3572730, 900000, 'Splash standings after week 3')", [e]);
    expect(await available(e)).toBe(1_922_730);
    const [s] = await db.q(member(alice), "select * from public.standings() where entry_id = $1", [e]);
    expect(Number(s.bank_cents)).toBe(1_922_730);
    expect(Number(s.season_net_cents)).toBe(422_730);
    expect([s.wins, s.losses, s.pushes]).toEqual([9, 6, 1]);
    expect(Number(s.risk_cents)).toBe(3_150_000);
    // The open week's minimum is recomputed from the imported bank: ceil(0.3 x 19,227.30) = 5,769.
    expect(Number(s.required_cents)).toBe(576_900);
  });

  it("refuses an entry that already has bets", async () => {
    await fails(db.q(member(owner), "select public.admin_import_splash($1, 100, 0, 0, 0, 0, 0, 0, 0, 'x')", [aliceEntry]), "entry_has_bets");
  });
});

describe("bank adjustments", () => {
  it("need a reason, can't go below zero, and are logged", async () => {
    await fails(db.q(member(owner), "select public.admin_adjust_bank($1, 5000, '')", [bobEntry]), "reason_required");
    await fails(db.q(member(owner), "select public.admin_adjust_bank($1, -99999999, 'too much')", [bobEntry]), "insufficient_units");
    await db.q(member(owner), "select public.admin_adjust_bank($1, 5000, 'Splash rounding correction')", [bobEntry]);
    const [log] = await db.q(member(alice), "select action, reason, after from public.audit_log where action = 'bank_adjusted'");
    expect(log).toMatchObject({ reason: "Splash rounding correction", after: { amountCents: 5000 } });
  });

  it("the last admin can't be removed", async () => {
    await fails(db.q(member(owner), "select public.admin_set_admin($1, false)", [owner]), "last_admin");
  });
});
