import { describe, expect, it } from "vitest";
import { americanToDecimal, decimalToAmerican, isValidAmerican, payoutCents, ratio } from "./odds.ts";

// Expected values are worked by hand in the comments and were cross-checked
// with an independent Python Fraction calculation.

describe("americanToDecimal", () => {
  it.each([
    [-110, 21n, 11n], // 1 + 100/110 = 210/110
    [150, 5n, 2n], // 1 + 150/100
    [-375, 19n, 15n], // 1 + 100/375 = 475/375
    [300, 4n, 1n],
    [100, 2n, 1n],
    [-100, 2n, 1n],
    [-120, 11n, 6n], // 220/120
    [-130, 23n, 13n], // 230/130
    [180, 14n, 5n], // 280/100
    [-115, 43n, 23n], // 215/115
  ])("%i -> %i/%i", (odds, num, den) => {
    expect(americanToDecimal(odds)).toEqual({ num, den });
  });

  it("rejects prices between -100 and +100 and non-integers", () => {
    expect(isValidAmerican(-50)).toBe(false);
    expect(isValidAmerican(99)).toBe(false);
    expect(isValidAmerican(-110.5)).toBe(false);
    expect(() => americanToDecimal(-50)).toThrow();
  });
});

describe("decimalToAmerican (display)", () => {
  it("round-trips straight prices and rounds parlays", () => {
    expect(decimalToAmerican(ratio(21n, 11n))).toBe(-110);
    expect(decimalToAmerican(ratio(5n, 2n))).toBe(150);
    // 2205/242 = 9.1116 -> +811
    expect(decimalToAmerican(ratio(2205n, 242n))).toBe(811);
  });
});

describe("payoutCents rounds half up, once", () => {
  it.each([
    // 1,000 units at -110: 100000 x 21/11 = 190909.09 -> 190909
    [100_000, -110, 190_909],
    // 500 at +150: 50000 x 5/2
    [50_000, 150, 125_000],
    // 250 at -375: 25000 x 19/15 = 31666.67 -> 31667
    [25_000, -375, 31_667],
    // 300 at +300: 30000 x 4
    [30_000, 300, 120_000],
    // 1 unit at -110: 100 x 21/11 = 190.91 -> 191
    [100, -110, 191],
    // 7 at -115: 700 x 43/23 = 1308.70 -> 1309
    [700, -115, 1_309],
    // 1 at -800: 100 x 9/8 = 112.5 exactly -> 113
    [100, -800, 113],
  ])("stake %i cents at %i pays %i", (stake, odds, expected) => {
    expect(payoutCents(stake, americanToDecimal(odds))).toBe(expected);
  });

  it("refuses fractional or negative stakes", () => {
    expect(() => payoutCents(10.5, ratio(2n, 1n))).toThrow();
    expect(() => payoutCents(-100, ratio(2n, 1n))).toThrow();
  });
});
