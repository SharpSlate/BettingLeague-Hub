// The league rules in plain English, generated from a rule-set document, so the
// Rules page and the bet slip always say exactly what the engine enforces.
import type { RuleSet } from "@rules";
import { odds, units } from "./format.ts";

export interface RuleSection {
  title: string;
  items: string[];
}

const marketList = (m: string[]) =>
  m.map((x) => (x === "moneyline" ? "moneylines" : `${x}s`)).join(m.length > 2 ? ", " : " and ").replace(/, ([^,]*)$/, " and $1");

export function pushRuleText(r: RuleSet): string {
  switch (r.betTypes.teaser.pushRule) {
    case "reduce":
      return "If a teaser leg pushes, it drops out and the card pays the table price for the legs that are left; a single leg left gets the 2-leg price. If every leg pushes, the stake comes back.";
    case "refund":
      return "If a teaser leg pushes and no leg loses, the whole stake comes back.";
    case "lose":
      return "If a teaser leg pushes, the card loses.";
  }
}

export function describeRules(r: RuleSet): RuleSection[] {
  const { straight, parlay, teaser } = r.betTypes;
  const bets: string[] = [];
  if (straight.enabled) {
    bets.push(
      `Straight bets on ${marketList(straight.markets)}` +
        (r.pricing.straight === "flat"
          ? `. Spreads and totals pay ${odds(r.pricing.flatPrice)}; moneylines pay the posted price.`
          : ", at the sportsbook's posted price."),
    );
  }
  if (parlay.enabled) bets.push(`Parlays of ${parlay.minLegs} to ${parlay.maxLegs} legs, any mix of ${marketList(parlay.markets)}. The legs' odds multiply.`);
  if (teaser.enabled) {
    bets.push(
      `Teasers of ${teaser.minLegs} to ${teaser.maxLegs} legs at ${teaser.points.join(", ")} points, ${teaser.totalsNeedSpread ? "with at least one spread whenever a total is teased" : "spreads and totals mixed any way"}. Moneylines can't be teased. Each leg moves by the teaser points in your favor, and the card pays the price in the teaser table.`,
    );
  }

  const same = (s: typeof parlay.sameGame) => {
    const allowed: string[] = [];
    const blocked: string[] = [];
    (s.spreadTotal ? allowed : blocked).push("a spread and a total");
    (s.moneylineTotal ? allowed : blocked).push("a moneyline and a total");
    (s.spreadMoneyline ? allowed : blocked).push("a spread and either moneyline");
    (s.bothSides ? allowed : blocked).push("both sides of one market (over and under, both spreads, both moneylines)");
    return { allowed, blocked };
  };
  const ps = same(parlay.sameGame);
  const ts = same(teaser.sameGame);
  const sameGame: string[] = [];
  if (parlay.enabled) {
    if (ps.allowed.length) sameGame.push(`Parlays may combine ${ps.allowed.join("; ")} from the same game.`);
    if (ps.blocked.length) sameGame.push(`Parlays may not combine ${ps.blocked.join("; ")} from the same game.`);
  }
  if (teaser.enabled) {
    sameGame.push(ts.blocked.length ? `Teasers may not combine ${ts.blocked.join("; ")} from the same game.` : "Teasers may combine any legs from the same game.");
  }
  sameGame.push("The same pick can't be on a slip twice.");

  const pushes = [
    "A straight bet that pushes returns the stake.",
    "A pushed or voided parlay leg drops out and the rest are multiplied. If every leg pushes, the stake comes back.",
    pushRuleText(r),
    "A leg on a game that's voided drops out, and the card is priced on the legs that are left.",
  ];

  const s = r.stake;
  const stakes = [
    `Stakes run from ${units(s.minUnits * 100)} to ${units(s.maxUnits * 100)} units${s.incrementUnits === 1 ? ", in whole units" : `, in steps of ${s.incrementUnits}`}, and never more than your available units.`,
  ];
  if (s.maxPctOfBank !== null) stakes.push(`No single bet can be more than ${s.maxPctOfBank}% of your bank.`);

  const wm = r.weeklyMinimum;
  const weekly = [
    `Each week you must wager at least ${wm.pct}% of your bank as it stood when the week opened, rounded up to a whole unit.`,
    "Pushed bets count toward it. Bets you undo and bets an admin voids don't.",
    wm.penalty === "deduct_shortfall"
      ? "Whatever you're short when the week closes is taken off your bank. It never takes a bank below zero."
      : wm.penalty === "warn"
        ? "Entries that fall short get a warning; there's no automatic penalty."
        : "It's shown for information only.",
  ];

  const timing = [
    "A week opens for betting once the previous week's last game is final, normally after the Monday night game. You can't bet ahead. An admin can open the next week by hand, for example around a postponed game.",
    r.lock === "game_kickoff" ? "Each leg locks at its own game's kickoff." : "Betting for the week closes at its first kickoff.",
    r.undoMinutes > 0 ? `You can undo a bet within ${r.undoMinutes} minutes of placing it, as long as none of its games has started. After that, bets are final.` : "Bets are final once placed.",
    r.visibility === "kickoff_per_leg"
      ? "Other members see your picks as each game kicks off, leg by leg. Before that they only see that you made a pick."
      : r.visibility === "on_placement"
        ? "Everyone's picks are visible as soon as they're placed."
        : "Everyone's picks for the week are revealed when the week's first game kicks off.",
  ];

  const bank = [
    `New entries start with ${units(r.bank.startUnits * 100)} units${r.bank.bonusUnits ? `, plus a ${units(r.bank.bonusUnits * 100)}-unit sign-up bonus where the commissioner grants one` : ""}.`,
    "Standings rank entries by bank. Ties go to the higher net, then the higher total winnings.",
    "Units are play money. Nothing on this site is real money.",
  ];

  return [
    { title: "Bets you can make", items: bets },
    { title: "Same-game combinations", items: sameGame },
    { title: "Pushes and voids", items: pushes },
    { title: "Stakes", items: stakes },
    { title: "Weekly minimum", items: weekly },
    { title: "Timing and visibility", items: timing },
    { title: "Banks and standings", items: bank },
  ];
}
