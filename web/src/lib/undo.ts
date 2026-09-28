// What the placed-bets toast shows after its Undo.
import type { UndoResult } from "./types.ts";

/** Refusals worth trying again soon: the lines couldn't be pulled just then. */
const RETRY = new Set(["undo_lines_stale", "error"]);

export interface AfterUndo {
  /** The bets worth another try; they keep the Undo button. */
  retry: string[];
  note: string;
  /** What the final refusals so far came to, carried into the next try's note. */
  final?: string;
}

/**
 * null once every bet is undone and none was refused for good. Otherwise what the toast
 * says: how many were undone, how many can't be (the line moved, the game started) and
 * why, and how many can be tried again and why. A final refusal stays on the note after
 * later tries, so a bet still riding never looks undone. `final` is the last call's;
 * `word` turns a refusal's message into the text shown.
 */
export function afterUndo(results: UndoResult[], word: (message: string) => string, final?: string): AfterUndo | null {
  const refused = results.filter((r): r is Extract<UndoResult, { undone: false }> => !r.undone);
  const finals = refused.filter((r) => !RETRY.has(r.code));
  const retry = refused.filter((r) => RETRY.has(r.code));
  const kept = finals.length ? `${finals.length} can't be undone: ${word(finals[0]!.message)}` : final;
  if (!retry.length && !kept) return null;
  const undone = results.length - refused.length;
  const parts = [
    undone ? `${undone} undone` : "",
    kept ?? "",
    retry.length ? `${retry.length} to try again: ${word(retry[0]!.message)}` : "",
  ].filter(Boolean);
  return { retry: retry.map((r) => r.slipId), note: parts.join(" · "), final: kept };
}
