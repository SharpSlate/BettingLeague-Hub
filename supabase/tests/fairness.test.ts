// The fairness rules added after the owner's "can a player take advantage?" review:
// no betting both sides of a game across separate bets (it met the weekly minimum for
// the cost of the vig), and no undoing a bet once its line has moved (undo was a free
// option on news).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UndoRefresh } from "../functions/_shared/jobs.ts";
import { DAY_ONE_RULES } from "../functions/_shared/rules/index.ts";
import { undoSlips } from "../functions/_shared/undo.ts";
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
  undo,
  type Db,
  type Event,
  type Outcome,
} from "./db.ts";

let db: Db;
let owner: string, alice: string, bob: string;
let aliceEntry: string, bobEntry: string;
const board: Event[] = [];
const ids: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GAMES: [id: string, hours: number, home: string, away: string][] = [
  ["SIDES", 5, "Baltimore Ravens", "Pittsburgh Steelers"],
  ["TOTALS", 5, "Kansas City Chiefs", "Buffalo Bills"],
  ["OTHER", 5, "Dallas Cowboys", "New York Giants"],
  ["RACE", 5, "Seattle Seahawks", "Arizona Cardinals"],
  ["UNDO1", 5, "Chicago Bears", "Minnesota Vikings"],
  ["UNDO2", 5, "Detroit Lions", "Green Bay Packers"],
  ["UNDO3", 5, "Miami Dolphins", "New York Jets"],
  ["FLAG", 5, "Houston Texans", "Tennessee Titans"],
  ["PROBE", 5, "Denver Broncos", "Las Vegas Raiders"],
  ["TEASE1", 5, "Atlanta Falcons", "Carolina Panthers"],
  ["TEASE2", 5, "New Orleans Saints", "Tampa Bay Buccaneers"],
  ["LATE", 5, "Cleveland Browns", "Cincinnati Bengals"],
  ["IDS", 5, "Los Angeles Rams", "San Francisco 49ers"],
  ["STALE", 5, "Philadelphia Eagles", "Washington Commanders"],
];

type Pick = { id: string; market: "spread" | "total" | "moneyline"; side: string };
const leg = ({ id, market, side }: Pick) => ({
  gameId: ids[id]!,
  market,
  side,
  point: market === "moneyline" ? null : market === "total" ? 47.5 : side === "home" ? -3 : 3,
  price: market === "moneyline" ? (side === "home" ? -150 : 130) : -110,
});
const bet = (entry: string, user: string, p: Pick) =>
  place(db, { entry, user, type: "straight", stakeCents: 10_000, potentialPayoutCents: 30_000, legs: [leg(p)] });
/** Rule versions are append-only; the tests change one in place to skip waiting a week. */
const setRule = (path: string, value: unknown) =>
  db.su(`do $$ begin
    alter table public.rule_sets disable trigger user;
    update public.rule_sets set document = jsonb_set(document, '${path}', '${JSON.stringify(value)}') where version = 1;
    alter table public.rule_sets enable trigger user;
  end $$`);
/** The feed's next reading of one game. */
const reprice = (id: string, outcomes: Outcome[]) => {
  board.find((e) => e.id === id)!.books = [{ book: "draftkings", outcomes }];
  return ingest(db, board);
};

beforeAll(async () => {
  db = await freshDb("bl_fairness");
  await centerOnWeek4(db);
  owner = await makeUser(db, "owner@example.com", "Owner");
  alice = await makeUser(db, "alice@example.com", "Alice");
  bob = await makeUser(db, "bob@example.com", "Bob");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  const entry = async (name: string, user: string) => {
    const id = (await db.q(member(owner), "select public.admin_add_entry($1, 1000000) as id", [name]))[0].id as string;
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [id, user]);
    return id;
  };
  aliceEntry = await entry("Alice", alice);
  bobEntry = await entry("Bob", bob);
  for (const [id, hours, home, away] of GAMES) {
    board.push(event(id, hoursFromNow(hours), home, away, [{ book: "draftkings", outcomes: standardLines(-3) }]));
  }
  await ingest(db, board);
  for (const [id] of GAMES) ids[id] = await gameId(db, id);
  await db.q(member(owner), "select public.admin_open_next_week(null, 'Start')");
});
afterAll(async () => db?.close());

describe("both sides of a game across separate bets", () => {
  let under: string;
  it("an entry can't take the other team, by spread or moneyline, once it has a side", async () => {
    await bet(aliceEntry, alice, { id: "SIDES", market: "spread", side: "home" });
    await fails(bet(aliceEntry, alice, { id: "SIDES", market: "spread", side: "away" }), "opposite_side");
    await fails(bet(aliceEntry, alice, { id: "SIDES", market: "moneyline", side: "away" }), "opposite_side");
  });

  it("the same team again, or the game's total, is fine", async () => {
    await bet(aliceEntry, alice, { id: "SIDES", market: "moneyline", side: "home" });
    await bet(aliceEntry, alice, { id: "SIDES", market: "total", side: "over" });
  });

  it("the over and the under of one game can't both be bet", async () => {
    under = await bet(aliceEntry, alice, { id: "TOTALS", market: "total", side: "under" });
    await fails(bet(aliceEntry, alice, { id: "TOTALS", market: "total", side: "over" }), "opposite_side");
  });

  it("a leg of a parlay or teaser counts too", async () => {
    const parlay = (entry: string, user: string, picks: Pick[]) =>
      place(db, { entry, user, type: "parlay", stakeCents: 10_000, potentialPayoutCents: 36_000, legs: picks.map(leg) });
    await fails(parlay(aliceEntry, alice, [{ id: "OTHER", market: "spread", side: "home" }, { id: "SIDES", market: "spread", side: "away" }]), "opposite_side");
    await parlay(aliceEntry, alice, [{ id: "OTHER", market: "spread", side: "home" }, { id: "RACE", market: "spread", side: "home" }]);
    await fails(bet(aliceEntry, alice, { id: "OTHER", market: "moneyline", side: "away" }), "opposite_side");
  });

  it("another entry isn't affected", async () => {
    await bet(bobEntry, bob, { id: "SIDES", market: "spread", side: "away" });
  });

  it("an undone bet frees the other side", async () => {
    await undo(db, under, alice);
    await bet(aliceEntry, alice, { id: "TOTALS", market: "total", side: "over" });
  });

  it("two bets on opposite sides placed at the same moment: only one goes in", async () => {
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role service_role");
      await place(db, { entry: bobEntry, user: bob, type: "straight", stakeCents: 10_000, potentialPayoutCents: 30_000, legs: [leg({ id: "RACE", market: "spread", side: "home" })] }, c);
      const other = bet(bobEntry, bob, { id: "RACE", market: "spread", side: "away" }).then(() => "placed", (e: Error) => e.message);
      await sleep(300);
      await c.query("commit");
      expect(await other).toContain("opposite_side");
    } finally {
      c.release();
    }
  });

  it("the commissioner can allow it", async () => {
    await setRule("{acrossBets,oppositeSides}", true);
    try {
      await bet(aliceEntry, alice, { id: "TOTALS", market: "total", side: "under" });
    } finally {
      await setRule("{acrossBets,oppositeSides}", false);
    }
  });

  it("a manager added after a bet can't find its side by trying the other one", async () => {
    // Bets placed before a manager joined stay hidden from them until kickoff, so the
    // other side isn't refused for them (the entry can end up on both sides this way).
    const commish = await makeUser(db, "commish@example.com", "Commish");
    await db.q(member(owner), "select public.admin_set_admin($1, true)", [commish]);
    await bet(aliceEntry, alice, { id: "PROBE", market: "spread", side: "home" });
    await db.q(member(commish), "select public.admin_set_manager($1, $2, true)", [aliceEntry, owner]);
    await bet(aliceEntry, owner, { id: "PROBE", market: "moneyline", side: "away" });
    // Alice sees both bets, so she's held to the rule.
    await fails(bet(aliceEntry, alice, { id: "PROBE", market: "spread", side: "away" }), "opposite_side");
    await db.q(member(commish), "select public.admin_set_manager($1, $2, false)", [aliceEntry, owner]);
  });

  it("a game id written differently is still the same game", async () => {
    await bet(aliceEntry, alice, { id: "IDS", market: "spread", side: "home" });
    const odd = ids.IDS!.replace(/-/g, "").toUpperCase();
    await fails(place(db, {
      entry: aliceEntry, user: alice, type: "straight", stakeCents: 10_000, potentialPayoutCents: 30_000,
      legs: [{ gameId: odd, market: "spread", side: "away", point: 3, price: -110 }],
    }), "opposite_side");
  });

  it("when picks show as they're placed, a late manager is held to the bets they can see", async () => {
    await setRule("{visibility}", "on_placement");
    try {
      const erin = await makeUser(db, "erin@example.com", "Erin");
      await bet(bobEntry, bob, { id: "LATE", market: "spread", side: "home" });
      await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [bobEntry, erin]);
      await fails(bet(bobEntry, erin, { id: "LATE", market: "spread", side: "away" }), "opposite_side");
      await db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [bobEntry, erin]);
    } finally {
      await setRule("{visibility}", "kickoff_per_leg");
    }
  });

  it("the bet service can ask which legs would be refused before it pulls lines", async () => {
    const conflicts = (entry: string, user: string, picks: Pick[]) =>
      db.q(service, "select public.opposite_side_legs_internal($1, $2, $3::jsonb) as legs", [entry, user, JSON.stringify(picks.map(leg))]).then((r) => r[0].legs);
    // Alice has the home side of SIDES riding, and nothing on UNDO2.
    expect(await conflicts(aliceEntry, alice, [{ id: "UNDO2", market: "spread", side: "away" }, { id: "SIDES", market: "moneyline", side: "away" }])).toEqual([1]);
    expect(await conflicts(bobEntry, bob, [{ id: "SIDES", market: "moneyline", side: "home" }])).toEqual([0]);
    expect(await conflicts(aliceEntry, alice, [{ id: "SIDES", market: "spread", side: "home" }])).toEqual([]);
  });

  it("rules missing the setting, or the undo one, can't be published", async () => {
    const publish = (doc: unknown) => db.q(service, "select public.publish_rule_set_internal($1, $2::jsonb, 6, 'typo')", [owner, JSON.stringify(doc)]);
    await fails(publish({ ...DAY_ONE_RULES, acrossBets: {} }), "bad_rules");
    await fails(publish({ ...DAY_ONE_RULES, acrossBets: { oppositeSides: "no" } }), "bad_rules");
    const { undoAfterLineMove: _, ...noUndoSetting } = DAY_ONE_RULES;
    await fails(publish(noUndoSetting), "bad_rules");
  });
});

describe("undo", () => {
  const spread = (id: string) => bet(bobEntry, bob, { id, market: "spread", side: "home" });

  it("goes through the site's bet service: members can't call it themselves", async () => {
    const id = await spread("UNDO1");
    await fails(db.q(member(bob), "select public.undo_slip_internal($1, $2)", [id, bob]), "permission denied");
    await undo(db, id, bob);
  });

  it("is refused once the bet's number has moved", async () => {
    const id = await spread("UNDO1");
    await reprice("UNDO1", standardLines(-3.5));
    await fails(undo(db, id, bob), "undo_line_moved");
  });

  it("or its price has", async () => {
    const id = await bet(bobEntry, bob, { id: "UNDO2", market: "moneyline", side: "home" });
    await reprice("UNDO2", standardLines(-3, 47.5, -155, 135));
    await fails(undo(db, id, bob), "undo_line_moved");
  });

  it("or the line has come off the board", async () => {
    const id = await bet(bobEntry, bob, { id: "UNDO3", market: "total", side: "over" });
    await reprice("UNDO3", standardLines().filter((o) => o.market !== "total"));
    await fails(undo(db, id, bob), "undo_line_moved");
    await reprice("UNDO3", standardLines());
  });

  it("a flat-priced spread keeps its flat price, so only its number counts", async () => {
    await setRule("{pricing,straight}", "flat");
    try {
      const id = await bet(bobEntry, bob, { id: "UNDO3", market: "spread", side: "home" });
      const juiced = standardLines().map((o) => (o.market === "spread" ? { ...o, price: -120 } : o));
      await reprice("UNDO3", juiced);
      await undo(db, id, bob);
    } finally {
      await setRule("{pricing,straight}", "book");
    }
  });

  it("a teaser's undo looks only at its numbers, since the table pays it", async () => {
    const id = await place(db, {
      entry: bobEntry, user: bob, type: "teaser", teaserPoints: 6, stakeCents: 10_000, potentialPayoutCents: 19_091,
      legs: [
        { gameId: ids.TEASE1!, market: "spread", side: "home", point: -3, price: -110 },
        { gameId: ids.TEASE2!, market: "spread", side: "home", point: -3, price: -110 },
      ],
    });
    await reprice("TEASE1", standardLines().map((o) => (o.market === "spread" ? { ...o, price: -115 } : o)));
    await undo(db, id, bob);
  });

  it("checks everything but the lines first, changing nothing, and gives the time the lines must be fetched after", async () => {
    const id = await spread("UNDO2");
    const check = await db.q(service, "select public.undo_slip_internal($1, $2, true) as since", [id, bob]);
    expect(check[0].since).toBeInstanceOf(Date);
    expect((await db.su("select status from public.slips where id = $1", [id]))[0].status).toBe("pending");
    // No time when the rules allow undo after a move: the lines aren't checked.
    await setRule("{undoAfterLineMove}", true);
    try {
      expect((await db.q(service, "select public.undo_slip_internal($1, $2, true) as since", [id, bob]))[0].since).toBeNull();
    } finally {
      await setRule("{undoAfterLineMove}", false);
    }
    await fails(db.q(service, "select public.undo_slip_internal($1, $2, true)", [id, alice]), "not_found");
    await setRule("{undoMinutes}", 0);
    try {
      await fails(db.q(service, "select public.undo_slip_internal($1, $2, true)", [id, bob]), "undo_window_passed");
    } finally {
      await setRule("{undoMinutes}", 5);
    }
  });

  it("gets its own line pull every time, within the daily limits", async () => {
    const claim = (undo: boolean) => db.q(service, "select public.claim_bet_refresh_internal(120, $1, $2) as r", [bob, undo]).then((r) => r[0].r as string);
    await db.su("delete from public.bet_refreshes; update public.league_settings set bet_refresh_claimed_at = null");
    expect(await claim(false)).toBe("claimed");
    // A bet right after shares that refresh. An undo can't: its lines have to come from
    // a pull that went out after it was asked for.
    expect(await claim(false)).toBe("recent");
    expect(await claim(true)).toBe("claimed");
    expect(await claim(true)).toBe("claimed");
    // Nor is it held to the member's 5 minutes between refreshes, which a bet is.
    await db.su("update public.league_settings set bet_refresh_claimed_at = now() - interval '3 minutes'");
    expect(await claim(false)).toBe("limit");
    await db.su("update public.league_settings set bet_refresh_member_daily_cap = 3");
    expect(await claim(true)).toBe("limit");
    await db.su("update public.league_settings set bet_refresh_member_daily_cap = 20");
  });

  it("the commissioner can allow undo after a move", async () => {
    await reprice("UNDO1", standardLines(-3.5));
    const id = await place(db, {
      entry: bobEntry, user: bob, type: "straight", stakeCents: 10_000, potentialPayoutCents: 30_000,
      legs: [{ gameId: ids.UNDO1!, market: "spread", side: "home", point: -3.5, price: -110 }],
    });
    await reprice("UNDO1", standardLines(-4));
    await setRule("{undoAfterLineMove}", true);
    try {
      await undo(db, id, bob);
    } finally {
      await setRule("{undoAfterLineMove}", false);
    }
  });
});

describe("an undo's lines", () => {
  const ask = async (id: string) => (await db.q(service, "select public.undo_slip_internal($1, $2, true) as since", [id, bob]))[0].since as Date;
  const undoAt = (id: string, since: Date | null) => db.q(service, "select public.undo_slip_internal($1, $2, false, $3)", [id, bob, since]);
  /** A pull of the same board, as if its request went out at fetchedAfter. */
  const pullAt = (fetchedAfter: Date | null) =>
    db.q(service, "select public.ingest_lines_internal('bet', $1::jsonb, 3, 90000, $2)", [JSON.stringify(board), fetchedAfter]);
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
  const stale = () => bet(bobEntry, bob, { id: "STALE", market: "spread", side: "home" });

  it("must come from a pull whose request went out after the undo was asked for", async () => {
    const id = await stale();
    const since = await ask(id);
    await fails(undoAt(id, null), "undo_lines_stale");
    // The board's lines are from a pull with no time on it (as older rows have), then
    // from one that went out before the undo was asked for: both refused.
    await pullAt(null);
    await fails(undoAt(id, since), "undo_lines_stale");
    await pullAt(plus(since, -1000));
    await fails(undoAt(id, since), "undo_lines_stale");
    await pullAt(plus(since, 5));
    await undoAt(id, since);
  });

  it("an older pull landing after the undo's own puts the board back, so it waits for another", async () => {
    const id = await stale();
    const since = await ask(id);
    await pullAt(plus(since, 5)); // the undo's own pull
    await pullAt(plus(since, -2000)); // a bet's pull that went out earlier lands last
    await fails(undoAt(id, since), "undo_lines_stale");
    await pullAt(plus(since, 10));
    await undoAt(id, since);
  });

  it("the time has to be from the last two minutes, and not ahead of the clock", async () => {
    const id = await stale();
    const old = plus(await ask(id), -3 * 60_000);
    await pullAt(plus(old, 5));
    await fails(undoAt(id, old), "undo_lines_stale");
    const ahead = plus(new Date(), 60_000);
    await pullAt(ahead);
    await fails(undoAt(id, ahead), "undo_lines_stale");
    const since = await ask(id);
    await pullAt(plus(since, 5));
    await undoAt(id, since);
  });
});

describe("undoing through the bet service", () => {
  // The place-slip function's undo, run against the database: calls made the way
  // PostgREST makes them (named arguments, answers as text), and a pull that stores the
  // board as it stands when the pull goes out.
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    try {
      const sql = `select (public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}))::text as r`;
      return { data: (await db.q(service, sql, keys.map((k) => args[k])))[0].r as unknown, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };
  let pulls = 0;
  const pull = (answer: UndoRefresh = "ok", outcomes?: Outcome[]) => async (): Promise<UndoRefresh> => {
    pulls++;
    if (answer !== "ok") return answer;
    if (outcomes) board.find((e) => e.id === "STALE")!.books = [{ book: "draftkings", outcomes }];
    await db.q(service, "select public.ingest_lines_internal('bet', $1::jsonb, 3, 90000, public.db_now_internal())", [JSON.stringify(board)]);
    return "ok";
  };
  const stale = () => bet(bobEntry, bob, { id: "STALE", market: "spread", side: "home" });

  it("sees news that moved the line since the bet, however fresh the bet's own lines were", async () => {
    await reprice("STALE", standardLines()); // lines seconds old, as a bet's own refresh leaves them
    const id = await stale();
    pulls = 0;
    expect(await undoSlips(rpc, bob, [id], pull("ok", standardLines(-4)))).toEqual([
      { slipId: id, undone: false, error: "undo_line_moved", message: expect.stringContaining("has moved") },
    ]);
    expect(pulls).toBe(1);
    await reprice("STALE", standardLines());
  });

  it("pulls once for all the bets in a request, and answers for each in order", async () => {
    const mine = [await stale(), await stale()];
    const alices = await bet(aliceEntry, alice, { id: "STALE", market: "total", side: "over" });
    pulls = 0;
    expect(await undoSlips(rpc, bob, [mine[0]!, alices, mine[1]!], pull())).toEqual([
      { slipId: mine[0], undone: true },
      { slipId: alices, undone: false, error: "not_found", message: expect.any(String) },
      { slipId: mine[1], undone: true },
    ]);
    expect(pulls).toBe(1);
  });

  it("a bet that can't be undone anyway costs no pull", async () => {
    const id = await stale();
    await undoSlips(rpc, bob, [id], pull());
    pulls = 0;
    expect(await undoSlips(rpc, bob, [id], pull())).toEqual([{ slipId: id, undone: false, error: "not_pending", message: expect.any(String) }]);
    expect(pulls).toBe(0);
  });

  it("when the lines can't be pulled, the bet stays, with why", async () => {
    const id = await stale();
    for (const [answer, code] of [["limit", "undo_refresh_limit"], ["credit_floor", "undo_credit_floor"], ["failed", "undo_lines_stale"]] as const) {
      expect((await undoSlips(rpc, bob, [id], pull(answer)))[0]).toMatchObject({ undone: false, error: code });
    }
    expect((await db.su("select status from public.slips where id = $1", [id]))[0].status).toBe("pending");
    // Unless the rules allow undo after a move: then there's nothing to pull for.
    await setRule("{undoAfterLineMove}", true);
    try {
      pulls = 0;
      expect(await undoSlips(rpc, bob, [id], pull("failed"))).toEqual([{ slipId: id, undone: true }]);
      expect(pulls).toBe(0);
    } finally {
      await setRule("{undoAfterLineMove}", false);
    }
  });
});

describe("line pulls near kickoff", () => {
  const soon = async (hours: number) => (await db.q(service, "select public.games_starting_soon_internal(now(), $1) as n", [hours]))[0].n as number;
  it("count the scheduled games that lock for betting within the window", async () => {
    expect(await soon(3)).toBe(0);
    expect(await soon(6)).toBe(GAMES.length);
    await db.su("update public.games set kickoff_at = now() + interval '2 hours' where id = $1", [ids.RACE]);
    // A game the feed shows starting earlier locks earlier, so it counts from then.
    await db.su("update public.games set feed_commence = now() + interval '1 hour' where id = $1", [ids.OTHER]);
    expect(await soon(3)).toBe(2);
    // Games already under way, or postponed, don't.
    await db.su("update public.games set status = 'postponed' where id = $1", [ids.OTHER]);
    await db.su("update public.games set kickoff_at = now() - interval '5 minutes' where id = $1", [ids.RACE]);
    expect(await soon(3)).toBe(0);
  });
});

describe("entries that share a manager betting against each other", () => {
  let dana: string, one: string, two: string, danaBet: string;
  const flags = async () =>
    (await db.q(member(owner), "select error from public.admin_recent_problems(50) where kind = 'fair_play'")).map((r) => r.error as string);

  it("are flagged for the admins once both picks are public, and not before", async () => {
    dana = await makeUser(db, "dana@example.com", "Dana");
    const entry = async (name: string) => {
      const id = (await db.q(member(owner), "select public.admin_add_entry($1, 1000000) as id", [name]))[0].id as string;
      await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [id, dana]);
      return id;
    };
    one = await entry("Dana One");
    two = await entry("Dana Two");
    danaBet = await bet(one, dana, { id: "FLAG", market: "spread", side: "home" });
    await bet(two, dana, { id: "FLAG", market: "moneyline", side: "away" });
    // Alice and Bob share no manager, so their opposite sides aren't a flag.
    await bet(aliceEntry, alice, { id: "FLAG", market: "total", side: "over" });
    await bet(bobEntry, bob, { id: "FLAG", market: "total", side: "under" });
    expect(await flags()).toEqual([]);
    await db.su("update public.games set kickoff_at = now() - interval '1 minute' where id = $1", [ids.FLAG]);
    expect(await flags()).toEqual(["Dana One and Dana Two, which share a manager (Dana), took opposite sides of Titans at Texans."]);
  });

  it("members can't read the list", async () => {
    await fails(db.q(member(alice), "select * from public.admin_recent_problems(50)"), "admin_only");
  });

  it("counts a manager only if they managed both entries when the bets were placed", async () => {
    const zed = await makeUser(db, "zed@example.com", "Zed");
    // Alice and Bob took opposite sides of FLAG's total before Zed managed either entry.
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [aliceEntry, zed]);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [bobEntry, zed]);
    expect(await flags()).toEqual(["Dana One and Dana Two, which share a manager (Dana), took opposite sides of Titans at Texans."]);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [aliceEntry, zed]);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [bobEntry, zed]);
  });

  it("the same pull failure again and again shows once, so it can't crowd out the flag", async () => {
    for (let i = 0; i < 12; i++) {
      await db.q(service, "select public.record_pull_internal('lines', 'schedule', false, 'stopped at the credit floor (4000 left)', null, null)");
    }
    const top = await db.q(member(owner), "select kind, error from public.admin_recent_problems(10)");
    expect(top.filter((r) => r.kind === "fair_play")).toHaveLength(1);
    expect(top.filter((r) => r.error.startsWith("stopped at the credit floor"))).toEqual([{ kind: "lines", error: "stopped at the credit floor (4000 left) (12 times)" }]);
  });

  it("still counts someone who placed both bets after they stop managing one of the entries", async () => {
    // Removing them afterwards is in the admin log, but the flag shouldn't depend on
    // someone reading it.
    const yan = await makeUser(db, "yan@example.com", "Yan");
    await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [two, yan]);
    await db.q(member(owner), "select public.admin_set_manager($1, $2, false)", [two, dana]);
    expect(await flags()).toEqual(["Dana One and Dana Two, which share a manager (Dana), took opposite sides of Titans at Texans."]);
  });

  it("an admin-voided bet doesn't count", async () => {
    await db.q(member(owner), "select public.admin_void_slip($1, 'Placed in error')", [danaBet]);
    expect(await flags()).toEqual([]);
  });
});
