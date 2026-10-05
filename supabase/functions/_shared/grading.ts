// Grades pending slips from game results, using each slip's own rule set.
import { gradeLeg, gradePropLeg, gradeSlip } from "./rules/grade.ts";
import { isProp, playerKey } from "./rules/props.ts";
import type { BetType, Leg, LegResult, PlayerStats, RuleSet, SlipResult } from "./rules/types.ts";

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
  /** "Bills at Dolphins", for messages to the admins. */
  label?: string;
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
  /** Props graded void because their player wasn't found in the box score, for the admins. */
  missingPlayers?: { gameId: string; player: string; why: "missing" | "ambiguous" }[];
}

/** One row of a final game's player stats: from ESPN's box score, or a site admin's. */
export interface StatRow {
  player: string;
  source: "espn" | "admin";
  /** Admin rows only: false says he didn't play. */
  played: boolean;
  stats: PlayerStats;
}

/** A final game's box score. A game missing from the map hasn't had its box score read yet. */
export type Boxes = Map<string, StatRow[]>;

/**
 * A player's stats in a box score, by name: a site admin's row first, then ESPN's (the
 * same name, or failing that a single player with the same first initial and last name,
 * so "Gabe Davis" finds "Gabriel Davis"). "void" when he isn't there (he didn't play,
 * as the books grade it) or an admin says he didn't play; "ambiguous" when two
 * players in the box score have his name.
 */
export function findPlayer(rows: StatRow[], name: string): PlayerStats | "void" | "ambiguous" | "missing" {
  const k = playerKey(name);
  const admin = rows.find((r) => r.source === "admin" && playerKey(r.player) === k);
  if (admin) return admin.played ? admin.stats : "void";
  const espn = rows.filter((r) => r.source === "espn");
  const same = espn.filter((r) => playerKey(r.player) === k);
  if (same.length === 1) return same[0]!.stats;
  if (same.length > 1) return "ambiguous";
  const words = k.split(" ");
  if (words.length >= 2) {
    const initial = words[0]![0];
    const last = words.at(-1);
    const near = espn.filter((r) => {
      const w = playerKey(r.player).split(" ");
      return w.length >= 2 && w[0]![0] === initial && w.at(-1) === last;
    });
    if (near.length === 1) return near[0]!.stats;
    if (near.length > 1) return "ambiguous";
  }
  return "missing";
}

/**
 * A leg's result. A player prop waits for its game's box score; a player who isn't in
 * it (or can't be told apart from another) is graded void, and reported through
 * onMissing so a site admin can enter his stats if he did play.
 */
export function legResult(
  leg: Leg,
  game: GameResult | undefined,
  teaserPoints: number | null,
  boxes?: Boxes,
  onMissing?: (gameId: string, player: string, why: "missing" | "ambiguous") => void,
): LegResult {
  if (!game) return "pending";
  if (game.status === "void") return "void";
  if (game.status !== "final" || game.homeScore === null || game.awayScore === null) return "pending";
  if (isProp(leg.market)) {
    const rows = boxes?.get(leg.gameId);
    if (!rows || !leg.player) return "pending";
    const found = findPlayer(rows, leg.player);
    if (found === "missing" || found === "ambiguous") {
      onMissing?.(leg.gameId, leg.player, found);
      return gradePropLeg(leg, "void");
    }
    return gradePropLeg(leg, found);
  }
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
  boxes: Boxes = new Map(),
): Settlement[] {
  const out: Settlement[] = [];
  for (const slip of slips) {
    const teaser = slip.type === "teaser" ? slip.teaserPoints : null;
    const missingPlayers: NonNullable<Settlement["missingPlayers"]> = [];
    let results: LegResult[];
    try {
      results = slip.legs.map((leg) =>
        legResult(leg, games.get(leg.gameId), teaser, boxes, (gameId, player, why) => missingPlayers.push({ gameId, player, why })));
    } catch (e) {
      onError(slip.id, e);
      continue;
    }
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
      ...(missingPlayers.length ? { missingPlayers } : {}),
    });
  }
  return out;
}
