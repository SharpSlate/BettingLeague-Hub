import { describe, expect, it } from "vitest";
import { afterUndo } from "./undo.ts";

const word = (m: string) => `<${m}>`;
const ok = (slipId: string) => ({ slipId, undone: true as const });
const no = (slipId: string, code: string) => ({ slipId, undone: false as const, code, message: code });

describe("the toast after Undo", () => {
  it("goes away when every bet was undone", () => {
    expect(afterUndo([ok("a"), ok("b")], word)).toBeNull();
  });
  it("drops the Undo button when no refusal can change on a retry", () => {
    expect(afterUndo([ok("a"), no("b", "undo_line_moved")], word)).toMatchObject({ retry: [], note: "1 undone · 1 can't be undone: <undo_line_moved>" });
    expect(afterUndo([no("a", "undo_refresh_limit")], word)).toMatchObject({ retry: [], note: "1 can't be undone: <undo_refresh_limit>" });
  });
  it("keeps it for the bets the lines couldn't be pulled for, and still says which can't be undone", () => {
    const first = afterUndo([no("a", "game_started"), no("b", "undo_lines_stale")], word)!;
    expect(first).toEqual({
      retry: ["b"],
      note: "1 can't be undone: <game_started> · 1 to try again: <undo_lines_stale>",
      final: "1 can't be undone: <game_started>",
    });
    // The retry undoes b; a is still riding, so the toast says so rather than closing.
    expect(afterUndo([ok("b")], word, first.final)).toEqual({ retry: [], note: "1 undone · 1 can't be undone: <game_started>", final: first.final });
  });
});
