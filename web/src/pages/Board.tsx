import { useEffect, useMemo, useState } from "react";
import { GameCard } from "../components/GameCard.tsx";
import { SlipBody, type PlacedResult } from "../components/Slip.tsx";
import { Empty, ErrorNote, errorText, Loading, PageHead } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { ago, day } from "../lib/format.ts";
import { useLoad, useNow } from "../lib/hooks.ts";
import { useSlip } from "../lib/slip.tsx";
import type { GameView } from "../lib/types.ts";
import { afterUndo } from "../lib/undo.ts";

/** The toast after placing: the bets that can still be undone, and what an undo did. */
type Toast = PlacedResult & { until: number; note?: string };

export function Board() {
  const api = useApi();
  const slip = useSlip();
  const now = useNow(30_000);
  const league = useLoad(() => api.league(), [], 60_000);
  const week = league.data?.openWeek?.week;
  const games = useLoad(() => (week ? api.games(week) : Promise.resolve([] as GameView[])), [week], 60_000);
  const entries = useLoad(() => api.myEntries(), []);
  const rules = useLoad(() => api.ruleVersions(), []);
  const [toast, setToast] = useState<Toast | null>(null);
  const [undoing, setUndoing] = useState(false);

  const weekRules = rules.data?.find((r) => r.version === league.data?.openWeek?.ruleSetVersion)?.document;
  const byDay = useMemo(() => {
    const groups = new Map<string, GameView[]>();
    for (const g of games.data ?? []) {
      const d = day(g.kickoffAt);
      groups.set(d, [...(groups.get(d) ?? []), g]);
    }
    return [...groups];
  }, [games.data]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), Math.max(0, toast.until - Date.now()));
    return () => clearTimeout(id);
  }, [toast]);

  const onPlaced = (r: PlacedResult) => {
    entries.reload();
    // If a bet didn't go in, keep the slip open: the reason is shown on it.
    if (!r.failed) slip.setOpen(false);
    setToast({ ...r, until: Date.now() + (weekRules?.undoMinutes ?? 5) * 60_000 });
  };
  // One request undoes them all, against one fresh pull of the lines, each bet on its
  // own: one that can't be undone (its line moved, say) doesn't stop the rest. Only the
  // bets worth another try (the lines couldn't be pulled just then) keep the Undo button.
  const undoAll = async () => {
    const shown = toast;
    if (!shown || undoing) return;
    setUndoing(true);
    const next = await api.undoSlips(shown.ids).then(
      (results): Toast | null => {
        const left = afterUndo(results, errorText);
        return left && { ...shown, ids: left.retry, note: left.note };
      },
      (e): Toast => ({ ...shown, note: errorText(e) }),
    );
    setUndoing(false);
    entries.reload();
    // A bet placed in the meantime has its own toast; leave that one be.
    setToast((cur) => (cur === shown ? next : cur));
  };

  const body = <SlipBody rules={weekRules} entries={entries.data ?? []} onPlaced={onPlaced} />;
  const lg = league.data;

  return (
    <>
      <PageHead
        title={lg?.openWeek ? `${lg.openWeek.label} board` : "Board"}
        sub={
          lg
            ? `Lines from ${lg.books.map((b) => (b === "draftkings" ? "DraftKings" : b === "fanduel" ? "FanDuel" : b)).join(", then ")}, updated ${ago(lg.lastPullAt, now)}. Refreshed every ${lg.pullEveryMinutes} minutes, every ${lg.pullNearKickoffMinutes} in the ${lg.nearKickoffHours} hours before a kickoff, and before a bet when they're more than 2 minutes old (up to a daily limit). All times Eastern.`
            : undefined
        }
      />
      <ErrorNote error={league.error ?? games.error} />
      {league.loading && !lg ? <Loading /> : !lg?.openWeek ? (
        <Empty>Betting is closed until the current week's last game is final. The next week opens right after.</Empty>
      ) : (
        <div className="board-layout">
          <div>
            {games.loading && !games.data ? <Loading /> : byDay.length === 0 ? <Empty>No games on the board yet.</Empty> : byDay.map(([d, gs]) => (
              <section key={d}>
                <h2 className="day-label">{d}</h2>
                <div className="games">
                  {gs.map((g) => <GameCard key={g.id} game={g} now={now} rules={weekRules} />)}
                </div>
              </section>
            ))}
          </div>
          <aside className="slip-panel card pad" aria-label="Bet slip">
            <div className="row spread" style={{ marginBottom: 10 }}>
              <h2>Bet slip</h2>
              {slip.picks.length ? <button className="btn link small" disabled={slip.status.busy} onClick={() => slip.clear()}>Clear</button> : null}
            </div>
            {body}
          </aside>
        </div>
      )}

      {slip.picks.length ? (
        <button className="slip-fab" onClick={() => slip.setOpen(true)}>
          <span className="count">{slip.picks.length}</span> Bet slip
        </button>
      ) : null}
      {slip.open ? (
        <>
          <div className="sheet-backdrop" onClick={() => slip.setOpen(false)} />
          <div className={`sheet${toast ? " with-toast" : ""}`} role="dialog" aria-label="Bet slip">
            <div className="sheet-grip" />
            <div className="row spread" style={{ marginBottom: 10 }}>
              <h2>Bet slip</h2>
              <div className="row">
                {slip.picks.length ? <button className="btn link small" disabled={slip.status.busy} onClick={() => slip.clear()}>Clear</button> : null}
                <button className="btn small" onClick={() => slip.setOpen(false)}>Close</button>
              </div>
            </div>
            {body}
          </div>
        </>
      ) : null}

      {toast ? (
        <div className={`toast${slip.open ? " over-sheet" : ""}`} role="status">
          <span>
            {toast.note ?? (toast.failed ? `${toast.ids.length} of ${toast.total} bets placed` : toast.ids.length > 1 ? `${toast.ids.length} bets placed` : "Bet placed")}
          </span>
          {toast.ids.length ? <button className="btn small" disabled={undoing} onClick={undoAll}>{undoing ? "Undoing…" : "Undo"}</button> : null}
          <button className="btn small" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      ) : null}
    </>
  );
}
