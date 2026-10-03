// The owner's own arrangement: two entries, each shared with a different co-owner, and
// one of those co-owners also has an entry to themselves. Everyone sees and bets on
// exactly the entries they manage: a shared entry's bets show to both its owners before
// kickoff, and the co-owner's own entry stays hidden from the owner like anyone else's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { centerOnWeek4, event, fails, freshDb, gameId, hoursFromNow, ingest, makeLeague, makeUser, member, place, standardLines, undo, type Db } from "./db.ts";

let db: Db;
let you: string, pat: string, sam: string;
let withPat: string, withSam: string, patsOwn: string;
let game: string;
const bets: Record<string, string> = {};

const bet = (entry: string, user: string) =>
  place(db, {
    entry, user, type: "straight", stakeCents: 10_000, potentialPayoutCents: Math.floor((10_000 * 21) / 11),
    legs: [{ gameId: game, market: "spread", side: "home", point: -3, price: -110 }],
  });
const entriesOf = async (user: string) =>
  (await db.q(member(user), "select name from public.my_entries() order by name")).map((r) => r.name);
const sees = async (user: string, slip: string) => ({
  slips: (await db.q(member(user), "select id from public.slips where id = $1", [slip])).length,
  legs: (await db.q(member(user), "select leg_no from public.slip_legs where slip_id = $1", [slip])).length,
  ledger: (await db.q(member(user), "select id from public.ledger where slip_id = $1", [slip])).length,
});
const SHOWN = { slips: 1, legs: 1, ledger: 1 };
const HIDDEN = { slips: 0, legs: 0, ledger: 0 };

beforeAll(async () => {
  db = await freshDb("bl_shared");
  await centerOnWeek4(db);
  you = await makeUser(db, "you@example.com", "You");
  pat = await makeUser(db, "pat@example.com", "Pat");
  sam = await makeUser(db, "sam@example.com", "Sam");
  await db.su("select app.bootstrap_admin('you@example.com')");
  await makeLeague(db, you);
  const add = async (name: string) => (await db.q(member(you), "select public.admin_add_entry($1, 1000000) as id", [name]))[0].id as string;
  withPat = await add("You & Pat");
  withSam = await add("You & Sam");
  patsOwn = await add("Pat's own");
  await ingest(db, [event("GAME", hoursFromNow(5), "Baltimore Ravens", "Pittsburgh Steelers", [{ book: "draftkings", outcomes: standardLines(-3) }])]);
  game = await gameId(db, "GAME");
  await db.q(member(you), "select public.admin_open_next_week(null, 'Start')");
});
afterAll(async () => db?.close());

describe("two shared entries and a co-owner's own entry", () => {
  it("an admin links themselves first, then the co-owners; they can't join an entry someone already has", async () => {
    const link = (entry: string, user: string) => db.q(member(you), "select public.admin_set_manager($1, $2, true)", [entry, user]);
    await link(withPat, you);
    await link(withSam, you);
    await link(withPat, pat);
    await link(withSam, sam);
    await link(patsOwn, pat);
    await fails(link(patsOwn, you), "self_add_blocked");
  });

  it("each person sees the entries they manage", async () => {
    expect(await entriesOf(you)).toEqual(["You & Pat", "You & Sam"]);
    expect(await entriesOf(pat)).toEqual(["Pat's own", "You & Pat"]);
    expect(await entriesOf(sam)).toEqual(["You & Sam"]);
  });

  it("either co-owner can bet on a shared entry, and nobody can bet on an entry they don't manage", async () => {
    bets.patOnShared = await bet(withPat, pat);
    bets.youOnShared = await bet(withPat, you);
    bets.youWithSam = await bet(withSam, you);
    bets.patsOwn = await bet(patsOwn, pat);
    await fails(bet(patsOwn, you), "not_manager");
    await fails(bet(withSam, pat), "not_manager");
    await fails(bet(withPat, sam), "not_manager");
  });

  it("before kickoff, a shared entry's bets show to both its owners and no one else", async () => {
    expect(await sees(you, bets.patOnShared!)).toEqual(SHOWN);
    expect(await sees(pat, bets.youOnShared!)).toEqual(SHOWN);
    expect(await sees(sam, bets.patOnShared!)).toEqual(HIDDEN);
    expect(await sees(sam, bets.youWithSam!)).toEqual(SHOWN);
    expect(await sees(pat, bets.youWithSam!)).toEqual(HIDDEN);
  });

  it("the co-owner's own entry stays hidden from you like anyone else's", async () => {
    expect(await sees(you, bets.patsOwn!)).toEqual(HIDDEN);
    // What you see instead: that it has a bet in, and when.
    expect((await db.q(member(you), "select name from public.hidden_activity(50)")).map((r) => r.name)).toEqual(["Pat's own"]);
    expect((await db.q(member(pat), "select name from public.hidden_activity(50)")).map((r) => r.name)).toEqual(["You & Sam"]);
  });

  it("the standings count riding bets only on your own entries until kickoff, and both owners see the same units", async () => {
    const view = async (user: string) =>
      Object.fromEntries((await db.q(member(user), "select name, is_mine, at_risk_cents::int as at_risk from public.standings()")).map((r) => [r.name, [r.is_mine, r.at_risk]]));
    expect(await view(you)).toEqual({ "You & Pat": [true, 20_000], "You & Sam": [true, 10_000], "Pat's own": [false, 0] });
    expect(await view(pat)).toEqual({ "You & Pat": [true, 20_000], "You & Sam": [false, 0], "Pat's own": [true, 10_000] });
    const available = async (user: string) =>
      (await db.q(member(user), "select available_cents::int as a from public.my_entries() where entry_id = $1", [withPat]))[0].a;
    expect(await available(you)).toBe(980_000);
    expect(await available(pat)).toBe(980_000);
  });

  it("either owner can undo a bet on the shared entry within the undo window, but not one on another entry", async () => {
    await undo(db, bets.patOnShared!, you);
    await fails(undo(db, bets.patsOwn!, you), "not_found");
  });
});
