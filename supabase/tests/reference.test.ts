import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY_ONE_RULES } from "../functions/_shared/rules/defaults.ts";
import { requiredMinimumCents } from "../functions/_shared/rules/weekly.ts";
import { freshDb, type Db } from "./db.ts";

let db: Db;
beforeAll(async () => {
  db = await freshDb("bl_reference");
});
afterAll(async () => db?.close());

describe("reference data", () => {
  it("rule set 1 is exactly the day-one rules in the TypeScript module", async () => {
    const [row] = await db.su("select version, effective_week, document from public.rule_sets");
    expect(row.version).toBe(1);
    expect(row.effective_week).toBe(1);
    expect(row.document).toEqual(DAY_ONE_RULES);
  });

  it("has 32 teams and 23 Tuesday-to-Monday week windows in Eastern time", async () => {
    expect((await db.su("select count(*)::int as n from public.teams"))[0].n).toBe(32);
    const weeks = await db.su(
      "select week, label, to_char(starts_at at time zone 'America/New_York', 'Dy YYYY-MM-DD HH24:MI') as s from public.weeks order by week",
    );
    expect(weeks).toHaveLength(23);
    expect(weeks[0]).toMatchObject({ week: 1, label: "Week 1", s: "Tue 2026-09-08 00:00" });
    expect(weeks[3]).toMatchObject({ week: 4, s: "Tue 2026-09-29 00:00" });
    // Still midnight Eastern after the clocks change on Nov 1.
    expect(weeks[9]).toMatchObject({ week: 10, s: "Tue 2026-11-10 00:00" });
    expect(weeks[18]).toMatchObject({ week: 19, label: "Wild Card" });
  });

  it("the SQL weekly minimum matches the TypeScript one", async () => {
    for (const bank of [2_690_915, 1_500_000, 1_052_730, 1_000_000, 0, 1, 99, 12_345_678]) {
      const [r] = await db.su("select app.required_cents($1, document) as c from public.rule_sets where version = 1", [bank]);
      expect(Number(r.c)).toBe(requiredMinimumCents(bank, 30));
    }
  });
});
