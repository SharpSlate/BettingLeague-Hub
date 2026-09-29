// Grades pending slips from game results, using each slip's own rule set.
import { gradeLeg, gradeSlip } from "./rules/grade.ts";
import type { BetType, Leg, LegResult, RuleSet, SlipResult } from "./rules/types.ts";

export interface GameResult {
  id: string;
  status: "scheduled" | "live" | "final" | "postponed" | "void";
  homeScore: number | null;
  awayScore: number | null;
  /**
   * The game row's version (its updated_at, exactly as the database sent it). A grade
   * carries the versions it was worked out from, and the database refuses it if a game
   * has changed since, e.g. an admin corrected the score in the meantime.
   */
  version?: string;
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
  /** The versions of the slip's games this grade used (see GameResult.version). */
  gameVersions: { gameId: string; version: string }[];
}

export function legResult(leg: Leg, game: GameResult | undefined, teaserPoints: number | null): LegResult {
  if (!game) return "pending";
  if (game.status === "void") return "void";
  if (game.status !== "final" || game.homeScore === null || game.awayScore === null) return "pending";
  return gradeLeg(leg, { homeScore: game.homeScore, awayScore: game.awayScore }, teaserPoints);
}

/**
 * The settlements that can be made now. Slips still waiting on a game are left out,
 * and so is a slip that can't be graded (reported through onError), so one bad slip
 * doesn't stop the rest.
 */
export function gradePending(
  slips: PendingSlip[],
  games: Map<string, GameResult>,
  onError: (slipId: string, e: unknown) => void = (_id, e) => {
    throw e;
  },
): Settlement[] {
  const out: Settlement[] = [];
  for (const slip of slips) {
    const teaser = slip.type === "teaser" ? slip.teaserPoints : null;
    const results = slip.legs.map((leg) => legResult(leg, games.get(leg.gameId), teaser));
    let grade;
    try {
      grade = gradeSlip(slip, results, slip.rules);
    } catch (e) {
      onError(slip.id, e);
      continue;
    }
    if (grade.result === "pending") continue;
    const versions = new Map<string, string>();
    for (const leg of slip.legs) {
      const v = games.get(leg.gameId)?.version;
      if (v !== undefined) versions.set(leg.gameId, v);
    }
    out.push({
      slipId: slip.id,
      result: grade.result,
      payoutCents: grade.payoutCents,
      legResults: slip.legs.map((leg, i) => ({ legNo: leg.legNo, result: results[i]! })),
      gameVersions: [...versions].map(([gameId, version]) => ({ gameId, version })),
    });
  }
  return out;
}
