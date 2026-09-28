import { describe, expect, it } from "vitest";
import { easternDayStart, nextDay, parseNumber, toCents } from "./format.ts";

describe("parseNumber", () => {
  it("reads a typographic minus as a minus, as the Rules page prints prices", () => {
    expect(parseNumber("\u2212110")).toBe(-110);
    expect(parseNumber("\u2013110")).toBe(-110);
    expect(parseNumber("-110")).toBe(-110);
    expect(parseNumber("+180")).toBe(180);
    expect(parseNumber(" 2,950 ")).toBe(2950);
    expect(parseNumber("6.5")).toBe(6.5);
  });
  it("gives NaN for anything that isn't a whole number, rather than dropping a sign", () => {
    for (const t of ["", "-", "\u2212", "+", "1-10", "abc", "--110", "1e3"]) expect(parseNumber(t)).toBeNaN();
  });
});

describe("Eastern day boundaries", () => {
  it("start at midnight Eastern, in daylight time and standard time", () => {
    expect(easternDayStart("2026-10-04")).toBe("2026-10-04T04:00:00.000Z");
    expect(easternDayStart("2026-12-06")).toBe("2026-12-06T05:00:00.000Z");
    // The day the clocks go back.
    expect(easternDayStart("2026-11-01")).toBe("2026-11-01T04:00:00.000Z");
    expect(easternDayStart("2026-11-02")).toBe("2026-11-02T05:00:00.000Z");
  });
  it("step to the next calendar day across month and year ends", () => {
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("toCents", () => {
  it("reads units with up to 2 decimals", () => {
    expect(toCents("1,500.25")).toBe(150_025);
    expect(toCents("100")).toBe(10_000);
    expect(toCents("1.005")).toBeNull();
    expect(toCents("-5")).toBeNull();
  });
});
