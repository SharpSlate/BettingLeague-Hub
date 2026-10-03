// What the third review found, each reproduced against its fix: feed start times that
// take two readings to stick, scores for a game an admin moved later, closing a season
// with no week open, manager changes while bets are riding, the bet-refresh limits, a
// resent bet with different picks, and a week's minimum redone after the week closed.
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
  type Db,
  type Event,
} from "./db.ts";

let db: Db;
let owner: string, owner2: string, alice: string, bob: string, erin: string;
let aliceEntry: string, bobEntry: string, erinEntry: string;
const board: Event[] = [];
const ids: Record<string, string> = {};

const GAMES: [id: string, hours: number, home: string, away: string][] = [
  ["TWO", 3, "Kansas City Chiefs", "Buffalo Bills"],
  ["BACK", 3, "Baltimore Ravens", "Pittsburgh Steelers"],
  ["PAST2", 3, "Dallas Cowboys", "New York Giants"],
  ["LATER", 0.4, "Detroit Lions", "Green Bay Packers"],
  ["QUIET", 3, "Miami Dolphins", "New York Jets"],
  ["RESCH", 2, "San Francisco 49ers", "Los Angeles Rams"],
  ["ADM", 3, "Atlanta Falcons", "Carolina Panthers"],
  ["REF", 4, "Philadelphia Eagles", "Washington Commanders"],
  ["WA", 2, "Seattle Seahawks", "Arizona Cardinals"],
  ["WB", 2, "Denver Broncos", "Las Vegas Raiders"],
  ["NEXT", 24 * 6, "Chicago Bears", "Minnesota Vikings"],
];
const commence = (id: string, at: Date) => {
  board.find((e) => e.id === id)!.commenceTime = at.toISOString();
};
const pull = () => ingest(db, board);
const game = async (id: string) =>
  (await db.su("select status, kickoff_at, feed_kickoff, rescheduled_at, kickoff_at <= now() as started from public.games where id = $1", [ids[id]]))[0];
const scores = (rows: unknown[]) => db.q(service, "select public.ingest_scores_internal('schedule', $1::jsonb, 2, 90000)", [JSON.stringify(rows)]);
const leg = (id: string, side: "home" | "away" = "home") => ({ gameId: ids[id]!, market: "spread", side, point: side === "home" ? -3 : 3, price: -110 });
const bet = (entry: string, user: string, id: string, stakeCents = 10_000) =>
  place(db, { entry, user, type: "straight", stakeCents, potentialPayoutCents: Math.floor(stakeCents * 1.9091), legs: [leg(id)] });
const legsSeenBy = async (user: string, id: string) =>
  (await db.q(member(user), "select count(*)::int as n from public.slip_legs where game_id = $1", [ids[id]]))[0].n;
const available = async (entry: string) => Number((await db.su("select app.available_cents($1) as a", [entry]))[0].a);

beforeAll(async () => {
  db = await freshDb("bl_review3");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  owner2 = await makeUser(db, "owner2@example.com", "Second Admin");
  alice = await makeUser(db, "alice@example.com", "Alice");
  bob = await makeUser(db, "bob@example.com", "Bob");
  erin = await makeUser(db, "erin@example.com", "Erin");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  await makeLeague(db, owner);
  await db.q(member(owner), "select public.admin_set_admin($1, true)", [owner2]);
  await makeCommissioner(db, owner2);
  const entry = async (name: string, user: string) => {
    const id = (await db.q(member(owner), "select public.admin_add_entry($1, 1000000) as id", [name]))[0].id as string;
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [id, user]);
    return id;
  };
  aliceEntry = await entry("Alice", alice);
  bobEntry = await entry("Bob", bob);
  erinEntry = await entry("Erin", erin);
  for (const [id, hours, home, away] of GAMES) {
    board.push(event(id, hoursFromNow(hours), home, away, [{ book: "draftkings", outcomes: standardLines(-3) }]));
  }
  await pull();
  for (const [id] of GAMES) ids[id] = await gameId(db, id);
});
afterAll(async () => db?.close());

describe("closing the season", () => {
  it("with no week open is refused, rather than opening one", async () => {
    await fails(db.q(member(owner), "select public.admin_close_season(null, 'Season over')"), "no_open_week");
    expect((await db.su("select count(*)::int as n from public.league_weeks where status = 'open'"))[0].n).toBe(0);
    await db.q(member(owner), "select public.admin_open_next_week(null, 'Start')");
  });
});

describe("start times from the feed", () => {
  it("a new time takes two pulls in a row to stick", async () => {
    const before = (await game("TWO")).kickoff_at as Date;
    const later = hoursFromNow(5);
    commence("TWO", later);
    await pull();
    let g = await game("TWO");
    expect((g.kickoff_at as Date).getTime()).toBe(before.getTime());
    expect((g.feed_kickoff as Date).getTime()).toBe(later.getTime());
    await pull();
    g = await game("TWO");
    expect((g.kickoff_at as Date).getTime()).toBe(later.getTime());
    expect(g.feed_kickoff).toBeNull();
  });

  it("one odd reading is forgotten when the feed goes back to the league's time", async () => {
    const original = board.find((e) => e.id === "BACK")!.commenceTime;
    commence("BACK", hoursFromNow(8));
    await pull();
    expect((await game("BACK")).feed_kickoff).not.toBeNull();
    board.find((e) => e.id === "BACK")!.commenceTime = original;
    await pull();
    const g = await game("BACK");
    expect(g.feed_kickoff).toBeNull();
    expect((g.kickoff_at as Date).toISOString()).toBe(original);
  });

  it("even two readings in a row of a start already past don't show the picks of a game hours away", async () => {
    await bet(aliceEntry, alice, "PAST2");
    commence("PAST2", new Date(Date.now() - 60_000));
    await pull();
    await pull();
    expect((await game("PAST2")).started).toBe(false);
    expect(await legsSeenBy(bob, "PAST2")).toBe(0);
  });

  it("an admin's kickoff change clears a reading waiting for its second pull", async () => {
    commence("ADM", hoursFromNow(9));
    await pull();
    expect((await game("ADM")).feed_kickoff).not.toBeNull();
    const to = hoursFromNow(10);
    await db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', $2, 'Flexed')", [ids.ADM, to.toISOString()]);
    expect((await game("ADM")).feed_kickoff).toBeNull();
    commence("ADM", to);
  });

  it("a postponed game set back to scheduled drops the time it was rescheduled to", async () => {
    await db.q(member(owner), "select public.admin_set_game_status($1, 'postponed', null, 'Weather')", [ids.RESCH]);
    const newTime = hoursFromNow(26);
    commence("RESCH", newTime);
    await pull();
    expect(((await game("RESCH")).rescheduled_at as Date).getTime()).toBe(newTime.getTime());
    await db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', $2, 'Back on at the new time')", [ids.RESCH, newTime.toISOString()]);
    expect(await game("RESCH")).toMatchObject({ status: "scheduled", rescheduled_at: null, feed_kickoff: null });
  });
});

describe("scores", () => {
  it("count for a game an admin moved later when the feed has it starting now, and betting on it closes", async () => {
    await db.q(member(owner), "select public.admin_set_game_status($1, 'scheduled', $2, 'Moved by mistake')", [ids.LATER, hoursFromNow(3).toISOString()]);
    // The feed still has the game at its original time, 25 minutes out, and it's under way.
    await scores([{ id: "LATER", completed: false, homeScore: 7, awayScore: 3 }]);
    expect(await game("LATER")).toMatchObject({ status: "live", started: true });
    await fails(bet(bobEntry, bob, "LATER"), "game_started");
  });

  it("are still ignored for a game both the league and the feed have hours away", async () => {
    await scores([{ id: "QUIET", completed: false, homeScore: 7, awayScore: 3 }]);
    expect(await game("QUIET")).toMatchObject({ status: "scheduled", started: false });
  });
});

describe("managers while bets are riding", () => {
  it("an entry's last manager can't be removed", async () => {
    // Alice has a bet riding on PAST2.
    await fails(db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [aliceEntry, alice]), "last_manager");
  });

  it("an admin can't add themselves, even to an entry left with no manager; another admin can", async () => {
    await db.su("delete from public.entry_managers where entry_id = $1", [aliceEntry]);
    await fails(db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [aliceEntry, owner]), "self_add_blocked");
    await db.q(member(owner2), "select public.admin_set_manager($1, $2, true)", [aliceEntry, owner]);
    // Put Alice back and take the admin off again.
    await db.q(member(owner2), "select public.admin_set_manager($1, $2, true)", [aliceEntry, alice]);
    await db.q(member(owner2), "select public.admin_set_manager($1, $2, false)", [aliceEntry, owner]);
    expect((await db.su("select user_id from public.entry_managers where entry_id = $1", [aliceEntry])).map((r) => r.user_id)).toEqual([alice]);
  });

  it("with nothing riding, the last manager can come off", async () => {
    const spare = (await db.q(member(owner), "select public.admin_add_entry('Spare', 0) as id"))[0].id;
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [spare, bob]);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [spare, bob]);
  });
});

describe("bet-triggered line refreshes", () => {
  const claim = async (user: string | null) => (await db.q(service, "select public.claim_bet_refresh_internal(120, $1) as r", [user]))[0].r as string;
  const later = () => db.su("update public.league_settings set bet_refresh_claimed_at = now() - interval '3 minutes'");
  it("say why a bet didn't get one, and cap each member's refreshes a day", async () => {
    await db.su("update public.league_settings set bet_refresh_member_minutes = 0, bet_refresh_member_daily_cap = 2");
    expect(await claim(alice)).toBe("claimed");
    expect(await claim(bob)).toBe("recent");
    await later();
    expect(await claim(alice)).toBe("claimed");
    await later();
    expect(await claim(alice)).toBe("limit");
    expect(await claim(bob)).toBe("claimed");
    await db.su("update public.league_settings set bet_refresh_member_minutes = 5, bet_refresh_member_daily_cap = 20");
  });
});

describe("resending a bet", () => {
  const ref = "0a4f5c2e-0000-4000-8000-00000000000a";
  const args = (legs: ReturnType<typeof leg>[]) => ({
    entry: aliceEntry, user: alice, type: "straight" as const, stakeCents: 10_000, potentialPayoutCents: 19_091, legs, clientRef: ref,
  });
  it("with the same id and picks gets the bet back; with other picks it's refused", async () => {
    const id = await place(db, args([leg("REF")]));
    expect(await place(db, args([leg("REF")]))).toBe(id);
    await fails(place(db, args([leg("REF", "away")])), "client_ref_conflict");
    await fails(place(db, args([leg("BACK")])), "client_ref_conflict");
    expect((await db.su("select count(*)::int as n from public.slips where client_ref = $1", [ref]))[0].n).toBe(1);
  });
});

describe("rules", () => {
  it("with a number missing are refused", async () => {
    const doc = { ...DAY_ONE_RULES, weeklyMinimum: { ...DAY_ONE_RULES.weeklyMinimum, pct: null } };
    await fails(db.q(service, "select public.publish_rule_set_internal($1, (select id from public.leagues), $2::jsonb, 6, 'typo')", [owner, JSON.stringify(doc)]), "bad_rules");
    const doc2 = { ...DAY_ONE_RULES, undoMinutes: "5" };
    await fails(db.q(service, "select public.publish_rule_set_internal($1, (select id from public.leagues), $2::jsonb, 6, 'typo')", [owner, JSON.stringify(doc2)]), "bad_rules");
  });
});

describe("the minimum of a week that has closed", () => {
  const weekStatus = async () =>
    (await db.su("select wagered_cents::int as wagered, shortfall_cents::int as short, deducted_cents::int as deducted from public.week_entry_status where week = 4 and entry_id = $1", [erinEntry]))[0];
  it("keeps a shortfall waived for lack of funds waived when a bet in the week changes later", async () => {
    // Erin must wager 3,000 of her 10,000 units. She bets 1,000 and 500, both lose, and
    // an adjustment leaves her 100 units when the week closes: 1,500 short, 100 taken.
    const a = await bet(erinEntry, erin, "WA", 100_000);
    const b = await bet(erinEntry, erin, "WB", 50_000);
    await db.q(member(owner), "select public.admin_adjust_bank($1, -840000, 'Settling a side bet')", [erinEntry]);
    await db.su("update public.games set kickoff_at = now() - interval '3 hours' where id in ($1, $2)", [ids.WA, ids.WB]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 20, 27, 'Feed down')", [ids.WA]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 20, 27, 'Feed down')", [ids.WB]);
    for (const id of [a, b]) await db.q(service, "select public.settle_slip_internal($1, 'lost', 0, '[]')", [id]);
    expect((await db.q(member(owner), "select public.admin_open_next_week(4, 'Closing early') as w"))[0].w).toBe(5);
    expect(await weekStatus()).toEqual({ wagered: 150_000, short: 150_000, deducted: 10_000 });
    expect(await available(erinEntry)).toBe(0);

    // Later she has units again, and an admin voids her 500-unit bet. Its stake comes back
    // and, no longer counting, is added to the shortfall; the 1,400 waived stays waived.
    await db.q(member(owner), "select public.admin_adjust_bank($1, 500000, 'Bonus')", [erinEntry]);
    await db.q(member(owner), "select public.admin_void_slip($1, 'Placed in error')", [b]);
    expect(await weekStatus()).toEqual({ wagered: 100_000, short: 200_000, deducted: 60_000 });
    expect(await available(erinEntry)).toBe(500_000);
  });
});
