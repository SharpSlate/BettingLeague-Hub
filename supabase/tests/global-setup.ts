// Builds a template database once per test run: the Supabase stub plus every
// migration in order. Each test file then clones it (see db.ts).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
export const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";
export const TEMPLATE = "bl_template";

export function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const old = await admin.query("select datname from pg_database where datname like 'bl_%'");
  for (const row of old.rows) {
    await admin.query(`update pg_database set datistemplate = false where datname = $1`, [row.datname]);
    await admin.query(`drop database if exists ${row.datname} with (force)`);
  }
  await admin.query(`create database ${TEMPLATE}`);
  await admin.end();

  const db = new pg.Client({ connectionString: databaseUrl(TEMPLATE) });
  await db.connect();
  await db.query(readFileSync(join(here, "stub.sql"), "utf8"));
  const migrations = join(here, "..", "migrations");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await db.query(readFileSync(join(migrations, file), "utf8"));
    } catch (e) {
      throw new Error(`migration ${file} failed: ${(e as Error).message}`);
    }
  }
  await db.end();

  const again = new pg.Client({ connectionString: ADMIN_URL });
  await again.connect();
  await again.query(`update pg_database set datistemplate = true where datname = $1`, [TEMPLATE]);
  await again.end();
}
