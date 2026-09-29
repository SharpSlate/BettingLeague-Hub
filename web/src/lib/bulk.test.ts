import { describe, expect, it } from "vitest";
import { parsePairings, parseStandings } from "./bulk.ts";

describe("parseStandings", () => {
  it("reads Splash-style numbers, records with or without pushes, and tabs or bars", () => {
    const { rows, errors } = parseStandings([
      "# name | bank | net | record | risk | return",
      "Entry A | 33,213.70 | +18,213.70 | 4-7 | 56,000 | 74,213.70",
      "Entry B\t0.28\t-14,999.72\t1-5-2\t16002\t1002.28\t10",
      "",
    ].join("\n"));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { name: "Entry A", bankCents: 3_321_370, netCents: 1_821_370, wins: 4, losses: 7, pushes: 0, riskCents: 5_600_000, returnCents: 7_421_370, winningsCents: 0 },
      { name: "Entry B", bankCents: 28, netCents: -1_499_972, wins: 1, losses: 5, pushes: 2, riskCents: 1_600_200, returnCents: 100_228, winningsCents: 1_000 },
    ]);
  });

  it("names the line and the problem instead of guessing", () => {
    const { rows, errors } = parseStandings([
      "Entry A | 100 | 0 | 4-7",
      "Entry B | -5 | 0 | 1-1 | 10 | 5",
      "Entry C | 100 | 0 | four | 10 | 5",
      "Entry D | 100 | 0 | 1-1 | 10 | 5",
      "entry d | 100 | 0 | 1-1 | 10 | 5",
    ].join("\n"));
    expect(rows.map((r) => r.name)).toEqual(["Entry D"]);
    expect(errors).toEqual([
      "Line 1: needs name | bank | net | record | risk | return.",
      "Line 2 (Entry B): an amount isn't a number of units.",
      "Line 3 (Entry C): the record should look like 5-2 or 5-2-1.",
      "Line 5: entry d is listed twice.",
    ]);
  });
});

describe("parsePairings", () => {
  it("reads entry, email and an optional display name", () => {
    const { rows, errors } = parsePairings("Entry A | Someone@Example.com | Sam\nEntry B | sam@example.com\nEntry C | not-an-email | X");
    expect(rows).toEqual([
      { entryName: "Entry A", email: "someone@example.com", displayName: "Sam" },
      { entryName: "Entry B", email: "sam@example.com", displayName: "" },
    ]);
    expect(errors).toEqual(['Line 3 (Entry C): "not-an-email" isn\'t an email address.']);
  });
});
