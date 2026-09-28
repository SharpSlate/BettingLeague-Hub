import { describe, expect, it } from "vitest";
import { deductionCents, requiredMinimumCents, shortfallCents } from "./weekly.ts";

describe("weekly minimum", () => {
  it.each([
    // 30% of 26,909.15 = 8,072.745 -> 8,073 units
    [2_690_915, 807_300],
    // 30% of 15,000 = 4,500
    [1_500_000, 450_000],
    // 30% of 10,527.30 = 3,158.19 -> 3,159
    [1_052_730, 315_900],
    // exactly 3,000 stays 3,000
    [1_000_000, 300_000],
    [0, 0],
    [-500, 0],
  ])("bank %i cents needs %i cents", (bank, required) => {
    expect(requiredMinimumCents(bank, 30)).toBe(required);
  });

  it("the shortfall is what's left to wager, never negative", () => {
    expect(shortfallCents(315_900, 200_000)).toBe(115_900);
    expect(shortfallCents(315_900, 500_000)).toBe(0);
  });

  it("the deduction never takes the bank below zero", () => {
    expect(deductionCents(115_900, 1_000_000)).toBe(115_900);
    expect(deductionCents(115_900, 50_000)).toBe(50_000);
    expect(deductionCents(115_900, -100)).toBe(0);
  });
});
