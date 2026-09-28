// What the placed-bets toast shows after its Undo.
import type { UndoResult } from "./types.ts";

/** Refusals worth trying again soon: the lines couldn't be pulled just then. */
const RETRY = new Set(["undo_lines_stale", "error"]);

/**
 * null when every bet was undone. Otherwise the bets worth another try, which keep the
 * Undo button (none once every refusal is final: the line moved, the window passed),
 * and a note saying what happened, with the reason for the ones that can be retried
 * if there are any. `word` turns a refusal's message into the text shown.
 */
export function afterUndo(results: UndoResult[], word: (message: string) => string): { retry: string[]; note: string } | null {
  const refused = results.filter((r): r is Extract<UndoResult, { undone: false }> => !r.undone);
  if (!refused.length) return null;
  const retry = refused.filter((r) => RETRY.has(r.code));
  const why = word((retry[0] ?? refused[0]!).message);
  const undone = results.length - refused.length;
  return { retry: retry.map((r) => r.slipId), note: undone ? `${undone} undone; ${refused.length} couldn't be: ${why}` : why };
}
