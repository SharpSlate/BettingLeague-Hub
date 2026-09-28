// The league rules in plain English, generated from a rule-set document, so the
// Rules page and the bet slip always say exactly what the engine enforces.
import { requiredMinimumCents, teaserPrice, type Market, type RuleSet, type SameGameRules } from "@rules";
import { odds, point, units } from "./format.ts";
import type { League } from "./types.ts";

/** A rule as a bullet: plain text, or a short bold lead-in followed by the detail. */
export type RuleItem = string | { lead: string; text: string };

export interface RuleSection {
  id: string;
  title: string;
  /** One line on what the section covers. */
  intro?: string;
  items: RuleItem[];
  /** A worked example, where one helps. */
  example?: string;
}

export interface Glance {
  label: string;
  value: string;
  detail?: string;
}

export interface RulesPage {
  glance: Glance[];
  sections: RuleSection[];
}

const BOOKS: Record<string, string> = { draftkings: "DraftKings", fanduel: "FanDuel" };
const bookName = (b: string) => BOOKS[b] ?? b;

const marketList = (m: Market[]) =>
  m.map((x) => (x === "moneyline" ? "moneylines" : `${x}s`)).join(m.length > 2 ? ", " : " and ").replace(/, ([^,]*)$/, " and $1");

/** "08:00" -> "8am", "13:30" -> "1:30pm". */
function clockText(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

const decimal = (american: number) => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);

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

/** The undo rule in a few words, for the bet slip. */
export function undoText(r: RuleSet): string {
  if (r.undoMinutes <= 0) return "Bets are final once placed.";
  return `You can undo within ${r.undoMinutes} minutes${r.undoAfterLineMove ? "" : " if the line hasn't moved"}.`;
}

/** What each leg must win, on average, for a teaser card at the first points option to break even. */
export function teaserBreakEvenText(r: RuleSet): string | null {
  const t = r.betTypes.teaser;
  const pts = t.points[0];
  if (!t.enabled || pts === undefined) return null;
  const counts = [...new Set([2, 3, t.maxLegs])].filter((n) => n >= 2 && n <= t.maxLegs);
  const parts = counts.flatMap((n) => {
    const price = teaserPrice(r, pts, n);
    return price === null ? [] : [{ n, pct: Math.round(100 * (1 / decimal(price)) ** (1 / n)) }];
  });
  if (!parts.length) return null;
  // "72% of the time on a 2-leg card, 71% on 3 legs and 73% on 10"
  const list = parts
    .map((p, i) => (i === 0 ? `${p.pct}% of the time on a ${p.n}-leg card` : i === parts.length - 1 && i > 1 ? `${p.pct}% on ${p.n}` : `${p.pct}% on ${p.n} legs`))
    .join(", ")
    .replace(/, ([^,]*)$/, " and $1");
  return `To break even at ${pts} points, each leg has to win about ${list}.`;
}

function sameGameItems(r: RuleSet): RuleItem[] {
  const { parlay, teaser } = r.betTypes;
  const none = (s: SameGameRules) => !s.spreadTotal && !s.moneylineTotal && !s.spreadMoneyline && !s.bothSides;
  if ((!parlay.enabled || none(parlay.sameGame)) && (!teaser.enabled || none(teaser.sameGame))) {
    return [{
      lead: "One game, one leg.",
      text: "A parlay or teaser can't include two legs from the same game. Legs from one game tend to win or lose together (a big favorite covering and the over, say), so multiplying their odds would overpay.",
    }];
  }
  const describe = (s: SameGameRules) => {
    const allowed: string[] = [];
    const blocked: string[] = [];
    (s.spreadTotal ? allowed : blocked).push("a spread and a total");
    (s.moneylineTotal ? allowed : blocked).push("a moneyline and a total");
    (s.spreadMoneyline ? allowed : blocked).push("a spread and either moneyline");
    (s.bothSides ? allowed : blocked).push("both sides of one market");
    return { allowed, blocked };
  };
  const items: RuleItem[] = [];
  for (const [name, on, s] of [["Parlays", parlay.enabled, parlay.sameGame], ["Teasers", teaser.enabled, teaser.sameGame]] as const) {
    if (!on) continue;
    const d = describe(s);
    const text = [
      d.allowed.length ? `may combine ${d.allowed.join("; ")} from the same game` : "",
      d.blocked.length ? `${d.allowed.length ? "but not" : "may not combine"} ${d.blocked.join("; ")}` : "",
    ].filter(Boolean).join(", ");
    items.push({ lead: `${name} from one game.`, text: `${name} ${text}.` });
  }
  return items;
}

export function rulesPage(r: RuleSet, league: League | null): RulesPage {
  const { straight, parlay, teaser } = r.betTypes;
  const wm = r.weeklyMinimum;
  const s = r.stake;
  const books = league?.books ?? [];
  const pts = teaser.points[0];

  // ---- at a glance
  const types = [straight.enabled && "straight", parlay.enabled && "parlay", teaser.enabled && "teaser"].filter(Boolean) as string[];
  const glance: Glance[] = [
    { label: "Starting bank", value: `${units(r.bank.startUnits * 100)} units`, detail: "for new entries" },
    {
      label: "Weekly minimum",
      value: `${wm.pct}% of your bank`,
      detail: wm.penalty === "deduct_shortfall" ? "any shortfall comes off your bank" : wm.penalty === "warn" ? "a warning if you fall short" : "for information only",
    },
    { label: "Lines", value: books[0] ? bookName(books[0]) : "The posted price", detail: books[1] ? `${bookName(books[1])} if ${bookName(books[0]!)} has none` : undefined },
    {
      label: "Bets",
      value: types.map((t, i) => (i ? t : t[0]!.toUpperCase() + t.slice(1))).join(", "),
      detail: [parlay.enabled && `parlays ${parlay.minLegs}–${parlay.maxLegs} legs`, teaser.enabled && `teasers ${teaser.minLegs}–${teaser.maxLegs}`].filter(Boolean).join(", ") || undefined,
    },
    { label: "Stakes", value: `${units(s.minUnits * 100)} to ${units(s.maxUnits * 100)} units`, detail: "never more than you have available" },
    { label: "Bets lock", value: r.lock === "game_kickoff" ? "At kickoff" : "At the week's first kickoff", detail: r.lock === "game_kickoff" ? "each leg at its own game" : "for the whole week" },
    {
      label: "Undo",
      value: r.undoMinutes > 0 ? `Within ${r.undoMinutes} minutes` : "Not allowed",
      detail: r.undoMinutes > 0 ? (r.undoAfterLineMove ? "before kickoff" : "if the line hasn't moved") : undefined,
    },
    {
      label: "Picks shown",
      value: r.visibility === "kickoff_per_leg" ? "At kickoff" : r.visibility === "on_placement" ? "When placed" : "At the week's first kickoff",
      detail: r.visibility === "kickoff_per_leg" ? "leg by leg, to everyone" : undefined,
    },
  ];

  // ---- the bets
  const bets: RuleItem[] = [];
  if (straight.enabled) {
    bets.push({ lead: "Straight bet.", text: `One pick, on ${marketList(straight.markets)}, at the posted price${r.pricing.straight === "flat" ? ` (spreads and totals pay a flat ${odds(r.pricing.flatPrice)})` : ""}.` });
  }
  if (parlay.enabled) {
    bets.push({ lead: "Parlay.", text: `${parlay.minLegs} to ${parlay.maxLegs} legs, any mix of ${marketList(parlay.markets)}. Every leg has to win, and the legs' odds multiply: two −110 legs pay about +264.` });
  }
  if (teaser.enabled) {
    bets.push({
      lead: "Teaser.",
      text: `${teaser.minLegs} to ${teaser.maxLegs} legs of ${marketList(teaser.markets)}, at ${teaser.points.join(", ")} points. Each leg's number moves by the teaser points in your favor, every leg has to win, and the card pays the price in the table below; the legs' own prices don't count. Moneylines can't be teased.${teaser.totalsNeedSpread ? " A total can only be teased alongside a spread." : ""}`,
    });
  }
  const teaserExample = teaser.enabled && pts !== undefined && teaserPrice(r, pts, 2) !== null
    ? `A ${pts}-point teaser moves Ravens ${point(-7.5)} to ${point(-7.5 + pts)}, and an over 47.5 to over ${47.5 - pts}. If both legs win, a 2-leg card pays ${odds(teaserPrice(r, pts, 2)!)}.`
    : undefined;

  // ---- lines and prices
  const lines: RuleItem[] = [];
  if (league && books[0]) {
    lines.push({
      lead: "Where lines come from.",
      text: `${bookName(books[0])}, through The Odds API${books[1] ? `. When ${bookName(books[0])} doesn't offer a line, ${bookName(books[1])}'s is used` : ""}. The commissioner can also set or take down a line by hand; it shows on the board as "Commissioner line".`,
    });
    lines.push({
      lead: "When they update.",
      text: `Every ${league.pullEveryMinutes} minutes from ${clockText(league.pullWindowStart)} to ${clockText(league.pullWindowEnd)} Eastern, every ${league.pullNearKickoffMinutes} minutes in the ${league.nearKickoffHours} hours before a kickoff, and right before any bet or undo if they're more than 2 minutes old.`,
    });
  }
  lines.push({
    lead: "Prices.",
    text: r.pricing.straight === "flat"
      ? `Spreads and totals, in straight bets and parlays, pay a flat ${odds(r.pricing.flatPrice)}; moneylines pay the posted price. Teasers pay the teaser table.`
      : "Straight bets and parlay legs pay the posted price. Teasers pay the teaser table instead.",
  });
  lines.push({ lead: "If a number moves", text: "while it's on your slip, the site shows you the new one to accept before the bet goes in." });
  lines.push({ lead: "Your bet keeps its line.", text: "Every bet keeps the exact number and price it was placed at, and is graded on those." });

  // ---- combining picks
  const combining: RuleItem[] = [...sameGameItems(r)];
  combining.push(r.acrossBets.oppositeSides
    ? { lead: "Both sides.", text: "You may bet both sides of a game in separate bets." }
    : {
        lead: "No betting both sides.",
        text: "Once you have a bet on one side of a game, you can't bet the other side, even in a separate bet: not the other team (by spread or moneyline, in any mix), and not the over and the under together. More on the same side is fine.",
      });
  combining.push({ lead: "No doubles.", text: "The same pick can't be on a slip twice." });

  // ---- timing and undo
  const timing: RuleItem[] = [
    { lead: "Weeks.", text: "A week opens for betting once the previous week's last game is final, normally after the Monday night game. You can't bet ahead. An admin can open the next week by hand, for example around a postponed game." },
    {
      lead: "Locks.",
      text: r.lock === "game_kickoff"
        ? "Each leg locks at its own game's kickoff, or earlier if the odds feed shows the game starting earlier."
        : "Betting for the week closes at its first kickoff, or earlier if the odds feed shows that game starting earlier.",
    },
    {
      lead: "Undo.",
      text: r.undoMinutes > 0
        ? `You can undo a bet within ${r.undoMinutes} minutes of placing it, as long as none of its games has started${r.undoAfterLineMove ? "" : " and none of its lines has moved since"}, and its week is still open. The stake comes back. Undo is for fixing mistakes${r.undoAfterLineMove ? "" : ", not for taking a bet back after news moves the line"}; after that, bets are final.`
        : "Bets are final once placed.",
    },
    {
      lead: "Who sees your picks.",
      text: r.visibility === "kickoff_per_leg"
        ? "Other members see your picks as each game kicks off, leg by leg. Before that they only see that you made a pick, and when. Admins get no early look."
        : r.visibility === "on_placement"
          ? "Everyone's picks are visible as soon as they're placed."
          : "Everyone's picks for the week are revealed when the week's first game kicks off.",
    },
  ];

  // ---- grading
  const grading: RuleItem[] = [
    { lead: "Straight bets.", text: "A push returns the stake." },
    { lead: "Parlays.", text: "A pushed or voided leg drops out and the rest are multiplied. If every leg pushes, the stake comes back." },
    { lead: "Teasers.", text: pushRuleText(r) },
    { lead: "Called-off games.", text: "A leg on a game that's voided drops out, and the card is priced on the legs that are left." },
    { lead: "Score corrections.", text: "If a final score is corrected, every bet on the game is graded again. Winnings already paid are taken back first, which can leave a bank below zero until it's won back; an entry can't bet while it has nothing available." },
  ];

  // ---- weekly minimum
  const exampleBank = 1_000_000;
  const required = requiredMinimumCents(exampleBank, wm.pct);
  const weekly: RuleItem[] = [
    { lead: "How much.", text: `Each week you must wager at least ${wm.pct}% of your bank as it stood when the week opened, rounded up to a whole unit.` },
    { lead: "What counts.", text: "Pushed bets count, and so do bets on a game that's called off. Bets you undo and bets an admin voids don't." },
    {
      lead: "Falling short.",
      text: wm.penalty === "deduct_shortfall"
        ? "Whatever you're short when the week closes is taken off your bank. It never takes a bank below zero. If an admin voids one of a closed week's bets later, its stake stops counting and the week's deduction is redone."
        : wm.penalty === "warn"
          ? "Entries that fall short get a warning; there's no automatic penalty."
          : "It's shown for information only.",
    },
  ];
  const weeklyExample = wm.penalty === "deduct_shortfall" && required > 0
    ? `With a ${units(exampleBank)}-unit bank when the week opens, you need ${units(required)} units in bets. If you've bet ${units(required - 100_000)} when it closes, ${units(100_000)} comes off your bank.`
    : undefined;

  // ---- fair play
  const fair: RuleItem[] = [
    { lead: "Hidden picks.", text: r.visibility === "kickoff_per_leg" ? "Nobody sees your picks before their games kick off, admins included." : "Nobody sees your picks before they're revealed, admins included." },
    { lead: "An open log.", text: "Every admin action, from score corrections and voids to bank adjustments, hand-set lines and rule changes, needs a reason and is listed in the Admin log for everyone to read." },
    { lead: "Entries with an owner in common", text: "shouldn't bet against each other (opposite sides of the same game). The commissioner gets a list of any that do, once the picks are public." },
    { lead: "Rule changes", text: "take effect only from a week that hasn't opened yet, and every bet is graded under the rules it was placed with." },
    { lead: "Play units only.", text: "The buy-in and prizes are handled offline by the commissioner; this site never takes or holds money." },
  ];

  // ---- banks and standings
  const standings: RuleItem[] = [
    { lead: "Starting bank.", text: `New entries start with ${units(r.bank.startUnits * 100)} units${r.bank.bonusUnits ? `, plus a ${units(r.bank.bonusUnits * 100)}-unit sign-up bonus where the commissioner grants one` : ""}. Entries that came over from Splash kept their Splash bank.` },
    { lead: "Stakes.", text: `From ${units(s.minUnits * 100)} to ${units(s.maxUnits * 100)} units${s.incrementUnits === 1 ? ", in whole units" : `, in steps of ${s.incrementUnits}`}, and never more than your available units.${s.maxPctOfBank !== null ? ` No single bet can be more than ${s.maxPctOfBank}% of your bank.` : ""}` },
    { lead: "Ranking.", text: "Standings rank entries by bank. Ties go to the higher net, then the higher total winnings." },
  ];

  const sections: RuleSection[] = [
    { id: "bets", title: "The bets", intro: "Three kinds of bet, all in play units.", items: bets, example: teaserExample },
    { id: "lines", title: "Lines and prices", intro: "Where the numbers come from, and when they change.", items: lines },
    { id: "combining", title: "Combining picks", intro: "What can go on one slip, and what separate bets can't do together.", items: combining },
    { id: "timing", title: "Locks, undo and picks", intro: "When betting closes, and who sees what.", items: timing },
    { id: "grading", title: "Pushes, voids and corrections", items: grading },
    { id: "minimum", title: "Weekly minimum", intro: "Every entry has to keep betting.", items: weekly, example: weeklyExample },
    { id: "fair", title: "Fair play", intro: "How the league stays even.", items: fair },
    { id: "standings", title: "Banks, stakes and standings", items: standings },
  ];
  return { glance, sections: sections.filter((x) => x.items.length) };
}
