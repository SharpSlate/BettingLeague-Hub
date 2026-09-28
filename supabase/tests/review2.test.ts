// What the second database review found in the fixes, each reproduced against its fix:
// kickoffs moved earlier to show picks early, bad feed readings, re-added managers,
// regrading on demand, postponed games the score pulls lost, and games stuck live.
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
let owner: string, alice: string, bob: string;
let aliceEntry: string;
const board: Event[] = [];
const ids: Record<string, string> = {};

const GAMES: [id: string, hours: number, home: string, away: string][] = [
  ["EARLY", 3, "Kansas City Chiefs", "Buffalo Bills"],
  ["FEEDPAST", 3, "Baltimore Ravens", "Pittsburgh Steelers"],
  ["SOON", 0.3, "Dallas Cowboys", "New York Giants"],
  ["FAR", 24 * 6, "Detroit Lions", "Green Bay Packers"],
  ["PP", 2, "Miami Dolphins", "New York Jets"],
  ["LIVE6", 2, "San Francisco 49ers", "Los Angeles Rams"],
  ["FIN2", 2, "Philadelphia Eagles", "Washington Commanders"],
  ["MINE", 4, "Seattle Seahawks", "Arizona Cardinals"],
];
const commence = (id: string, at: Date) => {
  board.find((e) => e.id === id)!.commenceTime = at.toISOString();
};
const pull = () => ingest(db, board);
const spreadHome = (id: string) => ({ gameId: ids[id]!, market: "spread", side: "home", point: -3, price: -110 });
const straight = (game: string) =>
  place(db, { entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, potentialPayoutCents: 19_091, legs: [spreadHome(game)] });
const legsSeenBy = async (user: string, game: string) =>
  (await db.q(member(user), "select count(*)::int as n from public.slip_legs where game_id = $1", [ids[game]]))[0].n;
const game = async (id: string) =>
  (await db.su("select status, kickoff_at <= now() as started, rescheduled_at from public.games where id = $1", [ids[id]]))[0];

beforeAll(async () => {
  db = await freshDb("bl_review2");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  alice = await makeUser(db, "alice@example.com", "Alice");
  bob = await makeUser(db, "bob@example.com", "Bob");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  aliceEntry = (await db.q(member(owner), "select public.admin_add_entry('Alice', 1000000) as id"))[0].id;
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [aliceEntry, alice]);
  for (const [id, hours, home, away] of GAMES) {
    board.push(event(id, hoursFromNow(hours), home, away, [{ book: "draftkings", outcomes: standardLines(-3) }]));
  }
  await pull();
  for (const [id] of GAMES) ids[id] = await gameId(db, id);
  await db.q(member(owner), "select public.admin_open_next_week(null, 'Start')");
});
afterAll(async () => db?.close());

describe("kickoffs", () => {
  it("an admin can't move an open week's kickoff earlier, even to a moment from now", async () => {
    await straight("EARLY");
    const soon = new Date(Date.now() + 2_000).toISOString();
    await fails(db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', $2, 'flexed')", [ids.EARLY, soon]), "kickoff_earlier");
    // Later is fine: it keeps the picks hidden longer.
    await db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', $2, 'Flexed to the late window')", [ids.EARLY, hoursFromNow(6).toISOString()]);
    expect(await legsSeenBy(bob, "EARLY")).toBe(0);
  });

  it("one feed reading can't pull a game that's hours away into the past", async () => {
    await straight("FEEDPAST");
    commence("FEEDPAST", new Date(Date.now() - 60_000));
    await pull();
    expect((await game("FEEDPAST")).started).toBe(false);
    expect(await legsSeenBy(bob, "FEEDPAST")).toBe(0);
  });

  it("but a game due within the hour follows the feed, and betting on it closes", async () => {
    commence("SOON", new Date(Date.now() - 60_000));
    await pull();
    expect((await game("SOON")).started).toBe(true);
    await fails(straight("SOON"), "game_started");
  });

  it("scores for a game days away are ignored as a bad reading", async () => {
    await db.q(service, "select public.ingest_scores_internal('schedule', $1::jsonb, 2, 90000)", [JSON.stringify([{ id: "FAR", completed: false, homeScore: 7, awayScore: 0 }])]);
    expect(await game("FAR")).toMatchObject({ status: "scheduled", started: false });
  });
});

describe("a postponed game", () => {
  it("keeps its kickoff, takes the feed's new time, and gets score pulls around it", async () => {
    await db.q(member(owner), "select public.admin_set_game_status($1, 'postponed', null, 'Weather')", [ids.PP]);
    await db.su("update public.games set kickoff_at = now() - interval '1 hour' where id = $1", [ids.PP]);
    const newTime = hoursFromNow(26);
    commence("PP", newTime);
    await pull();
    const g = await game("PP");
    expect(g.status).toBe("postponed");
    expect(g.started).toBe(true); // the original kickoff stands, so revealed picks stay revealed
    expect((g.rescheduled_at as Date).getTime()).toBe(newTime.getTime());
    // Count the game's own contribution around its new time.
    const at = new Date(newTime.getTime() + 60_000).toISOString();
    const count = async () => (await db.q(service, "select public.games_awaiting_scores_internal($1) as n", [at]))[0].n as number;
    const withIt = await count();
    await db.su("update public.games set status = 'final', home_score = 1, away_score = 0 where id = $1", [ids.PP]);
    expect(withIt - (await count())).toBe(1);
  });
});

describe("games the admins need to look at", () => {
  it("a game still live 6 hours after kickoff shows in the admins' problem list", async () => {
    await db.su("update public.games set kickoff_at = now() - interval '6 hours', status = 'live', home_score = 20, away_score = 17 where id = $1", [ids.LIVE6]);
    const rows = await db.q(member(owner), "select kind, error from public.admin_recent_problems(10)");
    expect(rows).toContainEqual({ kind: "game", error: "Rams at 49ers has been live for over 5 hours with no final. Enter its final score." });
  });
});

describe("regrading on demand", () => {
  it("entering the same final score again regrades the game's bets", async () => {
    const id = await straight("FIN2");
    await db.su("update public.games set kickoff_at = now() - interval '3 hours' where id = $1", [ids.FIN2]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 27, 20, 'Feed down')", [ids.FIN2]);
    await db.q(service, "select public.settle_slip_internal($1, 'won', 19091, '[]')", [id]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 27, 20, 'Regrade: a bet was graded wrong')", [ids.FIN2]);
    expect((await db.su("select status from public.slips where id = $1", [id]))[0].status).toBe("pending");
    const [log] = await db.q(member(bob), "select after from public.audit_log where action = 'bets_regraded'");
    expect(log.after).toMatchObject({ home: 27, away: 20, betsRegraded: 1 });
  });
});

describe("bet-triggered line refreshes", () => {
  const claim = async (user: string | null) => (await db.q(service, "select public.claim_bet_refresh_internal(120, $1) as r", [user]))[0].r as string;
  const later = () => db.su("update public.league_settings set bet_refresh_claimed_at = now() - interval '3 minutes'");
  it("allow one per member every 10 minutes", async () => {
    expect(await claim(alice)).toBe("claimed");
    await later();
    expect(await claim(alice)).toBe("limit");
    expect(await claim(bob)).toBe("claimed");
  });
  it("and a set number a day in all", async () => {
    await db.su("update public.league_settings set bet_refresh_daily_cap = 3");
    await later();
    expect(await claim(null)).toBe("claimed");
    await later();
    expect(await claim(null)).toBe("limit");
    await db.su("update public.league_settings set bet_refresh_daily_cap = 200");
  });
});

describe("resending a bet", () => {
  const ref = "0a4f5c2e-0000-4000-8000-000000000009";
  const args = () => ({
    entry: aliceEntry, user: alice, type: "straight" as const, stakeCents: 10_000, potentialPayoutCents: 19_091,
    legs: [{ gameId: ids.EARLY!, market: "spread", side: "away", point: 3, price: -110 }], clientRef: ref,
  });
  it("with the same id but a different stake is refused", async () => {
    await place(db, args());
    await fails(place(db, { ...args(), stakeCents: 20_000, potentialPayoutCents: 38_182 }), "client_ref_conflict");
  });
  it("whose bet was undone is refused, so the site sends it as a new bet", async () => {
    const [{ id }] = await db.su("select id from public.slips where client_ref = $1", [ref]);
    await db.q(member(alice), "select public.undo_slip($1)", [id]);
    await fails(place(db, args()), "client_ref_used");
  });
});

describe("managers", () => {
  it("whoever placed a bet always sees it, even after being removed and re-added as a manager", async () => {
    const id = await straight("MINE");
    // With a bet riding, a new manager goes on before the old one comes off.
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [aliceEntry, bob]);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [aliceEntry, alice]);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [aliceEntry, alice]);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [aliceEntry, bob]);
    expect((await db.q(member(alice), "select id from public.slips where id = $1", [id])).length).toBe(1);
    expect((await db.q(member(alice), "select leg_no from public.slip_legs where slip_id = $1", [id])).length).toBe(1);
  });

  it("the log names the member and the entry when managers change", async () => {
    const [log] = await db.q(member(bob), "select after from public.audit_log where action = 'manager_added' order by id desc limit 1");
    expect(log.after).toMatchObject({ member: "Alice", entry: "Alice" });
  });
});
