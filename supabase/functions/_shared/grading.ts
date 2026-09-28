// Grades pending slips from game results, using each slip's own rule set.
import { gradeLeg, gradeSlip } from "./rules/grade.ts";
import type { BetType, Leg, LegResult, RuleSet, SlipResult } from "./rules/types.ts";

export interface GameResult {
  id: string;
  status: "scheduled" | "live" | "final" | "postponed" | "void";
  homeScore: number | null;
  awayScore: number | null;
}

export interface PendingSlip {
  id: string;
  type: BetType;
  stakeCents: number;
  teaserPoints: number | null;
  rules: RuleSet;
  legs: (Leg & { legNo: number })[];
}

export interface Settlement {
  slipId: string;
  result: Exclude<SlipResult, "pending">;
  payoutCents: number;
  legResults: { legNo: number; result: LegResult }[];
}

export function legResult(leg: Leg, game: GameResult | undefined, teaserPoints: number | null): LegResult {
  if (!game) return "pending";
  if (game.status === "void") return "void";
  if (game.status !== "final" || game.homeScore === null || game.awayScore === null) return "pending";
  return gradeLeg(leg, { homeScore: game.homeScore, awayScore: game.awayScore }, teaserPoints);
}

/** The settlements that can be made now. Slips still waiting on a game are left out. */
export function gradePending(slips: PendingSlip[], games: Map<string, GameResult>): Settlement[] {
  const out: Settlement[] = [];
  for (const slip of slips) {
    const teaser = slip.type === "teaser" ? slip.teaserPoints : null;
    const results = slip.legs.map((leg) => legResult(leg, games.get(leg.gameId), teaser));
    const grade = gradeSlip(slip, results, slip.rules);
    if (grade.result === "pending") continue;
    out.push({
      slipId: slip.id,
      result: grade.result,
      payoutCents: grade.payoutCents,
      legResults: slip.legs.map((leg, i) => ({ legNo: leg.legNo, result: results[i]! })),
    });
  }
  return out;
}
