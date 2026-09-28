import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anon,
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
} from "./db.ts";

let db: Db;
let owner: string, commish: string, alice: string, bob: string;
let aliceEntry: string, bobEntry: string, sharedEntry: string;
let gA: string, gB: string, gC: string;

const kcSpreadHome = () => ({ gameId: gA, market: "spread", side: "home", point: -3, price: -110 });

beforeAll(async () => {
  db = await freshDb("bl_betting");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  commish = await makeUser(db, "commish@example.com", "Commish");
  alice = await makeUser(db, "alice@example.com", "Alice");
  bob = await makeUser(db, "bob@example.com", "Bob");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  await db.q(member(owner), "select public.admin_set_admin($1, true)", [commish]);

  aliceEntry = (await db.q(member(owner), "select public.admin_add_entry('Alice', 1000000) as id"))[0].id;
  bobEntry = (await db.q(member(owner), "select public.admin_add_entry('Bob', 1000000) as id"))[0].id;
  sharedEntry = (await db.q(member(owner), "select public.admin_add_entry('Shared', 500000) as id"))[0].id;
  for (const [e, u] of [[aliceEntry, alice], [bobEntry, bob], [sharedEntry, alice], [sharedEntry, bob]] as const) {
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [e, u]);
  }

  const fdOnly = standardLines(-2.5, 44, -140, 120);
  await ingest(db, [
    event("A", hoursFromNow(2), "Kansas City Chiefs", "Buffalo Bills", [
      { book: "draftkings", outcomes: standardLines(-3, 47.5, -150, 130) },
      { book: "fanduel", outcomes: standardLines(-3.5, 48, -160, 135) },
    ]),
    // DraftKings has no total on game B, so the total comes from FanDuel.
    event("B", hoursFromNow(3), "Baltimore Ravens", "Pittsburgh Steelers", [
      { book: "draftkings", outcomes: standardLines(-6.5, 41, -300, 240).filter((o) => o.market !== "total") },
      { book: "fanduel", outcomes: fdOnly },
    ]),
    event("C", hoursFromNow(-1), "Dallas Cowboys", "New York Giants", [
      { book: "draftkings", outcomes: standardLines() },
    ]),
  ]);
  gA = await gameId(db, "A");
  gB = await gameId(db, "B");
  gC = await gameId(db, "C");
  await db.q(member(owner), "select public.admin_open_next_week('Start of the trial')");
});
afterAll(async () => db?.close());

describe("week opening", () => {
  it("opens the week containing today and snapshots each bank and 30% minimum", async () => {
    const weeks = await db.su("select week, status, rule_set_version from public.weeks where week between 1 and 5 order by week");
    expect(weeks.map((w) => w.status)).toEqual(["closed", "closed", "closed", "open", "upcoming"]);
    expect(weeks[3].rule_set_version).toBe(1);
    const [s] = await db.su("select * from public.week_entry_status where entry_id = $1", [aliceEntry]);
    expect(Number(s.bank_at_start_cents)).toBe(1_000_000);
    expect(Number(s.required_cents)).toBe(300_000);
  });
});

describe("current lines", () => {
  it("uses DraftKings, and FanDuel for a market DraftKings doesn't offer", async () => {
    const rows = await db.q(member(alice), "select game_id, market, side, point::float, price, source from public.current_lines where game_id in ($1, $2) order by market, side", [gA, gB]);
    const a = rows.filter((r) => r.game_id === gA);
    expect(a.every((r) => r.source === "draftkings")).toBe(true);
    expect(a.find((r) => r.market === "spread" && r.side === "home")).toMatchObject({ point: -3, price: -110 });
    const bTotal = rows.filter((r) => r.game_id === gB && r.market === "total");
    expect(bTotal.map((r) => r.source)).toEqual(["fanduel", "fanduel"]);
    expect(bTotal[0].point).toBe(44);
  });

  it("drops a book's line once the latest pull no longer has it", async () => {
    await ingest(db, [
      event("A", hoursFromNow(2), "Kansas City Chiefs", "Buffalo Bills", [
        { book: "draftkings", outcomes: standardLines(-3, 47.5, -150, 130).filter((o) => o.market !== "moneyline") },
        { book: "fanduel", outcomes: standardLines(-3.5, 48, -160, 135) },
      ]),
      event("B", hoursFromNow(3), "Baltimore Ravens", "Pittsburgh Steelers", [{ book: "fanduel", outcomes: standardLines(-2.5, 44, -140, 120) }]),
    ]);
    const ml = await db.q(member(alice), "select source, price from public.current_lines where game_id = $1 and market = 'moneyline' order by side", [gA]);
    expect(ml).toEqual([{ source: "fanduel", price: 135 }, { source: "fanduel", price: -160 }]);
    // Restore the full board for the rest of the tests.
    await ingest(db, [
      event("A", hoursFromNow(2), "Kansas City Chiefs", "Buffalo Bills", [{ book: "draftkings", outcomes: standardLines(-3, 47.5, -150, 130) }]),
      event("B", hoursFromNow(3), "Baltimore Ravens", "Pittsburgh Steelers", [{ book: "draftkings", outcomes: standardLines(-6.5, 41, -300, 240) }]),
      event("C", hoursFromNow(-1), "Dallas Cowboys", "New York Giants", [{ book: "draftkings", outcomes: standardLines() }]),
    ]);
  });
});

describe("placing bets", () => {
  it("a straight bet debits the stake and snapshots the line and book", async () => {
    const id = await place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, potentialPayoutCents: 19_091, legs: [kcSpreadHome()] });
    const [mine] = await db.q(member(alice), "select available_cents, pending_cents, bank_cents from public.my_entries() where entry_id = $1", [aliceEntry]);
    expect(Number(mine.available_cents)).toBe(990_000);
    expect(Number(mine.pending_cents)).toBe(10_000);
    expect(Number(mine.bank_cents)).toBe(1_000_000);
    const [leg] = await db.su("select point::float, price, book, teased_point from public.slip_legs where slip_id = $1", [id]);
    expect(leg).toEqual({ point: -3, price: -110, book: "draftkings", teased_point: null });
  });

  it("refuses a leg on a game that has kicked off, by the database clock", async () => {
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, legs: [{ gameId: gC, market: "spread", side: "home", point: -3, price: -110 }] }), "game_started");
  });

  it("refuses when the line or price has moved", async () => {
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, legs: [{ ...kcSpreadHome(), price: -105 }] }), "line_moved");
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, legs: [{ ...kcSpreadHome(), point: -2.5 }] }), "line_moved");
  });

  it("refuses when the lines are stale", async () => {
    await db.su("update public.line_pulls set at = at - interval '2 hours'");
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, legs: [kcSpreadHome()] }), "lines_stale");
    await db.su("update public.line_pulls set at = at + interval '2 hours'");
  });

  it("refuses someone who doesn't manage the entry", async () => {
    await fails(place(db, { entry: aliceEntry, user: bob, type: "straight", stakeCents: 10_000, legs: [kcSpreadHome()] }), "not_manager");
  });

  it("refuses more than the entry has available, and stakes outside the rules", async () => {
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 990_100, legs: [kcSpreadHome()] }), "insufficient_units");
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_050, legs: [kcSpreadHome()] }), "stake_out_of_range");
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 25_000_100, legs: [kcSpreadHome()] }), "stake_out_of_range");
  });

  it("refuses a rule-set version that isn't the week's", async () => {
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, ruleSetVersion: 2, legs: [kcSpreadHome()] }), "rules_changed");
  });

  it("stores the teased number on teaser legs", async () => {
    const id = await place(db, {
      entry: sharedEntry,
      user: bob,
      type: "teaser",
      teaserPoints: 6,
      stakeCents: 10_000,
      quotedAmerican: -110,
      potentialPayoutCents: 19_091,
      legs: [kcSpreadHome(), { gameId: gA, market: "total", side: "under", point: 47.5, price: -110 }],
    });
    const legs = await db.su("select market, side, point::float, teased_point::float from public.slip_legs where slip_id = $1 order by leg_no", [id]);
    expect(legs).toEqual([
      { market: "spread", side: "home", point: -3, teased_point: 3 },
      { market: "total", side: "under", point: 47.5, teased_point: 53.5 },
    ]);
    const [s] = await db.su("select placed_by from public.slips where id = $1", [id]);
    expect(s.placed_by).toBe(bob);
    await fails(
      place(db, { entry: sharedEntry, user: bob, type: "teaser", teaserPoints: 5, stakeCents: 10_000, legs: [kcSpreadHome(), { gameId: gB, market: "spread", side: "home", point: -6.5, price: -110 }] }),
      "bad_teaser_points",
    );
    await fails(
      place(db, { entry: sharedEntry, user: bob, type: "teaser", teaserPoints: 6, stakeCents: 10_000, legs: [kcSpreadHome(), { gameId: gB, market: "moneyline", side: "home", point: null, price: -300 }] }),
      "bad_market",
    );
  });

  it("two slips at once can't spend the same units", async () => {
    const [{ available_cents }] = await db.q(member(bob), "select available_cents from public.my_entries() where entry_id = $1", [bobEntry]);
    const stake = Math.floor((Number(available_cents) * 0.6) / 100) * 100;
    const c1 = await db.pool.connect();
    const c2 = await db.pool.connect();
    try {
      await c1.query("begin; set local role service_role");
      await c2.query("begin; set local role service_role");
      const leg = { gameId: gB, market: "spread", side: "away", point: 6.5, price: -110 };
      await place(db, { entry: bobEntry, user: bob, type: "straight", stakeCents: stake, legs: [leg] }, c1);
      const second = place(db, { entry: bobEntry, user: bob, type: "straight", stakeCents: stake, legs: [leg] }, c2);
      await new Promise((r) => setTimeout(r, 200)); // c2 is now waiting on c1's lock
      await c1.query("commit");
      await fails(second, "insufficient_units");
      await c2.query("rollback");
    } finally {
      c1.release();
      c2.release();
    }
    const [after] = await db.q(member(bob), "select available_cents from public.my_entries() where entry_id = $1", [bobEntry]);
    expect(Number(after.available_cents)).toBe(Number(available_cents) - stake);
  });
});

describe("members can't go around the functions", () => {
  it("can't write tables or call internal functions", async () => {
    await fails(db.q(member(alice), "insert into public.ledger (entry_id, amount_cents, kind) values ($1, 100000, 'adjustment')", [aliceEntry]), "permission denied");
    await fails(db.q(member(alice), "update public.slips set stake_cents = 1"), "permission denied");
    await fails(db.q(member(alice), "update public.profiles set is_admin = true where id = $1", [alice]), "permission denied");
    await fails(
      db.q(member(alice), "select public.place_slip_internal($1, $2, 'straight', null, 100, -110, 191, 1, '[]'::jsonb)", [aliceEntry, alice]),
      "permission denied",
    );
    await fails(db.q(member(alice), "select public.settle_slip_internal(gen_random_uuid(), 'won', 1, '[]')"), "permission denied");
    await fails(db.q(member(alice), "select app.available_cents($1)", [bobEntry]), "permission denied");
  });

  it("signed-out visitors can't read anything", async () => {
    await fails(db.q(anon, "select * from public.entries"), "permission denied");
    await fails(db.q(anon, "select * from public.standings()"), "permission denied");
  });

  it("non-admins can't use admin functions", async () => {
    await fails(db.q(member(alice), "select public.admin_adjust_bank($1, 100000, 'give me units')", [aliceEntry]), "admin_only");
    await fails(db.q(member(alice), "select public.admin_open_next_week(null)"), "admin_only");
    await fails(db.q(member(alice), "select * from public.admin_list_users()"), "admin_only");
  });
});

describe("hidden until kickoff", () => {
  let parlay: string;
  beforeAll(async () => {
    parlay = await place(db, {
      entry: aliceEntry,
      user: alice,
      type: "parlay",
      stakeCents: 5_000,
      quotedAmerican: 264,
      potentialPayoutCents: 18_223,
      legs: [
        { gameId: gA, market: "total", side: "over", point: 47.5, price: -110 },
        { gameId: gB, market: "spread", side: "home", point: -6.5, price: -110 },
      ],
    });
  });

  it("other members, admins included, see no hidden bet, leg or stake", async () => {
    for (const viewer of [bob, owner]) {
      expect(await db.q(member(viewer), "select id from public.slips where entry_id = $1", [aliceEntry])).toEqual([]);
      expect(await db.q(member(viewer), "select l.* from public.slip_legs l where l.slip_id = $1", [parlay])).toEqual([]);
      expect(await db.q(member(viewer), "select * from public.ledger where entry_id = $1 and kind = 'stake'", [aliceEntry])).toEqual([]);
    }
    expect((await db.q(member(alice), "select id from public.slips where entry_id = $1", [aliceEntry])).length).toBe(2);
  });

  it("the activity feed says a pick was made, without details", async () => {
    const rows = await db.q(member(bob), "select * from public.hidden_activity(10)");
    expect(rows.filter((r) => r.entry_id === aliceEntry)).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual(["entry_id", "name", "placed_at"]);
    expect((await db.q(member(alice), "select * from public.hidden_activity(10) where entry_id = $1", [aliceEntry])).length).toBe(0);
  });

  it("standings don't leak hidden stakes to other members", async () => {
    const rows = await db.q(member(bob), "select * from public.standings() where entry_id = $1", [aliceEntry]);
    expect(Number(rows[0].bank_cents)).toBe(1_000_000);
    expect(Number(rows[0].at_risk_cents)).toBe(0);
    expect(Number(rows[0].wagered_cents)).toBe(0);
    const mine = await db.q(member(alice), "select * from public.standings() where entry_id = $1", [aliceEntry]);
    expect(Number(mine[0].at_risk_cents)).toBe(15_000);
    expect(mine[0].is_mine).toBe(true);
  });

  it("at kickoff the bet and that game's leg appear; later legs stay hidden", async () => {
    await db.su("update public.games set kickoff_at = now() - interval '1 minute' where id = $1", [gA]);
    const slips = await db.q(member(bob), "select id, stake_cents from public.slips where entry_id = $1 order by placed_at", [aliceEntry]);
    expect(slips.map((s) => s.id)).toContain(parlay);
    const legs = await db.q(member(bob), "select game_id from public.slip_legs where slip_id = $1", [parlay]);
    expect(legs.map((l) => l.game_id)).toEqual([gA]);
    const stakes = await db.q(member(bob), "select amount_cents from public.ledger where entry_id = $1 and kind = 'stake'", [aliceEntry]);
    expect(stakes).toHaveLength(2);
  });
});

describe("undo", () => {
  it("returns the stake within 5 minutes, before kickoff, and never reveals the bet", async () => {
    const id = await place(db, { entry: bobEntry, user: bob, type: "straight", stakeCents: 2_000, legs: [{ gameId: gB, market: "moneyline", side: "away", point: null, price: 240 }] });
    const before = Number((await db.q(member(bob), "select available_cents from public.my_entries() where entry_id = $1", [bobEntry]))[0].available_cents);
    await fails(db.q(member(alice), "select public.undo_slip($1)", [id]), "not_found");
    await db.q(member(bob), "select public.undo_slip($1)", [id]);
    const after = Number((await db.q(member(bob), "select available_cents from public.my_entries() where entry_id = $1", [bobEntry]))[0].available_cents);
    expect(after - before).toBe(2_000);
    await fails(db.q(member(bob), "select public.undo_slip($1)", [id]), "not_pending");
    await db.su("update public.games set kickoff_at = now() - interval '1 minute' where id = $1", [gB]);
    expect(await db.q(member(alice), "select id from public.slips where id = $1", [id])).toEqual([]);
    await db.su("update public.games set kickoff_at = now() + interval '3 hours' where id = $1", [gB]);
  });

  it("refuses after 5 minutes", async () => {
    const id = await place(db, { entry: bobEntry, user: bob, type: "straight", stakeCents: 2_000, legs: [{ gameId: gB, market: "moneyline", side: "away", point: null, price: 240 }] });
    // Time travel past the undo window (the slips guard forbids changing placed_at, so bypass triggers).
    const c = await db.pool.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query("update public.slips set placed_at = now() - interval '6 minutes' where id = $1", [id]);
      await c.query("set session_replication_role = origin");
    } finally {
      c.release();
    }
    await fails(db.q(member(bob), "select public.undo_slip($1)", [id]), "undo_window_passed");
  });
});

describe("settling", () => {
  it("pays the grade once and refuses impossible payouts", async () => {
    const id = await place(db, { entry: sharedEntry, user: alice, type: "straight", stakeCents: 10_000, potentialPayoutCents: 23_000, legs: [{ gameId: gB, market: "spread", side: "home", point: -6.5, price: -110 }] });
    await fails(db.q(service, "select public.settle_slip_internal($1, 'won', 30000, '[]')", [id]), "bad_payout");
    await fails(db.q(service, "select public.settle_slip_internal($1, 'lost', 5, '[]')", [id]), "bad_payout");
    await fails(db.q(service, "select public.settle_slip_internal($1, 'push', 9000, '[]')", [id]), "bad_payout");
    const before = Number((await db.su("select app.available_cents($1) as a", [sharedEntry]))[0].a);
    const [r1] = await db.q(service, `select public.settle_slip_internal($1, 'won', 19091, '[{"legNo":1,"result":"won"}]') as ok`, [id]);
    expect(r1.ok).toBe(true);
    const [r2] = await db.q(service, `select public.settle_slip_internal($1, 'won', 19091, '[{"legNo":1,"result":"won"}]') as ok`, [id]);
    expect(r2.ok).toBe(false);
    const after = Number((await db.su("select app.available_cents($1) as a", [sharedEntry]))[0].a);
    expect(after - before).toBe(19_091);
    const [leg] = await db.su("select result from public.slip_legs where slip_id = $1", [id]);
    expect(leg.result).toBe("won");
  });

  it("an admin void takes back winnings and refunds the stake, and logs no picks", async () => {
    const [s] = await db.su("select id from public.slips where entry_id = $1 and status = 'won'", [sharedEntry]);
    const before = Number((await db.su("select app.available_cents($1) as a", [sharedEntry]))[0].a);
    await fails(db.q(member(owner), "select public.admin_void_slip($1, '')", [s.id]), "reason_required");
    await db.q(member(owner), "select public.admin_void_slip($1, 'Game was played under protest')", [s.id]);
    const after = Number((await db.su("select app.available_cents($1) as a", [sharedEntry]))[0].a);
    expect(after - before).toBe(-19_091 + 10_000);
    const [log] = await db.q(member(bob), "select action, before, after from public.audit_log where action = 'bet_voided'");
    expect(log.before).toMatchObject({ status: "won", stakeCents: 10_000 });
    expect(JSON.stringify(log)).not.toContain("spread");
  });
});

describe("records can't be rewritten", () => {
  it("ledger, audit log and rule sets are append-only, even for the service role", async () => {
    await fails(db.q(service, "update public.ledger set amount_cents = 0"), "append-only");
    await fails(db.q(service, "delete from public.ledger"), "append-only");
    await fails(db.q(service, "delete from public.audit_log"), "append-only");
    await fails(db.q(service, "update public.rule_sets set note = 'x'"), "append-only");
  });

  it("a placed slip's terms can't change", async () => {
    await fails(db.q(service, "update public.slips set stake_cents = stake_cents + 100"), "cannot be changed");
    await fails(db.q(service, "update public.slip_legs set point = 0"), "cannot be changed");
    await fails(db.q(service, "delete from public.slips"), "cannot be deleted");
  });
});

describe("admin lines", () => {
  it("an override replaces the book line and doesn't go stale", async () => {
    await fails(db.q(member(owner), "select public.admin_set_line($1, 'spread', -3.5, -110, 3, -110, true, 'fix the number')", [gB]), "spread_points_must_mirror");
    await db.q(member(owner), "select public.admin_set_line($1, 'spread', -7, -105, 7, -115, true, 'Market moved; feed is behind')", [gB]);
    const rows = await db.q(member(alice), "select side, point::float, price, source from public.current_lines where game_id = $1 and market = 'spread' order by side", [gB]);
    expect(rows).toEqual([
      { side: "away", point: 7, price: -115, source: "override" },
      { side: "home", point: -7, price: -105, source: "override" },
    ]);
    await db.su("update public.line_pulls set at = at - interval '2 hours'");
    await place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 1_000, legs: [{ gameId: gB, market: "spread", side: "home", point: -7, price: -105 }] });
    await fails(place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 1_000, legs: [{ gameId: gB, market: "moneyline", side: "home", point: null, price: -300 }] }), "lines_stale");
    await db.su("update public.line_pulls set at = at + interval '2 hours'");
  });

  it("taking a market off the board hides it", async () => {
    await db.q(member(owner), "select public.admin_set_line($1, 'total', 41, -110, 41, -110, false, 'Weather: off the board')", [gB]);
    expect(await db.q(member(alice), "select * from public.current_lines where game_id = $1 and market = 'total'", [gB])).toEqual([]);
    await db.q(member(owner), "select public.admin_clear_line($1, 'total', 'Back on the board')", [gB]);
    expect((await db.q(member(alice), "select * from public.current_lines where game_id = $1 and market = 'total'", [gB])).length).toBe(2);
  });

  it("every admin action is in the log members can read", async () => {
    const actions = (await db.q(member(bob), "select action from public.audit_log order by id")).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["admin_granted", "entry_added", "manager_added", "week_opened", "line_set", "line_cleared", "bet_voided"]));
  });
});
