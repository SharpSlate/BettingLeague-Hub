// Helpers for the database tests: a fresh database per test file, running queries
// as a signed-in member, the service role or signed out, and building fixtures.
import pg from "pg";
import { ADMIN_URL, databaseUrl, TEMPLATE } from "./global-setup.ts";

export type Who = { role: "authenticated"; userId: string } | { role: "service_role" } | { role: "anon" };

export interface Db {
  pool: pg.Pool;
  /** Runs fn in a transaction as the given role, the way PostgREST would. */
  as<T>(who: Who, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  /** Runs one statement as the given role. */
  q<R extends pg.QueryResultRow = any>(who: Who, sql: string, params?: unknown[]): Promise<R[]>;
  /** Runs one statement as the superuser (fixtures and time travel). */
  su<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<R[]>;
  close(): Promise<void>;
}

export async function freshDb(name: string): Promise<Db> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name} template ${TEMPLATE}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 6 });

  async function as<T>(who: Who, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${who.role}`);
      if (who.role === "authenticated") await c.query("select set_config('request.jwt.claim.sub', $1, true)", [who.userId]);
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  return {
    pool,
    as,
    q: (who, sql, params) => as(who, async (c) => (await c.query(sql, params)).rows),
    su: async (sql, params) => (await pool.query(sql, params)).rows,
    close: () => pool.end(),
  };
}

export const service: Who = { role: "service_role" };
export const anon: Who = { role: "anon" };
export const member = (userId: string): Who => ({ role: "authenticated", userId });

export async function makeUser(db: Db, email: string, displayName?: string): Promise<string> {
  const rows = await db.su("insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id", [
    email,
    displayName ? { display_name: displayName } : {},
  ]);
  return rows[0].id;
}

/** Shifts the season's week windows so week 4 started 3 days ago and ends in 4 days. */
export async function centerOnWeek4(db: Db): Promise<void> {
  await db.su(`
    with shift as (select now() - interval '3 days' - starts_at as d from public.weeks where week = 4)
    update public.weeks set starts_at = starts_at + (select d from shift), ends_at = ends_at + (select d from shift)`);
}

export interface Outcome {
  market: "spread" | "total" | "moneyline";
  side: "home" | "away" | "over" | "under";
  point: number | null;
  price: number;
}

export function standardLines(spread = -3, total = 47.5, mlHome = -150, mlAway = 130): Outcome[] {
  return [
    { market: "spread", side: "home", point: spread, price: -110 },
    { market: "spread", side: "away", point: -spread, price: -110 },
    { market: "total", side: "over", point: total, price: -110 },
    { market: "total", side: "under", point: total, price: -110 },
    { market: "moneyline", side: "home", point: null, price: mlHome },
    { market: "moneyline", side: "away", point: null, price: mlAway },
  ];
}

export interface Event {
  id: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  books: { book: string; outcomes: Outcome[] }[];
}

export function event(id: string, kickoff: Date, homeTeam: string, awayTeam: string, books: Event["books"]): Event {
  return { id, commenceTime: kickoff.toISOString(), homeTeam, awayTeam, books };
}

export async function ingest(db: Db, events: Event[], trigger = "schedule"): Promise<void> {
  await db.q(service, "select public.ingest_lines_internal($1, $2::jsonb, 3, 90000)", [trigger, JSON.stringify(events)]);
}

export async function gameId(db: Db, oddsApiId: string): Promise<string> {
  return (await db.su("select id from public.games where odds_api_id = $1", [oddsApiId]))[0].id;
}

export const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

export interface PlaceArgs {
  entry: string;
  user: string;
  type: "straight" | "parlay" | "teaser";
  teaserPoints?: number | null;
  stakeCents: number;
  quotedAmerican?: number;
  potentialPayoutCents?: number;
  ruleSetVersion?: number;
  legs: { gameId: string; market: string; side: string; point: number | null; price: number }[];
  clientRef?: string;
}

export async function place(db: Db, a: PlaceArgs, c?: pg.PoolClient): Promise<string> {
  const sql = "select public.place_slip_internal($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::uuid) as id";
  const params = [
    a.entry,
    a.user,
    a.type,
    a.teaserPoints ?? null,
    a.stakeCents,
    a.quotedAmerican ?? -110,
    a.potentialPayoutCents ?? a.stakeCents * 3,
    a.ruleSetVersion ?? 1,
    JSON.stringify(a.legs),
    a.clientRef ?? null,
  ];
  if (c) return (await c.query(sql, params)).rows[0].id;
  return (await db.q(service, sql, params))[0].id;
}

/** Undoes a bet for a member, as the place-slip Edge Function does after refreshing the lines. */
/**
 * Undoes a bet the way the place-slip function does: every check but the lines, then
 * (where the lines are checked) lines fetched after that, then the undo. The tests set
 * the lines up themselves, so the latest pull stands in for the function's own pull.
 */
export async function undo(db: Db, slip: string, user: string): Promise<void> {
  const since = (await db.q(service, "select public.undo_slip_internal($1, $2, true) as since", [slip, user]))[0].since as Date | null;
  if (since) {
    await db.su(
      `update public.line_pulls set fetched_after = $1
        where id = (select id from public.line_pulls where kind = 'lines' and ok order by at desc limit 1)`,
      [since],
    );
  }
  await db.q(service, "select public.undo_slip_internal($1, $2, false, $3)", [slip, user, since]);
}

/** Expects the promise to fail with a message containing the given text. */
export async function fails(p: Promise<unknown>, text: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes(text)) throw new Error(`expected an error containing "${text}", got "${msg}"`);
    return;
  }
  throw new Error(`expected an error containing "${text}", but it succeeded`);
}
