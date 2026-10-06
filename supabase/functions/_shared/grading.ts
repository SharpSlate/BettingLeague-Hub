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
  /**
   * Props graded void because their player isn't in the box score and his props came off
   * the board once inactives were announced (he was ruled out), for the admins.
   */
  ruledOut?: { gameId: string; player: string }[];
}

/** One row of a final game's player stats: from ESPN's box score, or a site admin's. */
export interface StatRow {
  player: string;
  source: "espn" | "admin";
  /** Admin rows only: false says he didn't play. */
  played: boolean;
  stats: PlayerStats;
}

/** What's known of a final game's players. */
export interface GameBox {
  /**
   * Whether the game's box score has been read (from ESPN, directly or sent from the
   * owner's PC). An admin's rows alone aren't a box score: they grade only their players.
   */
  loaded: boolean;
  /** The box score's rows once loaded, and any admin's rows. */
  rows: StatRow[];
  /** Players (by playerKey) whose props came off the board once inactives were announced. */
  ruledOut?: Set<string>;
  /** Set when this run couldn't load the box score, so the admins hear about the wait. */
  failed?: boolean;
}

/** Final games' box scores, by game. A game missing from the map has nothing yet. */
export type Boxes = Map<string, GameBox>;

/**
 * Why a prop waits for an admin: its player isn't in the box score (missing), two players
 * there have his name (ambiguous), only a player with the same first initial and last
 * name is (name, e.g. "Gabe Davis" and "Gabriel Davis"), or the box score couldn't be
 * loaded (no_box).
 */
export type HoldWhy = "missing" | "ambiguous" | "name" | "no_box";

export interface Hold {
  gameId: string;
  player: string;
  why: HoldWhy;
  /** For "name": the box score's player and his stats, for an admin to confirm. */
  candidate?: { player: string; stats: PlayerStats };
}

export type PlayerLookup =
  | { kind: "stats"; stats: PlayerStats }
  /** An admin said he didn't play, or his props came off the board once inactives were out. */
  | { kind: "void"; why: "admin" | "ruled_out" }
  | { kind: "hold"; why: Exclude<HoldWhy, "no_box">; candidate?: Hold["candidate"] }
  /** The box score isn't in yet. */
  | { kind: "wait" };

/**
 * A player's stats for grading his props. An admin's row comes first, box score or not.
 * Otherwise, once the box score is in: the same name there (ignoring suffixes,
 * punctuation and accents), else his props were ruled out (void), else he waits for an
 * admin. A player missing from the box score isn't taken not to have played: a player
 * who plays without a catch, carry, pass or tackle isn't in ESPN's box score either, and
 * at the books his over loses.
 */
export function findPlayer(box: GameBox | undefined, name: string): PlayerLookup {
  const k = playerKey(name);
  const admin = box?.rows.find((r) => r.source === "admin" && playerKey(r.player) === k);
  if (admin) return admin.played ? { kind: "stats", stats: admin.stats } : { kind: "void", why: "admin" };
  if (!box?.loaded) return { kind: "wait" };
  const espn = box.rows.filter((r) => r.source === "espn");
  const same = espn.filter((r) => playerKey(r.player) === k);
  if (same.length === 1) return { kind: "stats", stats: same[0]!.stats };
  if (same.length > 1) return { kind: "hold", why: "ambiguous" };
  const words = k.split(" ");
  if (words.length >= 2) {
    const initial = words[0]![0];
    const last = words.at(-1);
    const near = espn.filter((r) => {
      const w = playerKey(r.player).split(" ");
      return w.length >= 2 && w[0]![0] === initial && w.at(-1) === last;
    });
    if (near.length === 1) return { kind: "hold", why: "name", candidate: { player: near[0]!.player, stats: near[0]!.stats } };
    if (near.length > 1) return { kind: "hold", why: "ambiguous" };
  }
  if (box.ruledOut?.has(k)) return { kind: "void", why: "ruled_out" };
  return { kind: "hold", why: "missing" };
}

/**
 * A leg's result. A player prop waits for its game's box score, and for an admin when
 * his player can't be found in it (reported through onHold). A player ruled out is
 * void (reported through onRuledOut).
 */
export function legResult(
  leg: Leg,
  game: GameResult | undefined,
  teaserPoints: number | null,
  boxes?: Boxes,
  onHold?: (hold: Hold) => void,
  onRuledOut?: (gameId: string, player: string) => void,
): LegResult {
  if (!game) return "pending";
  if (game.status === "void") return "void";
  if (game.status !== "final" || game.homeScore === null || game.awayScore === null) return "pending";
  if (isProp(leg.market)) {
    if (!leg.player) return "pending";
    const box = boxes?.get(leg.gameId);
    const found = findPlayer(box, leg.player);
    switch (found.kind) {
      case "stats":
        return gradePropLeg(leg, found.stats);
      case "void":
        if (found.why === "ruled_out") onRuledOut?.(leg.gameId, leg.player);
        return gradePropLeg(leg, "void");
      case "hold":
        onHold?.({ gameId: leg.gameId, player: leg.player, why: found.why, ...(found.candidate ? { candidate: found.candidate } : {}) });
        return "pending";
      case "wait":
        if (box?.failed) onHold?.({ gameId: leg.gameId, player: leg.player, why: "no_box" });
        return "pending";
    }
  }
  return gradeLeg(leg, { homeScore: game.homeScore, awayScore: game.awayScore }, teaserPoints);
}

/**
 * The settlements that can be made now. Slips still waiting on a game are left out,
 * and so is a slip that can't be graded (reported through onError), so one bad slip
 * doesn't stop the rest. onHold hears about each prop that keeps a slip waiting for an
 * admin.
 */
export function gradePending(
  slips: PendingSlip[],
  games: Map<string, GameResult>,
  onError: (slipId: string, e: unknown) => void = (_id, e) => {
    throw e;
  },
  boxes: Boxes = new Map(),
  onHold?: (slipId: string, hold: Hold) => void,
): Settlement[] {
  const out: Settlement[] = [];
  for (const slip of slips) {
    const teaser = slip.type === "teaser" ? slip.teaserPoints : null;
    const ruledOut: NonNullable<Settlement["ruledOut"]> = [];
    const holds: Hold[] = [];
    let results: LegResult[];
    try {
      results = slip.legs.map((leg) =>
        legResult(leg, games.get(leg.gameId), teaser, boxes, (h) => holds.push(h), (gameId, player) => ruledOut.push({ gameId, player })));
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
    // A slip already decided (a parlay with a losing leg) doesn't wait on anyone.
    if (grade.result === "pending") {
      for (const h of holds) onHold?.(slip.id, h);
      continue;
    }
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
      ...(ruledOut.length ? { ruledOut } : {}),
    });
  }
  return out;
}
