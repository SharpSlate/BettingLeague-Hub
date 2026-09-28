import { describe, expect, it } from "vitest";
import { DAY_ONE_RULES, type RuleSet } from "@rules";
import { rulesPage, teaserBreakEvenText, undoText } from "./rules-text.ts";
import type { League } from "./types.ts";

const league: League = {
  name: "BALTIMORE DEGENERATES", openWeek: null, timezone: "America/New_York",
  pullWindowStart: "08:00", pullWindowEnd: "01:00", pullEveryMinutes: 30, pullNearKickoffMinutes: 10, nearKickoffHours: 3,
  books: ["draftkings", "fanduel"], lastPullAt: null, creditsRemaining: null,
};
const text = (r: RuleSet, l: League | null = league) =>
  rulesPage(r, l).sections.flatMap((s) => [...s.items.map((i) => (typeof i === "string" ? i : `${i.lead} ${i.text}`)), s.example ?? ""]).join("\n");

describe("the Rules page says what the rules enforce", () => {
  it("covers the day-one rules", () => {
    const t = text(DAY_ONE_RULES);
    expect(t).toContain("A parlay or teaser can't include two legs from the same game.");
    expect(t).toContain("you can't bet the other side, even in a separate bet");
    expect(t).toContain("as long as none of its games has started and none of its lines has moved since");
    expect(t).toContain("Every 30 minutes from 8am to 1am Eastern, every 10 minutes in the 3 hours before a kickoff");
    expect(t).toContain("When DraftKings doesn't offer a line, FanDuel's is used.");
    expect(t).toContain("With a 10,000-unit bank when the week opens, you need 3,000 units in bets. If you've bet 2,000 when it closes, 1,000 comes off your bank.");
    expect(t).toContain("A 6-point teaser moves Ravens −7.5 to −1.5, and an over 47.5 to over 41.5. If every leg wins, a 2-leg card pays −110.");
    expect(t).toContain("The site updates the lines first; if it can't just then, try again in a minute.");
    expect(teaserBreakEvenText(DAY_ONE_RULES)).toBe("To break even at 6 points, each leg has to win about 72% of the time on a 2-leg card, 71% on 3 legs and 73% on 10.");
    expect(undoText(DAY_ONE_RULES)).toBe("You can undo within 5 minutes if the line hasn't moved.");
  });

  it("follows the commissioner's changes", () => {
    const open = { spreadTotal: true, moneylineTotal: true, spreadMoneyline: false, bothSides: false };
    const r: RuleSet = {
      ...DAY_ONE_RULES,
      undoAfterLineMove: true,
      acrossBets: { oppositeSides: true },
      betTypes: { ...DAY_ONE_RULES.betTypes, parlay: { ...DAY_ONE_RULES.betTypes.parlay, sameGame: open } },
      pricing: { straight: "flat", flatPrice: -110 },
    };
    const t = text(r);
    expect(t).toContain("Parlays may combine a spread and a total; a moneyline and a total from the same game, but not a spread and either moneyline; both sides of one market.");
    expect(t).toContain("Teasers can't include two legs from the same game.");
    expect(t).toContain("You may bet both sides of a game in separate bets.");
    expect(t).not.toContain("none of its lines has moved");
    expect(t).toContain("Spreads and totals, in straight bets and parlays, pay a flat −110");
    expect(undoText(r)).toBe("You can undo within 5 minutes.");
  });

  it("the glance tiles sum the rules up", () => {
    const g = Object.fromEntries(rulesPage(DAY_ONE_RULES, league).glance.map((x) => [x.label, `${x.value} | ${x.detail ?? ""}`]));
    expect(g).toEqual({
      "Weekly minimum": "30% of your bank | any shortfall comes off your bank",
      Lines: "DraftKings | FanDuel if DraftKings has none",
      Bets: "Straight, parlay, teaser | parlays 2–10 legs, teasers 2–10",
      Stakes: "1 to 250,000 units | never more than you have available",
      Combining: "One leg per game | never both sides of a game",
      "Bets lock": "At kickoff | each leg at its own game",
      Undo: "Within 5 minutes | if the line hasn't moved",
      "Picks shown": "At kickoff | leg by leg, to everyone",
    });
  });

  it("still reads right before the league settings load", () => {
    const t = text(DAY_ONE_RULES, null);
    expect(t).not.toContain("Where lines come from");
    expect(t).toContain("Straight bets and parlay legs pay the posted price.");
  });

  it("reads right for other rule sets the commissioner could publish", () => {
    const t = DAY_ONE_RULES.betTypes.teaser;
    const r: RuleSet = {
      ...DAY_ONE_RULES,
      undoMinutes: 1,
      weeklyMinimum: { pct: 5, penalty: "deduct_shortfall" },
      betTypes: { ...DAY_ONE_RULES.betTypes, parlay: { ...DAY_ONE_RULES.betTypes.parlay, enabled: false }, teaser: { ...t, minLegs: 3, markets: ["spread"] } },
    };
    const page = rulesPage(r, league);
    const all = text(r);
    expect(page.sections.find((x) => x.id === "bets")!.intro).toBe("Two kinds of bet, all in play units.");
    expect(all).toContain("A 6-point teaser moves Ravens −7.5 to −1.5. If every leg wins, a 3-leg card pays +180.");
    expect(all).toContain("A teaser can't include two legs from the same game.");
    expect(all).toContain("If you've bet 333 when it closes, 167 comes off your bank.");
    expect(all).toContain("within 1 minute of placing it");
    expect(teaserBreakEvenText(r)).toBe("To break even at 6 points, each leg has to win about 71% of the time on a 3-leg card and 73% on 10 legs.");
    const none = rulesPage({ ...DAY_ONE_RULES, weeklyMinimum: { pct: 0, penalty: "none" } }, league);
    expect(none.sections.find((x) => x.id === "minimum")).toMatchObject({ intro: undefined, items: [{ lead: "None.", text: "There's no weekly minimum." }] });
    expect(none.glance.find((g) => g.label === "Weekly minimum")).toEqual({ label: "Weekly minimum", value: "None", detail: undefined });
  });
});
