import { useEffect, useMemo, useState } from "react";
import { GameCard } from "../components/GameCard.tsx";
import { SlipBody, type PlacedResult } from "../components/Slip.tsx";
import { Empty, ErrorNote, errorText, Loading, PageHead } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { ago, day } from "../lib/format.ts";
import { useLoad, useNow } from "../lib/hooks.ts";
import { useSlip } from "../lib/slip.tsx";
import type { GameView } from "../lib/types.ts";

export function Board() {
  const api = useApi();
  const slip = useSlip();
  const now = useNow(30_000);
  const league = useLoad(() => api.league(), [], 60_000);
  const week = league.data?.openWeek?.week;
  const games = useLoad(() => (week ? api.games(week) : Promise.resolve([] as GameView[])), [week], 60_000);
  const entries = useLoad(() => api.myEntries(), []);
  const rules = useLoad(() => api.ruleVersions(), []);
  const [toast, setToast] = useState<(PlacedResult & { until: number }) | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

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
    setUndoError(null);
    setToast({ ...r, until: Date.now() + (weekRules?.undoMinutes ?? 5) * 60_000 });
  };
  // Each bet is undone on its own: one that can't be (its line moved, say) doesn't stop
  // the rest, and only the ones still standing stay on the toast for another try.
  const undoAll = async () => {
    if (!toast) return;
    const kept: string[] = [];
    let reason: string | null = null;
    for (const id of toast.ids) {
      try {
        await api.undoSlip(id);
      } catch (e) {
        kept.push(id);
        reason ??= errorText(e);
      }
    }
    entries.reload();
    if (!kept.length) {
      setToast(null);
      return;
    }
    setToast({ ...toast, ids: kept });
    setUndoError(kept.length < toast.ids.length ? `${toast.ids.length - kept.length} undone; ${kept.length} couldn't be: ${reason}` : reason);
  };

  const body = <SlipBody rules={weekRules} entries={entries.data ?? []} onPlaced={onPlaced} />;
  const lg = league.data;

  return (
    <>
      <PageHead
        title={lg?.openWeek ? `${lg.openWeek.label} board` : "Board"}
        sub={
          lg
            ? `Lines from ${lg.books.map((b) => (b === "draftkings" ? "DraftKings" : b === "fanduel" ? "FanDuel" : b)).join(", then ")}, updated ${ago(lg.lastPullAt, now)}. Refreshed every ${lg.pullEveryMinutes} minutes, every ${lg.pullNearKickoffMinutes} in the ${lg.nearKickoffHours} hours before a kickoff, and before a bet when they're more than 2 minutes old. All times Eastern.`
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
            {toast.failed ? `${toast.ids.length} of ${toast.total} bets placed` : toast.ids.length > 1 ? `${toast.ids.length} bets placed` : "Bet placed"}
            {undoError ? ` · ${undoError}` : ""}
          </span>
          <button className="btn small" onClick={undoAll}>Undo</button>
          <button className="btn small" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      ) : null}
    </>
  );
}
