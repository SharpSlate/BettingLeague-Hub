// The problems the adversarial review found in the database, each reproduced here
// against the fix: ways to see hidden picks, reopen betting, lose a grade, or close
// the wrong week.
import { readFileSync } from "node:fs";
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
  makeCommissioner,
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
let owner: string, commish: string, alice: string, bob: string;
let aliceEntry: string, bobEntry: string;
const board: Event[] = [];
const ids: Record<string, string> = {};

const GAMES: [id: string, hours: number, home: string, away: string][] = [
  ["VIS", 2, "Kansas City Chiefs", "Buffalo Bills"],
  ["KO", 3, "Baltimore Ravens", "Pittsburgh Steelers"],
  ["LIVE", 3, "Dallas Cowboys", "New York Giants"],
  ["LATE", 7, "Los Angeles Chargers", "Tampa Bay Buccaneers"],
  ["FEED", 4, "Detroit Lions", "Green Bay Packers"],
  ["EARLY", 5, "Miami Dolphins", "New York Jets"],
  ["MOVE", 6, "San Francisco 49ers", "Los Angeles Rams"],
  ["P1", 2, "Philadelphia Eagles", "Washington Commanders"],
  ["P2", 8, "Seattle Seahawks", "Arizona Cardinals"],
  ["REF", 10, "Atlanta Falcons", "Carolina Panthers"],
  ["UNDO", 30, "New England Patriots", "New Orleans Saints"],
  ["STD", 2, "Denver Broncos", "Las Vegas Raiders"],
  ["FIN", 2, "Chicago Bears", "Minnesota Vikings"],
  ["VOID", 2, "Cincinnati Bengals", "Cleveland Browns"],
  ["LOCK", 0.5, "Houston Texans", "Indianapolis Colts"],
  ["W5", 24 * 6, "Jacksonville Jaguars", "Tennessee Titans"],
];

const pull = () => ingest(db, board);
const setKickoff = (id: string, sql: string) => db.su(`update public.games set kickoff_at = ${sql} where id = $1`, [ids[id]]);
const spreadHome = (id: string) => ({ gameId: ids[id]!, market: "spread", side: "home", point: -3, price: -110 });
const available = async (entry: string) => Number((await db.su("select app.available_cents($1) as a", [entry]))[0].a);
const scores = (rows: { id: string; completed: boolean; homeScore: number; awayScore: number }[]) =>
  db.q(service, "select public.ingest_scores_internal('schedule', $1::jsonb, 2, 90000)", [JSON.stringify(rows)]);
const settle = (id: string, result: string, payout: number, legs = "[]") =>
  db.q(service, "select public.settle_slip_internal($1, $2, $3, $4::jsonb)", [id, result, payout, legs]);
const straight = (entry: string, user: string, game: string) =>
  place(db, { entry, user, type: "straight", stakeCents: 10_000, potentialPayoutCents: 19_091, legs: [spreadHome(game)] });
const legsSeenBy = async (user: string, game: string) =>
  (await db.q(member(user), "select count(*)::int as n from public.slip_legs where game_id = $1", [ids[game]]))[0].n;

beforeAll(async () => {
  db = await freshDb("bl_review");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  alice = await makeUser(db, "alice@example.com", "Alice");
  bob = await makeUser(db, "bob@example.com", "Bob");
  commish = await makeUser(db, "commish@example.com", "Commish");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  await makeLeague(db, owner);
  await db.q(member(owner), "select public.admin_set_admin($1, true)", [commish]);
  await makeCommissioner(db, commish);
  aliceEntry = (await db.q(member(owner), "select public.admin_add_entry('Alice', 1000000) as id"))[0].id;
  bobEntry = (await db.q(member(owner), "select public.admin_add_entry('Bob', 1000000) as id"))[0].id;
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [aliceEntry, alice]);
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [bobEntry, bob]);
  for (const [id, hours, home, away] of GAMES) {
    board.push(event(id, hoursFromNow(hours), home, away, [{ book: "draftkings", outcomes: standardLines(-3) }]));
  }
  await pull();
  for (const [id] of GAMES) ids[id] = await gameId(db, id);
  await db.q(member(owner), "select public.admin_open_next_week(null, 'Start of the trial')");
});
afterAll(async () => db?.close());

describe("managers and hidden bets", () => {
  it("an admin can't make themselves a manager of someone else's entry", async () => {
    await fails(db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [aliceEntry, owner]), "self_add_blocked");
  });

  it("an admin another admin adds as a manager doesn't see bets placed before they joined", async () => {
    const id = await straight(aliceEntry, alice, "VIS");
    await db.q(member(commish), "select public.admin_set_manager($1, $2, true)", [aliceEntry, owner]);
    const seen = async (user: string) => ({
      slips: (await db.q(member(user), "select id from public.slips where id = $1", [id])).length,
      legs: (await db.q(member(user), "select leg_no from public.slip_legs where slip_id = $1", [id])).length,
      ledger: (await db.q(member(user), "select id from public.ledger where slip_id = $1", [id])).length,
    });
    expect(await seen(owner)).toEqual({ slips: 0, legs: 0, ledger: 0 });
    expect(await seen(alice)).toEqual({ slips: 1, legs: 1, ledger: 1 });
    // A bet the entry places after they joined is theirs to see.
    const later = await place(db, {
      entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, potentialPayoutCents: 19_091,
      legs: [{ gameId: ids.VIS!, market: "total", side: "over", point: 47.5, price: -110 }],
    });
    expect((await db.q(member(owner), "select id from public.slips where id = $1", [later])).length).toBe(1);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [aliceEntry, owner]);
    expect((await db.q(member(owner), "select id from public.slips where id = $1", [later])).length).toBe(0);
  });
});

describe("the game controls can't show picks early or reopen betting", () => {
  it("a kickoff can't be set in the past", async () => {
    await straight(aliceEntry, alice, "KO");
    const past = new Date(Date.now() - 60_000).toISOString();
    await fails(db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', $2, 'peek')", [ids.KO, past]), "kickoff_in_past");
    await fails(db.q(member(owner), "select public.admin_set_game_status($1, 'postponed', $2, 'peek')", [ids.KO, past]), "kickoff_in_past");
    expect(await legsSeenBy(bob, "KO")).toBe(0);
  });

  it("a kickoff that has passed stays put, and a game that started can't reopen", async () => {
    await setKickoff("KO", "now() - interval '1 minute'");
    await fails(
      db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', $2, 'hide them again')", [ids.KO, hoursFromNow(5).toISOString()]),
      "kickoff_passed",
    );
    await fails(db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', null, 'reopen')", [ids.KO]), "game_started");
    await db.q(member(owner), "select public.admin_set_game_status($1, 'postponed', null, 'Lightning delay')", [ids.KO]);
    await fails(db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', null, 'reopen')", [ids.KO]), "game_started");
    // Its picks came out at kickoff and stay out.
    expect(await legsSeenBy(bob, "KO")).toBe(1);
  });

  it("a live game can't be set back to scheduled", async () => {
    await setKickoff("LIVE", "now() - interval '30 minutes'");
    await scores([{ id: "LIVE", completed: false, homeScore: 14, awayScore: 0 }]);
    await fails(db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', null, 'oops')", [ids.LIVE]), "game_started");
  });

  it("a game that hasn't started can move later, and the log shows both kickoffs", async () => {
    const to = hoursFromNow(9).toISOString();
    await db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', $2, 'Flexed to the late window')", [ids.LATE, to]);
    const [log] = await db.q(member(bob), "select before, after from public.audit_log where action = 'game_status_set' and target_id = $1", [ids.LATE]);
    expect(Date.parse(log.after.kickoffAt)).toBe(Date.parse(to));
    expect(Date.parse(log.before.kickoffAt)).toBeLessThan(Date.parse(to));
  });
});

describe("the feed can't reopen betting", () => {
  it("keeps the kickoff of a game that has started by the database clock", async () => {
    await setKickoff("FEED", "now() - interval '5 minutes'");
    await fails(straight(bobEntry, bob, "FEED"), "game_started");
    board.find((e) => e.id === "FEED")!.commenceTime = new Date(Date.now() + 10 * 60_000).toISOString();
    await pull();
    expect((await db.su("select kickoff_at <= now() as started from public.games where id = $1", [ids.FEED]))[0].started).toBe(true);
    await fails(straight(bobEntry, bob, "FEED"), "game_started");
  });

  it("scores for a game the league thought hadn't started close betting on it", async () => {
    // Due within the hour, so an early start is believable (readings for games further
    // out are ignored as bad; see review2.test.ts).
    await setKickoff("EARLY", "now() + interval '30 minutes'");
    await scores([{ id: "EARLY", completed: false, homeScore: 7, awayScore: 0 }]);
    const [g] = await db.su("select status, kickoff_at <= now() as started from public.games where id = $1", [ids.EARLY]);
    expect(g).toEqual({ status: "live", started: true });
    await fails(straight(bobEntry, bob, "EARLY"), "game_started");
  });

  it("a game with bets on it keeps its week when the feed moves it", async () => {
    await straight(bobEntry, bob, "MOVE");
    board.find((e) => e.id === "MOVE")!.commenceTime = hoursFromNow(24 * 5).toISOString();
    // A new time takes two pulls in a row to stick.
    await pull();
    await pull();
    const [g] = await db.su("select week, kickoff_at > now() + interval '4 days' as moved from public.games where id = $1", [ids.MOVE]);
    expect(g).toEqual({ week: 4, moved: true });
  });
});

describe("a parlay's odds stay hidden until every leg is revealed", () => {
  let id: string;
  it("other members can't read odds or payout from the table", async () => {
    id = await place(db, {
      entry: aliceEntry, user: alice, type: "parlay", stakeCents: 10_000, quotedAmerican: 364, potentialPayoutCents: 46_364,
      legs: [spreadHome("P1"), { gameId: ids.P2!, market: "moneyline", side: "away", point: null, price: 130 }],
    });
    await fails(db.q(member(bob), "select quoted_american from public.slips"), "permission denied");
    await fails(db.q(member(bob), "select potential_payout_cents from public.slips"), "permission denied");
    await fails(db.q(member(bob), "select * from public.slips"), "permission denied");
  });

  it("after the first kickoff the bet shows, but its odds and payout wait for the last leg", async () => {
    await setKickoff("P1", "now() - interval '1 minute'");
    const [s] = await db.q(member(bob), "select stake_cents::int as stake, leg_count from public.slips where id = $1", [id]);
    expect(s).toEqual({ stake: 10_000, leg_count: 2 });
    expect((await db.q(member(bob), "select count(*)::int as n from public.slip_legs where slip_id = $1", [id]))[0].n).toBe(1);
    expect(await db.q(member(bob), "select * from public.slip_quotes($1::uuid[])", [[id]])).toEqual([]);
    const mine = await db.q(member(alice), "select quoted_american::int as a, potential_payout_cents::int as p from public.slip_quotes($1::uuid[])", [[id]]);
    expect(mine).toEqual([{ a: 364, p: 46_364 }]);
    await setKickoff("P2", "now() - interval '1 minute'");
    expect(await db.q(member(bob), "select quoted_american::int as a from public.slip_quotes($1::uuid[])", [[id]])).toEqual([{ a: 364 }]);
  });
});

describe("private details", () => {
  it("members can't read a failed pull's error text", async () => {
    await db.q(service, "select public.record_pull_internal('lines', 'bet', false, 'network error: ...&apiKey=abc123', null, null)");
    await fails(db.q(member(bob), "select error from public.line_pulls"), "permission denied");
    expect((await db.q(member(bob), "select ok from public.line_pulls where not ok")).length).toBeGreaterThan(0);
  });

  it("a bank adjustment logs the bank everyone sees, not the units available", async () => {
    // Bob has a hidden bet riding, so his available units would give away its stake.
    await db.q(member(owner), "select public.admin_adjust_bank($1, 5000, 'Splash rounding')", [bobEntry]);
    const [log] = await db.q(member(alice), "select before, after from public.audit_log where action = 'bank_adjusted' order by id desc limit 1");
    const [st] = await db.q(member(alice), "select bank_cents::int as bank from public.standings() where entry_id = $1", [bobEntry]);
    expect(log.after).toEqual({ bankCents: st.bank, amountCents: 5000 });
    expect(log.before).toEqual({ bankCents: st.bank - 5000 });
  });

  it("only games in a week that hasn't opened can move, so the answer says nothing about bets", async () => {
    await fails(db.q(member(owner), "select public.admin_move_game($1, 5, 'Wrong week')", [ids.MOVE]), "week_already_open");
    await fails(db.q(member(owner), "select public.admin_move_game($1, 5, 'Wrong week')", [ids.LATE]), "week_already_open");
  });

  it("members can read every slip column the site asks for", async () => {
    const src = readFileSync(new URL("../../web/src/lib/supabase-api.ts", import.meta.url), "utf8");
    const cols = /"(id, entry_id,[^"]+?), " \+/.exec(src)?.[1];
    expect(cols).toContain("stake_cents");
    expect(cols).not.toContain("quoted_american");
    await db.q(member(bob), `select ${cols} from public.slips`);
  });

  it("a new member gets a neutral display name, never part of their email", async () => {
    const u = await makeUser(db, "carol.jones1987@example.com");
    expect((await db.q(member(u), "select display_name from public.profiles where id = $1", [u]))[0].display_name).toBe("Member");
    // Someone who shares no league with them can't see them at all.
    expect(await db.q(member(bob), "select display_name from public.profiles where id = $1", [u])).toEqual([]);
  });
});

describe("placing bets", () => {
  it("a retry with the same ref returns the first bet and charges once", async () => {
    const ref = "8a4f5c2e-0000-4000-8000-000000000001";
    const args = { entry: bobEntry, user: bob, type: "straight" as const, stakeCents: 10_000, potentialPayoutCents: 19_091, legs: [spreadHome("REF")], clientRef: ref };
    const before = await available(bobEntry);
    const first = await place(db, args);
    expect(await place(db, args)).toBe(first);
    expect(before - (await available(bobEntry))).toBe(10_000);
    await fails(place(db, { ...args, entry: aliceEntry, user: alice }), "client_ref_conflict");
  });

  it("refuses a payout that doesn't beat the stake", async () => {
    await fails(place(db, { entry: bobEntry, user: bob, type: "straight", stakeCents: 10_000, potentialPayoutCents: 10_000, legs: [spreadHome("REF")] }), "bad_quote");
  });

  it("stores a long parlay's American odds, past two billion", async () => {
    const id = await place(db, {
      entry: bobEntry, user: bob, type: "parlay", stakeCents: 1_000, quotedAmerican: 2_532_951_521, potentialPayoutCents: 25_329_516_212,
      legs: [spreadHome("REF"), { gameId: ids.UNDO!, market: "total", side: "over", point: 47.5, price: -110 }],
    });
    expect((await db.su("select quoted_american::text as q from public.slips where id = $1", [id]))[0].q).toBe("2532951521");
  });

  it("only one bet at a time gets to pull fresh lines", async () => {
    const claim = async () => (await db.q(service, "select public.claim_bet_refresh_internal(120) as r"))[0].r;
    expect(await claim()).toBe("claimed");
    expect(await claim()).toBe("recent");
    await db.su("update public.league_settings set bet_refresh_claimed_at = now() - interval '3 minutes'");
    expect(await claim()).toBe("claimed");
    await fails(db.q(member(bob), "select public.claim_bet_refresh_internal(120)"), "permission denied");
  });

  it("a bet that waited on another is checked against kickoff when it's recorded", async () => {
    await setKickoff("LOCK", "clock_timestamp() + interval '1500 milliseconds'");
    const c = await db.pool.connect();
    let waiting: Promise<string> | undefined;
    try {
      await c.query("begin");
      await c.query("select 1 from public.entries where id = $1 for update", [bobEntry]);
      waiting = straight(bobEntry, bob, "LOCK");
      waiting.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 2000));
      await c.query("commit");
    } finally {
      c.release();
    }
    await fails(waiting!, "game_started");
  });
});

describe("standings by week", () => {
  it("a bet graded after the week's window closed still counts in its week", async () => {
    const id = await place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 20_000, potentialPayoutCents: 38_182, legs: [spreadHome("STD")] });
    await setKickoff("STD", "now() - interval '3 hours'");
    await settle(id, "won", 38_182);
    // Late Monday night: the grade lands after the week's Tuesday-midnight end.
    await db.su("update public.slips set settled_at = (select ends_at + interval '20 minutes' from public.weeks where week = 4) where id = $1", [id]);
    const [w] = await db.su("select starts_at, ends_at from public.weeks where week = 4");
    const [byWeek] = await db.q(member(bob), "select wins, net_cents::int as net from public.standings(null, null, 4) where entry_id = $1", [aliceEntry]);
    const [byTime] = await db.q(member(bob), "select wins from public.standings($1, $2) where entry_id = $3", [w.starts_at, w.ends_at, aliceEntry]);
    expect(byWeek).toEqual({ wins: 1, net: 18_182 });
    expect(byTime.wins).toBe(0);
  });
});

describe("correcting a final score", () => {
  let won: string;
  it("reopens graded bets, takes the payout back, and lets them be graded again", async () => {
    won = await straight(aliceEntry, alice, "FIN");
    await setKickoff("FIN", "now() - interval '3 hours'");
    await scores([{ id: "FIN", completed: true, homeScore: 27, awayScore: 20 }]);
    await scores([{ id: "FIN", completed: true, homeScore: 27, awayScore: 20 }]);
    await settle(won, "won", 19_091, JSON.stringify([{ legNo: 1, result: "won" }]));
    const before = await available(aliceEntry);

    await db.q(member(owner), "select public.admin_set_final_score($1, 20, 27, 'The feed had the teams reversed')", [ids.FIN]);
    expect((await db.su("select status, payout_cents, settled_at from public.slips where id = $1", [won]))[0]).toEqual({ status: "pending", payout_cents: null, settled_at: null });
    expect((await db.su("select result from public.slip_legs where slip_id = $1", [won]))[0].result).toBe("pending");
    expect(await available(aliceEntry)).toBe(before - 19_091);
    expect((await db.su("select amount_cents::int as a from public.ledger where slip_id = $1 and kind = 'regrade_reversal'", [won]))[0].a).toBe(-19_091);
    const [log] = await db.q(member(bob), "select after from public.audit_log where action = 'score_corrected'");
    expect(log.after).toMatchObject({ home: 20, away: 27, betsRegraded: 1 });

    // The grading job grades it again: KC −3 lost 20–27.
    await settle(won, "lost", 0);
    expect(await available(aliceEntry)).toBe(before - 19_091);
  });

  it("voiding a final game regrades its bets, and a score entered later brings them back", async () => {
    const id = await straight(bobEntry, bob, "VOID");
    await setKickoff("VOID", "now() - interval '3 hours'");
    await db.q(member(owner), "select public.admin_set_final_score($1, 30, 0, 'Feed down')", [ids.VOID]);
    await settle(id, "won", 19_091);
    await db.q(member(owner), "select public.admin_set_game_status($1, 'void', null, 'Game was never finished')", [ids.VOID]);
    expect((await db.su("select status from public.slips where id = $1", [id]))[0].status).toBe("pending");
    await settle(id, "void", 10_000);
    await db.q(member(owner), "select public.admin_set_final_score($1, 30, 0, 'Voided by mistake')", [ids.VOID]);
    expect((await db.su("select status from public.slips where id = $1", [id]))[0].status).toBe("pending");
  });

  it("a bet an admin voided stays void when the score changes", async () => {
    await db.q(member(owner), "select public.admin_void_slip($1, 'Placed in error')", [won]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 27, 20, 'Back to the right score')", [ids.FIN]);
    expect((await db.su("select status from public.slips where id = $1", [won]))[0].status).toBe("void");
  });
});

describe("rule versions", () => {
  it("a new version can't start before one that's already scheduled", async () => {
    const doc = JSON.stringify({ ...DAY_ONE_RULES, undoMinutes: 3 });
    const publish = (week: number) => db.q(service, "select public.publish_rule_set_internal($1, (select id from public.leagues), $2::jsonb, $3, 'change') as v", [owner, doc, week]);
    // Version 1 is the day-one template; the league started on a copy, version 2.
    expect((await publish(7))[0].v).toBe(3);
    await fails(publish(6), "effective_week_before_scheduled");
    expect((await publish(7))[0].v).toBe(4);
    expect((await db.su("select app.rule_set_for_week(id, 6) as w6, app.rule_set_for_week(id, 7) as w7 from public.leagues"))[0]).toEqual({ w6: 2, w7: 4 });
  });
});

describe("overlapping line pulls", () => {
  it("a pull that started first but stored last doesn't take lines off the board", async () => {
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role service_role");
      await c.query("select now()");
      await new Promise((r) => setTimeout(r, 50));
      await pull(); // started later, stored first
      await c.query("select public.ingest_lines_internal('schedule', $1::jsonb, 3, 90000)", [JSON.stringify(board)]);
      await c.query("commit");
    } finally {
      c.release();
    }
    expect((await db.su("select count(*)::int as n from public.current_lines where game_id = $1", [ids.REF]))[0].n).toBe(6);
  });
});

describe("opening the next week by hand", () => {
  it("refuses when the admin's page shows a different open week", async () => {
    await fails(db.q(member(owner), "select public.admin_open_next_week(3, 'stale page')"), "week_changed");
    await fails(db.q(member(owner), "select public.admin_open_next_week(null, 'stale page')"), "week_changed");
  });

  it("a bet can't be undone once its week has closed", async () => {
    const id = await straight(aliceEntry, alice, "UNDO");
    expect((await db.q(member(owner), "select public.admin_open_next_week(4, 'Around the postponed game') as w"))[0].w).toBe(5);
    await fails(undo(db, id, alice), "week_closed");
  });

  it("won't close a week in which no game has kicked off", async () => {
    await fails(db.q(member(owner), "select public.admin_open_next_week(5, 'double click')"), "week_not_started");
  });

  it("won't close into a week whose games aren't on the board; closing the season is its own step", async () => {
    await setKickoff("W5", "now() - interval '3 hours'");
    await fails(db.q(member(owner), "select public.admin_open_next_week(5, 'Season over')"), "next_week_not_loaded");
    await db.q(member(owner), "select public.admin_close_season(5, 'Season over')");
    expect(await db.su("select week, status from public.league_weeks where week in (5, 6) order by week")).toEqual([
      { week: 5, status: "closed" },
      { week: 6, status: "upcoming" },
    ]);
    expect((await db.q(member(bob), "select target_id from public.audit_log where action = 'week_closed'"))[0].target_id).toBe("5");
    expect((await db.su("select count(*)::int as n from public.week_entry_status where week = 5 and wagered_cents is not null"))[0].n).toBe(2);
  });
});
