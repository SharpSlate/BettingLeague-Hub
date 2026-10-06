// Many leagues on one site: each league's people, bets, rules and weeks stay its own,
// while games and lines are shared.
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
  makeUser,
  member,
  place,
  service,
  standardLines,
  type Db,
} from "./db.ts";

let db: Db;
let site: string, ann: string, al: string, bea: string, bo: string, nobody: string;
let leagueA: string, leagueB: string;
let alEntry: string, boEntry: string;
let gA: string;

const code = async (user: string, league: string) =>
  (await db.q(member(user), "select invite_code from public.my_leagues() where league_id = $1", [league]))[0]?.invite_code as string | null;

beforeAll(async () => {
  db = await freshDb("bl_leagues");
  await centerOnWeek4(db);
  site = await makeUser(db, "site@example.com", "Site");
  ann = await makeUser(db, "ann@example.com", "Ann");
  al = await makeUser(db, "al@example.com", "Al");
  bea = await makeUser(db, "bea@example.com", "Bea");
  bo = await makeUser(db, "bo@example.com", "Bo");
  nobody = await makeUser(db, "nobody@example.com", "Nobody");
  await db.su("select app.bootstrap_admin('site@example.com')");
  leagueA = (await db.q(member(ann), "select public.create_league('League A') as id"))[0].id;
  leagueB = (await db.q(member(bea), "select public.create_league('League B') as id"))[0].id;
  await ingest(db, [
    event("A", hoursFromNow(2), "Kansas City Chiefs", "Buffalo Bills", [{ book: "draftkings", outcomes: standardLines(-3) }]),
  ]);
  gA = await gameId(db, "A");
});
afterAll(async () => db?.close());

describe("starting a league", () => {
  it("makes the creator its commissioner, on a copy of the day-one rules, with every week upcoming", async () => {
    const [l] = await db.q(member(ann), "select * from public.my_leagues()");
    expect(l).toMatchObject({ league_id: leagueA, name: "League A", role: "commissioner", open_week: null, self_entry: true });
    expect(l.invite_code).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
    const rules = await db.q(member(ann), "select version, effective_week, document from public.rule_sets where league_id = $1", [leagueA]);
    expect(rules).toHaveLength(1);
    expect(rules[0].effective_week).toBe(1);
    expect(rules[0].document).toEqual(DAY_ONE_RULES);
    const weeks = await db.su("select count(*)::int as n from public.league_weeks where league_id = $1 and status = 'upcoming'", [leagueA]);
    expect(weeks[0].n).toBe(23);
  });

  it("needs a name and a signed-in caller", async () => {
    await fails(db.q(member(ann), "select public.create_league('  ')"), "bad_name");
    await fails(db.q(service, "select public.create_league('x')"), "sign_in_required");
  });
});

describe("joining", () => {
  it("shows what an invite leads to, and refuses a wrong code", async () => {
    const c = await code(ann, leagueA);
    const [p] = await db.q(member(al), "select * from public.league_by_invite($1)", [c!.toLowerCase()]);
    expect(p).toMatchObject({ league_id: leagueA, name: "League A", members: 1, already_member: false });
    await fails(db.q(member(al), "select public.join_league('NOPE')"), "bad_invite");
  });

  it("adds the member with an entry of their own at the league's starting bank", async () => {
    await db.q(member(al), "select public.join_league($1, 'Al''s entry')", [await code(ann, leagueA)]);
    const [e] = await db.q(member(al), "select * from public.my_entries()");
    expect(e).toMatchObject({ league_id: leagueA, name: "Al's entry" });
    expect(Number(e.bank_cents)).toBe(DAY_ONE_RULES.bank.startUnits * 100);
    alEntry = e.entry_id;
    await fails(db.q(member(al), "select public.join_league($1, 'Another')", [await code(ann, leagueA)]), "already_has_entry");
    const [l] = await db.q(member(al), "select * from public.my_leagues()");
    expect(l).toMatchObject({ role: "member", invite_code: null });
  });

  it("only when the league lets members make their own entry", async () => {
    await db.q(member(bea), "select public.admin_update_league($1, 'League B', false)", [leagueB]);
    await fails(db.q(member(bo), "select public.join_league($1, 'Bo')", [await code(bea, leagueB)]), "self_entry_off");
    await db.q(member(bo), "select public.join_league($1)", [await code(bea, leagueB)]);
    boEntry = (await db.q(member(bea), "select public.admin_add_entry('Bo', 500000, $1) as id", [leagueB]))[0].id;
    await db.q(member(bea), "select public.admin_set_manager($1, $2, true)", [boEntry, bo]);
  });

  it("a new invite code stops the old one", async () => {
    const old = await code(bea, leagueB);
    await db.q(member(bea), "select public.admin_update_league($1, 'League B', false, true)", [leagueB]);
    expect(await code(bea, leagueB)).not.toBe(old);
    await fails(db.q(member(nobody), "select public.join_league($1)", [old]), "bad_invite");
  });

  it("the invite code can't be read from the table", async () => {
    await fails(db.q(member(ann), "select invite_code from public.leagues"), "permission denied");
  });
});

describe("each league keeps to itself", () => {
  beforeAll(async () => {
    await db.q(member(ann), "select public.admin_open_next_week(null, null, $1)", [leagueA]);
    await place(db, { entry: alEntry, user: al, type: "straight", stakeCents: 10_000, legs: [{ gameId: gA, market: "spread", side: "home", point: -3, price: -110 }] });
  });

  it("weeks open league by league", async () => {
    const open = await db.su("select league_id, week from public.league_weeks where status = 'open'");
    expect(open).toEqual([{ league_id: leagueA, week: 4 }]);
    await fails(
      place(db, { entry: boEntry, user: bo, type: "straight", stakeCents: 10_000, ruleSetVersion: 1, legs: [{ gameId: gA, market: "spread", side: "away", point: 3, price: -110 }] }),
      "no_open_week",
    );
  });

  it("outsiders see none of a league: its leagues row, people, entries, rules, log or standings", async () => {
    for (const [table, col] of [["leagues", "id"], ["league_members", "league_id"], ["entries", "league_id"], ["rule_sets", "league_id"], ["audit_log", "league_id"], ["league_weeks", "league_id"]]) {
      expect(await db.q(member(bo), `select 1 from public.${table} where ${col} = $1`, [leagueA]), table).toEqual([]);
    }
    expect(await db.q(member(bo), "select 1 from public.profiles where id = $1", [al])).toEqual([]);
    expect(await db.q(member(bo), "select 1 from public.ledger where entry_id = $1", [alEntry])).toEqual([]);
    await fails(db.q(member(bo), "select * from public.standings(null, null, null, $1)", [leagueA]), "not_member");
    await fails(db.q(member(bo), "select * from public.hidden_activity(10, $1)", [leagueA]), "not_member");
  });

  it("a revealed bet shows to its own league, never to another", async () => {
    await db.su("update public.games set kickoff_at = now() - interval '1 minute' where id = $1", [gA]);
    expect(await db.q(member(ann), "select 1 from public.slips where entry_id = $1", [alEntry])).toHaveLength(1);
    expect(await db.q(member(ann), "select 1 from public.slip_legs l join public.slips s on s.id = l.slip_id where s.entry_id = $1", [alEntry])).toHaveLength(1);
    expect(await db.q(member(bo), "select 1 from public.slips where entry_id = $1", [alEntry])).toEqual([]);
    expect(await db.q(member(bo), "select 1 from public.slip_legs l where l.game_id = $1", [gA])).toEqual([]);
    expect(await db.q(member(site), "select 1 from public.slips where entry_id = $1", [alEntry])).toEqual([]);
    await db.su("update public.games set kickoff_at = now() + interval '2 hours' where id = $1", [gA]);
  });

  it("members see their own league's standings, and only those", async () => {
    const rows = await db.q(member(al), "select name from public.standings()");
    expect(rows.map((r) => r.name)).toEqual(["Al's entry"]);
  });

  it("a commissioner runs only their own league", async () => {
    await fails(db.q(member(bea), "select public.admin_adjust_bank($1, 100, 'nope')", [alEntry]), "commissioner_only");
    await fails(db.q(member(bea), "select public.admin_set_manager($1, $2, true)", [alEntry, bea]), "commissioner_only");
    await fails(db.q(member(bea), "select public.admin_open_next_week(4, null, $1)", [leagueA]), "commissioner_only");
    await fails(db.q(member(bea), "select * from public.admin_list_users($1)", [leagueA]), "commissioner_only");
    const slip = (await db.su("select id from public.slips where entry_id = $1", [alEntry]))[0].id;
    await fails(db.q(member(bea), "select public.admin_void_slip($1, 'not my league')", [slip]), "commissioner_only");
    const doc = JSON.stringify(DAY_ONE_RULES);
    await fails(db.q(service, "select public.publish_rule_set_internal($1, $2, $3::jsonb, 9, 'x')", [bea, leagueA, doc]), "commissioner_only");
  });

  it("a site admin has no say in a league they don't run", async () => {
    await fails(db.q(member(site), "select public.admin_add_entry('Sneaky', 0, $1)", [leagueA]), "commissioner_only");
    await fails(db.q(member(site), "select public.admin_set_manager($1, $2, true)", [alEntry, site]), "commissioner_only");
  });

  it("the commissioner's member list covers their league only", async () => {
    const rows = await db.q(member(ann), "select display_name, is_commissioner, entry_names from public.admin_list_users($1)", [leagueA]);
    expect(rows).toEqual([
      { display_name: "Al", is_commissioner: false, entry_names: ["Al's entry"] },
      { display_name: "Ann", is_commissioner: true, entry_names: [] },
    ]);
  });

  it("rule changes stay in their league", async () => {
    const doc = JSON.stringify({ ...DAY_ONE_RULES, undoMinutes: 1 });
    const [r] = await db.q(service, "select public.publish_rule_set_internal($1, $2, $3::jsonb, 6, 'Shorter undo') as v", [bea, leagueB, doc]);
    const [w] = await db.su("select app.rule_set_for_week($1, 6) as a, app.rule_set_for_week($2, 6) as b", [leagueA, leagueB]);
    expect(w.b).toBe(r.v);
    expect(w.a).not.toBe(r.v);
  });

  it("the scheduled advance looks at every league", async () => {
    const [r] = await db.q(service, "select public.advance_week_internal() as w");
    expect(r.w).toBeNull(); // league A's week has a bet riding; league B has never opened
  });

  it("a game can't move once any league has opened its week", async () => {
    await fails(db.q(member(site), "select public.admin_move_game($1, 5, 'schedule change')", [gA]), "week_already_open");
  });
});

describe("commissioners and members", () => {
  it("a league always keeps a commissioner", async () => {
    await fails(db.q(member(ann), "select public.admin_set_commissioner($1, false, $2)", [ann, leagueA]), "last_commissioner");
    await db.q(member(ann), "select public.admin_set_commissioner($1, true, $2)", [al, leagueA]);
    await db.q(member(al), "select public.admin_set_commissioner($1, false, $2)", [ann, leagueA]);
    expect((await db.q(member(ann), "select role from public.my_leagues() where league_id = $1", [leagueA]))[0].role).toBe("member");
    await fails(db.q(member(ann), "select public.admin_set_commissioner($1, true, $2)", [ann, leagueA]), "commissioner_only");
    await fails(db.q(member(al), "select public.admin_set_commissioner($1, true, $2)", [nobody, leagueA]), "not_member");
  });

  it("someone who manages an entry can't be removed until they're off it", async () => {
    await fails(db.q(member(bea), "select public.admin_remove_member($1, $2)", [bo, leagueB]), "manages_entry");
    await db.q(member(bea), "select public.admin_set_manager($1, $2, false)", [boEntry, bo]);
    await db.q(member(bea), "select public.admin_remove_member($1, $2)", [bo, leagueB]);
    expect(await db.q(member(bo), "select * from public.my_leagues()")).toEqual([]);
  });

  it("with several leagues, a call has to say which", async () => {
    await db.q(member(ann), "select public.join_league($1)", [await code(bea, leagueB)]);
    await fails(db.q(member(ann), "select * from public.standings()"), "league_required");
    expect(await db.q(member(ann), "select name from public.standings(null, null, null, $1)", [leagueB])).toEqual([{ name: "Bo" }]);
  });
});

describe("the commissioner's notes", () => {
  it("the commissioner writes them, every member reads them, and nobody else sees them", async () => {
    await db.q(member(bea), "select public.admin_set_league_notes($1, $2)", [leagueB, "  $20 buy-in.\nTop 3 paid.  "]);
    const [l] = await db.q(member(ann), "select notes, notes_updated_at from public.leagues where id = $1", [leagueB]);
    expect(l.notes).toBe("$20 buy-in.\nTop 3 paid.");
    expect(l.notes_updated_at).not.toBeNull();
    expect(await db.q(member(al), "select notes from public.leagues where id = $1", [leagueB])).toEqual([]);
    await fails(db.q(member(ann), "select public.admin_set_league_notes($1, 'mine now')", [leagueB]), "commissioner_only");
    await fails(db.q(member(bea), "select public.admin_set_league_notes($1, $2)", [leagueB, "x".repeat(4001)]), "notes_too_long");
  });

  it("a change is in the admin log with the old and new text; saving the same text isn't", async () => {
    await db.q(member(bea), "select public.admin_set_league_notes($1, 'Top 2 paid.')", [leagueB]);
    await db.q(member(bea), "select public.admin_set_league_notes($1, 'Top 2 paid.')", [leagueB]);
    const log = await db.q(member(ann), "select before, after from public.audit_log where league_id = $1 and action = 'notes_updated' order by id", [leagueB]);
    expect(log).toEqual([
      { before: { notes: "" }, after: { notes: "$20 buy-in.\nTop 3 paid." } },
      { before: { notes: "$20 buy-in.\nTop 3 paid." }, after: { notes: "Top 2 paid." } },
    ]);
  });
});
