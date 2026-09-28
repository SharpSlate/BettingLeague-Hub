// Undoing bets, for the place-slip Edge Function. Undo is refused once one of a bet's
// lines has moved, checked against lines pulled after the undo was asked for
// (undo_slip_internal); one pull covers every bet in the request.
import { dbErrorCode, friendlyMessage } from "./http.ts";
import type { UndoRefresh } from "./jobs.ts";

export type UndoAnswer = { slipId: string; undone: true } | { slipId: string; undone: false; error: string; message: string };

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** What each way of not getting the lines means for the undo. */
const NO_LINES: Record<Exclude<UndoRefresh, "ok">, string> = {
  limit: "undo_refresh_limit",
  credit_floor: "undo_credit_floor",
  failed: "undo_lines_stale",
};

/**
 * Undoes the member's bets, each on its own, and says what happened to each. Every check
 * but the lines comes first, so a bet that can't be undone anyway costs no pull. Each
 * answers with the database's time if its lines are checked (the rules can allow undo
 * after a move), and has to be checked against lines whose request went out after that
 * time. `refresh` (refreshForUndo) makes sure the lines were fetched after the last of
 * those times, which covers every bet; it runs at most once, after all the checks.
 */
export async function undoSlips(rpc: Rpc, userId: string, slipIds: string[], refresh: (since: string) => Promise<UndoRefresh>): Promise<UndoAnswer[]> {
  const answers = new Map<string, UndoAnswer>();
  const refused = (slipId: string, code: string): UndoAnswer => ({ slipId, undone: false, error: code, message: friendlyMessage(code) });
  const checked: { slipId: string; since: string | null }[] = [];
  for (const slipId of slipIds) {
    const pre = await rpc("undo_slip_internal", { p_slip: slipId, p_user: userId, p_check_only: true });
    if (pre.error) answers.set(slipId, refused(slipId, dbErrorCode(pre.error.message)));
    else checked.push({ slipId, since: (pre.data as string | null) ?? null });
  }
  // The checks run one after another, so the last time given is the latest.
  const latest = checked.filter((c) => c.since !== null).at(-1)?.since ?? null;
  const lines = latest !== null ? await refresh(latest) : "ok";
  for (const c of checked) {
    if (c.since !== null && lines !== "ok") {
      answers.set(c.slipId, refused(c.slipId, NO_LINES[lines]));
      continue;
    }
    // The time goes back exactly as the database gave it.
    const { error } = await rpc("undo_slip_internal", { p_slip: c.slipId, p_user: userId, p_lines_since: c.since });
    answers.set(c.slipId, error ? refused(c.slipId, dbErrorCode(error.message)) : { slipId: c.slipId, undone: true });
  }
  return slipIds.map((id) => answers.get(id)!);
}
