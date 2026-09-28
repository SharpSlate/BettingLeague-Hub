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
    expect(afterUndo([ok("a"), no("b", "undo_line_moved")], word)).toEqual({ retry: [], note: "1 undone; 1 couldn't be: <undo_line_moved>" });
    expect(afterUndo([no("a", "undo_window_passed")], word)).toEqual({ retry: [], note: "<undo_window_passed>" });
    expect(afterUndo([no("a", "undo_refresh_limit")], word)).toEqual({ retry: [], note: "<undo_refresh_limit>" });
  });
  it("keeps it for the bets the lines couldn't be pulled for, and says why", () => {
    expect(afterUndo([no("a", "not_pending"), no("b", "undo_lines_stale"), no("c", "undo_lines_stale")], word))
      .toEqual({ retry: ["b", "c"], note: "<undo_lines_stale>" });
    expect(afterUndo([ok("a"), no("b", "error")], word)).toEqual({ retry: ["b"], note: "1 undone; 1 couldn't be: <error>" });
  });
});
