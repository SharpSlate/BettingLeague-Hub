// Player props: the import from the owner's prop pulls, the board, placing and undoing
// prop bets, box scores and an admin's corrections, and the rules' props section.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, centerOnWeek4, event, fails, freshDb, gameId, hoursFromNow, ingest, makeLeague, makeUser, member, place, service, standardLines, undo, type Db } from "./db.ts";

let db: Db;
let owner: string, carol: string, dave: string;
let league: string, carolEntry: string, daveEntry: string;
let gKc: string, gDet: string;

const KEY = "test-prop-key";
const PROPS_ON = { enabled: true, markets: ["anytime_td", "receptions", "rush_yds", "rec_yds", "pass_yds"], maxPerGame: 2, maxStakePct: 50 };

type Quote = { eventId: string; market: string; player: string; side: string; point: number | null; price: number; book: string };
const ou = (eventId: string, market: string, player: string, point: number, book = "draftkings", over = -115, under = -115): Quote[] => [
  { eventId, market, player, side: "over", point, price: over, book },
  { eventId, market, player, side: "under", point, price: under, book },
];
const td = (eventId: string, player: string, price: number, book = "draftkings"): Quote => ({ eventId, market: "player_anytime_td", player, side: "yes", point: null, price, book });

let pulledAt = Date.now() - 60 * 60_000;
/** Imports quotes as the owner's sender would, each import pulled a minute after the last. */
const importProps = async (quotes: unknown, key = KEY, at?: Date) => {
  const when = at ?? new Date((pulledAt += 60_000));
  return (await db.q(service, "select public.ingest_props_internal($1, $2, 'test', $3::jsonb) as r", [key, when, JSON.stringify(quotes)]))[0].r as { games: number; lines: number };
};
const board = async (game: string) =>
  (await db.q(member(carol), "select market, player, side, point::float as point, price, source from public.current_props where game_id = $1 order by market, player, side", [game]));
const setProps = async (props: unknown) => {
  await db.su("alter table public.rule_sets disable trigger rule_sets_append_only");
  await db.su("update public.rule_sets set document = jsonb_set(document, '{props}', $2::jsonb) where league_id = $1", [league, JSON.stringify(props)]);
  await db.su("alter table public.rule_sets enable trigger rule_sets_append_only");
};
const propLeg = (game: string, market: string, player: string, side: string, point: number | null, price: number) => ({ gameId: game, market, side, point, price, player });
const status = async (slip: string) => (await db.su("select status from public.slips where id = $1", [slip]))[0].status as string;
const available = async (entry: string) => Number((await db.su("select app.available_cents($1) as a", [entry]))[0].a);

beforeAll(async () => {
  db = await freshDb("bl_props");
  await centerOnWeek4(db);
  await db.su("update app.prop_import_key set sha256 = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [KEY]);
  owner = await makeUser(db, "owner@example.com", "Owner");
  carol = await makeUser(db, "carol@example.com", "Carol");
  dave = await makeUser(db, "dave@example.com", "Dave");
  await db.su("select app.bootstrap_admin('owner@example.com')");
  league = await makeLeague(db, owner);
  carolEntry = (await db.q(member(owner), "select public.admin_add_entry('Carol', 20000000) as id"))[0].id;
  daveEntry = (await db.q(member(owner), "select public.admin_add_entry('Dave', 1000000) as id"))[0].id;
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [carolEntry, carol]);
  await db.q(member(owner), "select public.admin_set_manager($1, $2, true)", [daveEntry, dave]);
  await ingest(db, [
    event("KCBUF", hoursFromNow(2), "Kansas City Chiefs", "Buffalo Bills", [{ book: "draftkings", outcomes: standardLines(-3) }]),
    event("DETGB", hoursFromNow(3), "Detroit Lions", "Green Bay Packers", [{ book: "draftkings", outcomes: standardLines(-2.5) }]),
  ]);
  gKc = await gameId(db, "KCBUF");
  gDet = await gameId(db, "DETGB");
  await db.q(member(owner), "select public.admin_open_next_week(null, 'Start')");
  await setProps(PROPS_ON);
});
afterAll(async () => db?.close());

describe("importing props", () => {
  it("needs the owner's key, and only the service role can call it", async () => {
    await fails(importProps([], "wrong-key"), "bad_key");
    await fails(importProps([], ""), "bad_key");
    await fails(db.q(member(owner), "select public.ingest_props_internal($1, now(), 'x', '[]'::jsonb)", [KEY]), "permission denied");
    await fails(db.q(anon, "select public.ingest_props_internal($1, now(), 'x', '[]'::jsonb)", [KEY]), "permission denied");
    await fails(db.q(member(owner), "select sha256 from app.prop_import_key"), "permission denied");
  });

  it("puts each player's main line on the board from the first book offering the whole prop", async () => {
    const r = await importProps([
      ...ou("KCBUF", "player_pass_yds", "Josh Allen", 239.5, "fanduel", -110, -120),
      ...ou("KCBUF", "player_pass_yds", "Josh Allen", 240.5, "draftkings"),
      // Only the over at DraftKings: FanDuel's whole prop is used.
      { eventId: "KCBUF", market: "player_pass_yds", player: "Patrick Mahomes", side: "over", point: 254.5, price: -115, book: "draftkings" },
      ...ou("KCBUF", "player_pass_yds", "Patrick Mahomes", 252.5, "fanduel"),
      // The over and the under at different numbers: not a main line.
      { eventId: "KCBUF", market: "player_receptions", player: "Travis Kelce", side: "over", point: 5.5, price: -115, book: "draftkings" },
      { eventId: "KCBUF", market: "player_receptions", player: "Travis Kelce", side: "under", point: 6.5, price: -115, book: "draftkings" },
      td("KCBUF", "Josh Allen", 120),
      td("KCBUF", "James Cook", -110),
      ...ou("KCBUF", "player_rush_yds", "James Cook", 71.5),
      ...ou("DETGB", "player_reception_yds", "Amon-Ra St. Brown", 78.5),
      // Dropped: a game the site doesn't have, a market it doesn't offer, a bad price, a quarter point.
      ...ou("NOPE", "player_pass_yds", "Somebody", 200.5),
      ...ou("KCBUF", "player_pass_tds", "Josh Allen", 1.5),
      { eventId: "KCBUF", market: "player_rush_yds", player: "Isiah Pacheco", side: "over", point: 40.5, price: 50, book: "draftkings" },
      ...ou("KCBUF", "player_rush_yds", "Kareem Hunt", 30.25),
      "not a quote",
    ]);
    // Stored: every whole quote, 15 of them; on the board: the main lines.
    expect(r).toEqual({ games: 2, lines: 15 });
    expect(await board(gKc)).toEqual([
      { market: "anytime_td", player: "James Cook", side: "yes", point: null, price: -110, source: "draftkings" },
      { market: "anytime_td", player: "Josh Allen", side: "yes", point: null, price: 120, source: "draftkings" },
      { market: "pass_yds", player: "Josh Allen", side: "over", point: 240.5, price: -115, source: "draftkings" },
      { market: "pass_yds", player: "Josh Allen", side: "under", point: 240.5, price: -115, source: "draftkings" },
      { market: "pass_yds", player: "Patrick Mahomes", side: "over", point: 252.5, price: -115, source: "fanduel" },
      { market: "pass_yds", player: "Patrick Mahomes", side: "under", point: 252.5, price: -115, source: "fanduel" },
      { market: "rush_yds", player: "James Cook", side: "over", point: 71.5, price: -115, source: "draftkings" },
      { market: "rush_yds", player: "James Cook", side: "under", point: 71.5, price: -115, source: "draftkings" },
    ]);
    expect(await board(gDet)).toHaveLength(2);
  });

  it("takes a prop off the board when the latest import doesn't have it, and refuses an older import", async () => {
    const before = pulledAt;
    await importProps([
      ...ou("KCBUF", "player_pass_yds", "Josh Allen", 240.5),
      ...ou("KCBUF", "player_pass_yds", "Patrick Mahomes", 252.5, "fanduel"),
      td("KCBUF", "Josh Allen", 120),
      td("KCBUF", "James Cook", -110),
      ...ou("DETGB", "player_reception_yds", "Amon-Ra St. Brown", 78.5),
    ]);
    expect((await board(gKc)).map((p) => `${p.market} ${p.player} ${p.side}`)).not.toContain("rush_yds James Cook over");
    await fails(importProps([], KEY, new Date(before - 30 * 60_000)), "older_than_latest");
    await fails(importProps([], KEY, new Date(Date.now() + 3_600_000)), "bad_pulled_at");
  });

  it("members can read when props were pulled, but not the import's errors", async () => {
    const [last] = await db.q(member(carol), "select pulled_at, ok, games, lines from public.prop_imports order by at desc limit 1");
    expect(last).toMatchObject({ ok: true, games: 2, lines: 8 });
    await fails(db.q(member(carol), "select error from public.prop_imports"), "permission denied");
  });

  it("a failed import shows on the Admin page", async () => {
    await db.q(service, "select public.record_prop_import_failure_internal(now(), 'test', 'the sender sent no quotes')");
    const problems = await db.q(member(owner), "select kind, error from public.admin_recent_problems(10, $1)", [league]);
    expect(problems).toContainEqual({ kind: "props", error: "the sender sent no quotes" });
  });
});

describe("betting on props", () => {
  const allenOver = () => propLeg(gKc, "pass_yds", "Josh Allen", "over", 240.5, -115);

  it("a straight bet at the board's line, from the board's book", async () => {
    const id = await place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 10_000, quotedAmerican: -115, potentialPayoutCents: 18_696, legs: [allenOver()] });
    const [leg] = await db.su("select market, side, point::float as point, price, player, book from public.slip_legs where slip_id = $1", [id]);
    expect(leg).toEqual({ market: "pass_yds", side: "over", point: 240.5, price: -115, player: "Josh Allen", book: "draftkings" });
  });

  it("refuses a moved or missing line, and props too old to bet", async () => {
    const bet = (leg: object) => place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 10_000, legs: [leg as never] });
    await fails(bet(propLeg(gKc, "pass_yds", "Josh Allen", "over", 239.5, -115)), "line_moved");
    await fails(bet(propLeg(gKc, "anytime_td", "Josh Allen", "yes", null, 110)), "line_moved");
    await fails(bet(propLeg(gKc, "rush_yds", "James Cook", "over", 71.5, -115)), "line_unavailable");
    await fails(bet(propLeg(gKc, "receptions", "Travis Kelce", "over", 5.5, -115)), "line_unavailable");
    // A game's own market can't carry a player.
    await fails(bet({ gameId: gKc, market: "spread", side: "home", point: -3, price: -110, player: "Josh Allen" }), "bad_market");
    const [latest] = await db.su("select id, pulled_at from public.prop_imports where ok order by at desc limit 1");
    await db.su("update public.prop_imports set pulled_at = now() - interval '19 hours' where id = $1", [latest.id]);
    await fails(bet(propLeg(gKc, "anytime_td", "Josh Allen", "yes", null, 120)), "props_stale");
    await db.su("update public.prop_imports set pulled_at = $2 where id = $1", [latest.id, latest.pulled_at]);
  });

  it("parlays: up to 2 props from a game, never with its game lines, one pick per player", async () => {
    const parlay = (legs: object[], stakeCents = 10_000) => place(db, { entry: daveEntry, user: dave, type: "parlay", stakeCents, legs: legs as never });
    const td = (player: string, price: number) => propLeg(gKc, "anytime_td", player, "yes", null, price);
    const mahomes = propLeg(gKc, "pass_yds", "Patrick Mahomes", "under", 252.5, -115);
    await fails(parlay([td("Josh Allen", 120), td("James Cook", -110), mahomes]), "same_game_props");
    await fails(parlay([td("Josh Allen", 120), { gameId: gKc, market: "spread", side: "home", point: -3, price: -110 }]), "same_game_props");
    await fails(parlay([td("Josh Allen", 120), propLeg(gKc, "pass_yds", "Josh Allen", "under", 240.5, -115)]), "same_player");
    await parlay([td("Josh Allen", 120), mahomes, propLeg(gDet, "rec_yds", "Amon-Ra St. Brown", "over", 78.5, -115)]);
    // A prop with another game's spread is fine.
    await parlay([td("James Cook", -110), { gameId: gDet, market: "spread", side: "home", point: -2.5, price: -110 }]);
  });

  it("no props in a teaser, and at most half the maximum stake", async () => {
    await fails(place(db, { entry: carolEntry, user: carol, type: "teaser", teaserPoints: 6, stakeCents: 10_000, legs: [
      propLeg(gKc, "anytime_td", "Josh Allen", "yes", null, 120), { gameId: gDet, market: "spread", side: "home", point: -2.5, price: -110 },
    ] as never }), "bad_market");
    const big = (stakeCents: number) => place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents, legs: [propLeg(gKc, "anytime_td", "James Cook", "yes", null, -110)] as never });
    await fails(big(12_500_100), "stake_out_of_range");
    await big(12_500_000);
  });

  it("not both the over and the under of a player's prop, across bets", async () => {
    await fails(place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 10_000, legs: [propLeg(gKc, "pass_yds", "Josh Allen", "under", 240.5, -115)] as never }), "opposite_side");
    // Another player's under is a different prop.
    await place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 10_000, legs: [propLeg(gKc, "pass_yds", "Patrick Mahomes", "under", 252.5, -115)] as never });
  });

  it("are refused when the league doesn't offer them, or not that market", async () => {
    const bet = () => place(db, { entry: daveEntry, user: dave, type: "straight", stakeCents: 10_000, legs: [propLeg(gDet, "rec_yds", "Amon-Ra St. Brown", "over", 78.5, -115)] as never });
    await setProps({ ...PROPS_ON, markets: ["anytime_td"] });
    await fails(bet(), "bad_market");
    await setProps({ ...PROPS_ON, enabled: false });
    await fails(bet(), "props_off");
    await setProps(PROPS_ON);
  });

  it("a bet with a player prop undoes like any other, until a newer import moves its prop", async () => {
    const leg = propLeg(gDet, "rec_yds", "Amon-Ra St. Brown", "under", 78.5, -115);
    const sinceFor = async (slip: string, user: string) =>
      (await db.q(service, "select public.undo_slip_internal($1, $2, true) as since", [slip, user]))[0].since as Date | null;
    // Props alone: the prop is checked against the latest import, so no pull is needed.
    const a = await place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 10_000, legs: [leg] as never });
    expect(await sinceFor(a, carol)).toBeNull();
    await undo(db, a, carol);
    expect(await status(a)).toBe("undone");
    // Mixed with a game line: the game line still needs a fresh pull.
    const mixed = await place(db, { entry: daveEntry, user: dave, type: "parlay", stakeCents: 10_000, legs: [
      propLeg(gKc, "anytime_td", "James Cook", "yes", null, -110), { gameId: gDet, market: "total", side: "over", point: 47.5, price: -110 },
    ] as never });
    expect(await sinceFor(mixed, dave)).not.toBeNull();
    await undo(db, mixed, dave);
    expect(await status(mixed)).toBe("undone");
    // Once a newer import moves the prop, it stays.
    const b = await place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 10_000, legs: [leg] as never });
    await importProps([
      ...ou("KCBUF", "player_pass_yds", "Josh Allen", 240.5),
      ...ou("KCBUF", "player_pass_yds", "Patrick Mahomes", 252.5, "fanduel"),
      td("KCBUF", "Josh Allen", 120),
      td("KCBUF", "James Cook", -110),
      ...ou("DETGB", "player_reception_yds", "Amon-Ra St. Brown", 74.5),
    ]);
    await fails(undo(db, b, carol), "undo_line_moved");
    expect(await status(b)).toBe("pending");
  });

  it("props can be bet only on a pull from the last 2 hours", async () => {
    expect((await db.su("select prop_max_age_minutes from public.league_settings"))[0].prop_max_age_minutes).toBe(120);
    const bet = () => place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 10_000, legs: [propLeg(gKc, "anytime_td", "Josh Allen", "yes", null, 120)] as never });
    const [latest] = await db.su("select id, pulled_at from public.prop_imports where ok order by at desc limit 1");
    await db.su("update public.prop_imports set pulled_at = now() - interval '121 minutes' where id = $1", [latest.id]);
    await fails(bet(), "props_stale");
    await db.su("update public.prop_imports set pulled_at = now() - interval '110 minutes' where id = $1", [latest.id]);
    await bet();
    await db.su("update public.prop_imports set pulled_at = $2 where id = $1", [latest.id, latest.pulled_at]);
  });

  it("within 90 minutes of kickoff, only on props pulled after the inactives came out", async () => {
    const [{ latest }] = await db.su("select max(pulled_at) as latest from public.prop_imports where ok");
    const [orig] = await db.su("select kickoff_at, feed_commence from public.games where id = $1", [gKc]);
    // Inactives (kickoff minus 90 minutes) came out a minute after the latest pull.
    const kickoff = new Date(new Date(latest).getTime() + 91 * 60_000);
    await db.su("update public.games set kickoff_at = $2, feed_commence = $2 where id = $1", [gKc, kickoff]);
    const bet = () => place(db, { entry: carolEntry, user: carol, type: "straight", stakeCents: 10_000, legs: [propLeg(gKc, "anytime_td", "James Cook", "yes", null, -110)] as never });
    await fails(bet(), "props_inactives");
    // The next pull is after the inactives: betting reopens.
    await importProps([
      ...ou("KCBUF", "player_pass_yds", "Josh Allen", 240.5),
      ...ou("KCBUF", "player_pass_yds", "Patrick Mahomes", 252.5, "fanduel"),
      td("KCBUF", "Josh Allen", 120),
      td("KCBUF", "James Cook", -110),
      ...ou("DETGB", "player_reception_yds", "Amon-Ra St. Brown", 74.5),
    ]);
    await bet();
    // Game lines don't care.
    await place(db, { entry: daveEntry, user: dave, type: "straight", stakeCents: 10_000, legs: [{ gameId: gKc, market: "total", side: "under", point: 47.5, price: -110 }] as never });
    await db.su("update public.games set kickoff_at = $2, feed_commence = $3 where id = $1", [gKc, orig.kickoff_at, orig.feed_commence]);
  });
});

describe("grading props", () => {
  let allenTd: string, cookTd: string;
  const settle = (id: string, result: string, payout: number) =>
    db.q(service, "select public.settle_slip_internal($1, $2, $3, $4::jsonb) as ok", [id, result, payout, JSON.stringify([{ legNo: 1, result }])]);

  beforeAll(async () => {
    allenTd = await place(db, { entry: daveEntry, user: dave, type: "straight", stakeCents: 10_000, quotedAmerican: 120, potentialPayoutCents: 22_000, legs: [propLeg(gKc, "anytime_td", "Josh Allen", "yes", null, 120)] as never });
    cookTd = await place(db, { entry: daveEntry, user: dave, type: "straight", stakeCents: 10_000, quotedAmerican: -110, potentialPayoutCents: 19_091, legs: [propLeg(gKc, "anytime_td", "James Cook", "yes", null, -110)] as never });
    await db.su("update public.games set kickoff_at = now() - interval '3 hours' where id = $1", [gKc]);
  });

  it("asks for the box score of a final game with props riding, and stores it once", async () => {
    expect(await db.q(service, "select game_id from public.games_needing_boxes_internal()")).toEqual([]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 20, 27, 'Final')", [gKc]);
    expect(await db.q(service, "select game_id, home_name, away_name from public.games_needing_boxes_internal()")).toEqual([
      { game_id: gKc, home_name: "Kansas City Chiefs", away_name: "Buffalo Bills" },
    ]);
    const players = [
      { player: "Josh Allen", team: "BUF", passYds: 262, rushYds: 31, recYds: 0, receptions: 0, tds: 1 },
      { player: "Patrick Mahomes", team: "KC", passYds: 248, rushYds: 0, recYds: 0, receptions: 0, tds: 0 },
      { player: "", team: "KC", passYds: 0, rushYds: 0, recYds: 0, receptions: 0, tds: 0 },
    ];
    expect((await db.q(service, "select public.ingest_box_internal($1, '401770001', $2::jsonb) as n", [gKc, JSON.stringify(players)]))[0].n).toBe(2);
    expect((await db.q(service, "select public.ingest_box_internal($1, '401770001', $2::jsonb) as n", [gKc, JSON.stringify(players)]))[0].n).toBe(0);
    expect(await db.q(service, "select game_id from public.games_needing_boxes_internal()")).toEqual([]);
    await fails(db.q(service, "select public.ingest_box_internal($1, 'x', '[]'::jsonb)", [gDet]), "game_not_final");
    // Members can read the box score.
    expect(await db.q(member(carol), "select player, pass_yds, tds from public.player_stats where game_id = $1 order by player", [gKc])).toEqual([
      { player: "Josh Allen", pass_yds: 262, tds: 1 },
      { player: "Patrick Mahomes", pass_yds: 248, tds: 0 },
    ]);
  });

  it("a site admin can enter a missing player's stats, which regrades his props", async () => {
    // The grader settles Allen's TD (won) and voids Cook's (he isn't in the box score).
    await settle(allenTd, "won", 22_000);
    await settle(cookTd, "void", 10_000);
    const before = await available(daveEntry);
    await fails(db.q(member(carol), "select public.admin_set_player_stats($1, 'James Cook', true, 0, 88, 19, 3, 1, 'He played')", [gKc]), "admin_only");
    await fails(db.q(member(owner), "select public.admin_set_player_stats($1, 'James Cook', true, 0, 88, 19, 3, 1, 'He played')", [gDet]), "game_not_final");
    await fails(db.q(member(owner), "select public.admin_set_player_stats($1, 'James Cook', true, 0, 88, 19, -1, 1, 'He played')", [gKc]), "bad_stats");
    await fails(db.q(member(owner), "select public.admin_set_player_stats($1, '  ', true, 0, 88, 19, 3, 1, 'He played')", [gKc]), "bad_player");
    await db.q(member(owner), "select public.admin_set_player_stats($1, 'James Cook', true, 0, 88, 19, 3, 1, 'ESPN left him out')", [gKc]);
    // Both bets on the game go back to pending, and what they paid is taken back.
    expect([await status(allenTd), await status(cookTd)]).toEqual(["pending", "pending"]);
    expect(await available(daveEntry)).toBe(before - 32_000);
    // A second entry for him replaces the first.
    await db.q(member(owner), "select public.admin_set_player_stats($1, 'james cook', false, 0, 0, 0, 0, 0, 'Inactive after all')", [gKc]);
    expect(await db.su("select player, played, rush_yds from public.player_stats where game_id = $1 and source = 'admin'", [gKc])).toEqual([
      { player: "james cook", played: false, rush_yds: 0 },
    ]);
    const [log] = await db.su("select action, reason from public.audit_log where action = 'player_stats_set' order by id desc limit 1");
    expect(log).toEqual({ action: "player_stats_set", reason: "Inactive after all" });
  });
});

describe("the rules' props section", () => {
  const doc = async () => (await db.su("select document from public.rule_sets where league_id = $1 order by version desc limit 1", [league]))[0].document;
  const publish = async (props: unknown) => {
    const d = await doc();
    return db.q(service, "select public.publish_rule_set_internal($1, $2, $3::jsonb, 6, 'props') as v", [owner, league, JSON.stringify({ ...d, props })]);
  };
  it("new leagues start with props off, at the recommended limits", async () => {
    expect((await db.su("select document -> 'props' as p from public.rule_sets where version = 1"))[0].p)
      .toEqual({ ...PROPS_ON, enabled: false, maxPerGame: 1, maxStakePct: 2, maxPerParlay: 3 });
  });
  it("a published props section must be whole and in range", async () => {
    await fails(publish({ ...PROPS_ON, maxPerGame: 4 }), "bad_rules");
    await fails(publish({ ...PROPS_ON, maxPerGame: 1.5 }), "bad_rules");
    await fails(publish({ ...PROPS_ON, maxStakePct: 0 }), "bad_rules");
    await fails(publish({ ...PROPS_ON, markets: ["player_pass_tds"] }), "bad_rules");
    await fails(publish({ ...PROPS_ON, enabled: "yes" }), "bad_rules");
    await publish({ ...PROPS_ON, maxPerGame: 3, maxStakePct: 25 });
  });
});

describe("props waiting for an admin", () => {
  const candidate = { player: "Gabriel Davis", stats: { passYds: 0, rushYds: 0, recYds: 40, receptions: 3, tds: 0 } };
  it("the grader's list replaces the last one, keeps when each started, and only admins can read it", async () => {
    await db.q(service, "select public.record_prop_holds_internal($1::jsonb)", [JSON.stringify([
      { gameId: gKc, player: "Joe Nobody", why: "missing", bets: 2 },
      { gameId: gKc, player: "Gabe Davis", why: "name", candidate, bets: 1 },
      { gameId: gKc, player: "Odd Reason", why: "nope", bets: 1 },
      { gameId: "00000000-0000-0000-0000-000000000000", player: "No Game", why: "missing", bets: 1 },
    ])]);
    expect(await db.q(member(owner), "select label, player, why, candidate, bets from public.admin_prop_holds()")).toEqual([
      { label: "Bills at Chiefs", player: "Gabe Davis", why: "name", candidate, bets: 1 },
      { label: "Bills at Chiefs", player: "Joe Nobody", why: "missing", candidate: null, bets: 2 },
    ]);
    await fails(db.q(member(carol), "select * from public.admin_prop_holds()"), "admin_only");
    await fails(db.q(member(owner), "select public.record_prop_holds_internal('[]'::jsonb)"), "permission denied");
    await fails(db.q(member(carol), "select * from public.prop_holds"), "permission denied");
    const [first] = await db.su("select since from public.prop_holds where player = 'Joe Nobody'");
    await db.q(service, "select public.record_prop_holds_internal($1::jsonb)", [JSON.stringify([{ gameId: gKc, player: "Joe Nobody", why: "missing", bets: 3 }])]);
    expect(await db.su("select player, bets, since from public.prop_holds")).toEqual([{ player: "Joe Nobody", bets: 3, since: first.since }]);
  });

  it("an admin's answer clears that player's hold", async () => {
    await db.q(member(owner), "select public.admin_set_player_stats($1, 'joe nobody', false, 0, 0, 0, 0, 0, 'Inactive')", [gKc]);
    expect(await db.su("select count(*)::int as n from public.prop_holds")).toEqual([{ n: 0 }]);
  });
});

describe("box scores sent from the owner's PC", () => {
  it("checks the owner's key", async () => {
    expect((await db.q(service, "select public.prop_key_ok_internal($1) as ok", [KEY]))[0].ok).toBe(true);
    expect((await db.q(service, "select public.prop_key_ok_internal('nope') as ok"))[0].ok).toBe(false);
    expect((await db.q(service, "select public.prop_key_ok_internal(null) as ok"))[0].ok).toBe(false);
    await fails(db.q(member(owner), "select public.prop_key_ok_internal('x')"), "permission denied");
  });

  it("an admin's stats for one player don't make the game's box score, which can still come from the PC", async () => {
    await db.su("update public.games set kickoff_at = now() - interval '3 hours' where id = $1", [gDet]);
    await db.q(member(owner), "select public.admin_set_final_score($1, 24, 17, 'Final')", [gDet]);
    const waiting = async () => (await db.q(service, "select game_id from public.games_needing_boxes_internal()")).map((r) => r.game_id);
    expect(await waiting()).toContain(gDet);
    await db.q(member(owner), "select public.admin_set_player_stats($1, 'Jared Goff', true, 280, 3, 0, 0, 0, 'ESPN is down')", [gDet]);
    expect(await db.su("select count(*)::int as n from public.game_boxes where game_id = $1", [gDet])).toEqual([{ n: 0 }]);
    expect(await waiting()).toContain(gDet);
    const players = [{ player: "Jared Goff", team: "DET", passYds: 281, rushYds: 3, recYds: 0, receptions: 0, tds: 0 }];
    await fails(db.q(service, "select public.ingest_box_internal($1, '401770002', $2::jsonb, 'admin')", [gDet, JSON.stringify(players)]), "bad_source");
    await fails(db.q(member(owner), "select public.ingest_box_internal($1, '401770002', $2::jsonb, 'feed')", [gDet, JSON.stringify(players)]), "permission denied");
    expect((await db.q(service, "select public.ingest_box_internal($1, '401770002', $2::jsonb, 'feed') as n", [gDet, JSON.stringify(players)]))[0].n).toBe(1);
    expect(await db.su("select source from public.game_boxes where game_id = $1", [gDet])).toEqual([{ source: "feed" }]);
    expect(await waiting()).not.toContain(gDet);
    // The admin's row stands beside the box score (it grades Goff's props first).
    expect(await db.su("select source, pass_yds from public.player_stats where game_id = $1 order by source", [gDet])).toEqual([
      { source: "admin", pass_yds: 280 }, { source: "espn", pass_yds: 281 },
    ]);
  });
});

describe("a later game: ruled-out players, price checks, the props-per-parlay cap", () => {
  let g: string;
  const boardOf = async (game: string) =>
    (await db.q(member(carol), "select market, player, side, point::float as point, price, source from public.current_props where game_id = $1 order by market, player, side", [game]));

  it("a player whose props came off the board once inactives were out (while the game's others stayed) was ruled out", async () => {
    await ingest(db, [event("NYGDAL", hoursFromNow(1), "Dallas Cowboys", "New York Giants", [{ book: "draftkings", outcomes: standardLines(-3) }])]);
    g = await gameId(db, "NYGDAL");
    await importProps([...ou("NYGDAL", "player_reception_yds", "CeeDee Lamb", 80.5), td("NYGDAL", "Malik Nabers", 150)]);
    const [{ latest }] = await db.su("select max(pulled_at) as latest from public.prop_imports where ok");
    // The inactives come out between that pull and the next.
    const kickoff = new Date(new Date(latest).getTime() + 90 * 60_000 + 30_000);
    await db.su("update public.games set kickoff_at = $2, feed_commence = $2 where id = $1", [g, kickoff]);
    const gone = async () => (await db.q(service, "select player from public.props_left_board_internal($1::uuid[])", [[g]])).map((r) => r.player);
    expect(await gone()).toEqual([]);
    await importProps([td("NYGDAL", "Malik Nabers", 150)]);
    expect(await gone()).toEqual(["CeeDee Lamb"]);
    await fails(db.q(member(owner), "select * from public.props_left_board_internal($1::uuid[])", [[g]]), "permission denied");
  });

  it("a price no book posts for a main line leaves that book's prop off the board, for the next book's", async () => {
    await importProps([
      // DraftKings' over at +400 against a -110 under: a feed error. FanDuel's is used.
      ...ou("NYGDAL", "player_reception_yds", "CeeDee Lamb", 80.5, "draftkings", 400, -110),
      ...ou("NYGDAL", "player_reception_yds", "CeeDee Lamb", 79.5, "fanduel", -115, -105),
      // Only one book, and out of range: off the board.
      ...ou("NYGDAL", "player_receptions", "Jake Ferguson", 4.5, "draftkings", -350, 260),
      // Both sides plus money: no book's margin is below zero.
      ...ou("NYGDAL", "player_rush_yds", "Rico Dowdle", 55.5, "draftkings", 110, 110),
      ...ou("NYGDAL", "player_pass_yds", "Dak Prescott", 245.5),
      td("NYGDAL", "Malik Nabers", 150),
      td("NYGDAL", "Dak Prescott", 3000),
    ]);
    expect(await boardOf(g)).toEqual([
      { market: "anytime_td", player: "Malik Nabers", side: "yes", point: null, price: 150, source: "draftkings" },
      { market: "pass_yds", player: "Dak Prescott", side: "over", point: 245.5, price: -115, source: "draftkings" },
      { market: "pass_yds", player: "Dak Prescott", side: "under", point: 245.5, price: -115, source: "draftkings" },
      { market: "rec_yds", player: "CeeDee Lamb", side: "over", point: 79.5, price: -115, source: "fanduel" },
      { market: "rec_yds", player: "CeeDee Lamb", side: "under", point: 79.5, price: -105, source: "fanduel" },
    ]);
  });

  it("a parlay takes at most props.maxPerParlay props", async () => {
    const legs = [
      propLeg(g, "anytime_td", "Malik Nabers", "yes", null, 150),
      propLeg(g, "rec_yds", "CeeDee Lamb", "over", 79.5, -115),
      propLeg(g, "pass_yds", "Dak Prescott", "under", 245.5, -115),
    ];
    const parlay = () => place(db, { entry: carolEntry, user: carol, type: "parlay", stakeCents: 10_000, legs: legs as never });
    await setProps({ ...PROPS_ON, maxPerGame: 3, maxPerParlay: 2 });
    await fails(parlay(), "too_many_props");
    await setProps({ ...PROPS_ON, maxPerGame: 3, maxPerParlay: 3 });
    await parlay();
    await setProps(PROPS_ON);
  });

  it("a published props.maxPerParlay must be 1 to 10", async () => {
    const [d] = await db.su("select document from public.rule_sets where league_id = $1 order by version desc limit 1", [league]);
    const publish = (props: unknown) =>
      db.q(service, "select public.publish_rule_set_internal($1, $2, $3::jsonb, 6, 'props') as v", [owner, league, JSON.stringify({ ...d.document, props })]);
    await fails(publish({ ...PROPS_ON, maxPerParlay: 0 }), "bad_rules");
    await fails(publish({ ...PROPS_ON, maxPerParlay: 11 }), "bad_rules");
    await fails(publish({ ...PROPS_ON, maxPerParlay: 2.5 }), "bad_rules");
    await fails(publish({ ...PROPS_ON, maxPerParlay: "3" }), "bad_rules");
    await publish({ ...PROPS_ON, maxPerGame: 1, maxStakePct: 2, maxPerParlay: 3 });
  });
});
