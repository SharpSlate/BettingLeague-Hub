// The server-side check a slip gets before it goes to the database: the shared
// rules, then each leg against the league's current line. Pure, so it's tested
// directly; the place-slip function supplies the data.
import { effectivePrice, quoteSlip, type Quote } from "./rules/price.ts";
import { isProp } from "./rules/props.ts";
import type { BetType, Leg, Problem, RuleSet } from "./rules/types.ts";
import { validateSlip, type ValidationContext } from "./rules/validate.ts";

export interface CurrentLine {
  gameId: string;
  market: Leg["market"];
  side: Leg["side"];
  point: number | null;
  price: number;
  source: string;
  /** A player prop's player; null or absent for the game's own lines. */
  player?: string | null;
}

export interface GameInfo {
  id: string;
  /** When betting on the game closes: its kickoff, or the feed's own start time if that's earlier. */
  locksAt: Date;
  status: string;
  week: number;
}

export interface PlacementInput {
  entryId: string;
  type: BetType;
  teaserPoints?: number | null;
  stakeCents: number;
  legs: Leg[];
}

export type PlacementCheck =
  | { ok: true; quote: Quote }
  | { ok: false; kind: "invalid"; problems: Problem[] }
  | { ok: false; kind: "moved"; lines: { leg: number; point: number | null; price: number }[] };

export function checkPlacement(
  input: PlacementInput,
  rules: RuleSet,
  ctx: ValidationContext,
  openWeek: number,
  games: Map<string, GameInfo>,
  lines: CurrentLine[],
  now: Date,
  /** When the latest props import was pulled at the books, and how old it may be to bet on. */
  props: { pulledAt: Date | null; maxAgeMinutes: number } = { pulledAt: null, maxAgeMinutes: 0 },
): PlacementCheck {
  const problems = validateSlip(input, rules, ctx);
  input.legs.forEach((leg, i) => {
    const g = games.get(leg.gameId);
    if (!g) problems.push({ code: "unknown_game", message: "That game isn't on the board.", leg: i });
    else if (g.week !== openWeek) problems.push({ code: "game_not_this_week", message: "That game isn't in this week's slate.", leg: i });
    else if (g.status !== "scheduled" || g.locksAt <= now) problems.push({ code: "game_started", message: "That game has started.", leg: i });
  });
  if (input.legs.some((l) => isProp(l.market))
      && (!props.pulledAt || now.getTime() - props.pulledAt.getTime() > props.maxAgeMinutes * 60_000)) {
    problems.push({ code: "props_stale", message: "Player props haven't been updated recently enough to bet on. Try again after the next update." });
  }
  if (problems.length) return { ok: false, kind: "invalid", problems };

  const moved: { leg: number; point: number | null; price: number }[] = [];
  const unavailable: Problem[] = [];
  input.legs.forEach((leg, i) => {
    const line = lines.find((l) => l.gameId === leg.gameId && l.market === leg.market && l.side === leg.side
      && (l.player ?? null) === (leg.player ?? null));
    if (!line) {
      unavailable.push({ code: "line_unavailable", message: "That line is off the board right now.", leg: i });
      return;
    }
    const price = input.type === "teaser" ? line.price : effectivePrice(line.market, line.price, rules);
    if (line.point !== leg.point || (input.type !== "teaser" && price !== leg.price)) {
      moved.push({ leg: i, point: line.point, price });
    }
  });
  if (unavailable.length) return { ok: false, kind: "invalid", problems: unavailable };
  if (moved.length) return { ok: false, kind: "moved", lines: moved };
  return { ok: true, quote: quoteSlip(input, rules) };
}
