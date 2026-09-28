// The fairness rules added after the owner's "can a player take advantage?" review:
// no betting both sides of a game across separate bets (it met the weekly minimum for
// the cost of the vig), and no undoing a bet once its line has moved (undo was a free
// option on news).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY_ONE_RULES } from "../functions/_shared/rules/index.ts";
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

  it("an admin-voided bet doesn't count", async () => {
    await db.q(member(owner), "select public.admin_void_slip($1, 'Placed in error')", [danaBet]);
    expect(await flags()).toEqual([]);
  });
});
