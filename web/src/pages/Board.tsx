import { useEffect, useMemo, useState } from "react";
import { GameCard } from "../components/GameCard.tsx";
import { SlipBody } from "../components/Slip.tsx";
import { Empty, ErrorNote, Loading, PageHead } from "../components/ui.tsx";
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
  const [toast, setToast] = useState<{ ids: string[]; until: number } | null>(null);
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

  const onPlaced = (ids: string[]) => {
    entries.reload();
    slip.setOpen(false);
    setUndoError(null);
    setToast({ ids, until: Date.now() + (weekRules?.undoMinutes ?? 5) * 60_000 });
  };
  const undoAll = async () => {
    if (!toast) return;
    try {
      for (const id of toast.ids) await api.undoSlip(id);
      setToast(null);
      entries.reload();
    } catch (e) {
      setUndoError(e instanceof Error ? e.message : String(e));
    }
  };

  const body = <SlipBody rules={weekRules} entries={entries.data ?? []} onPlaced={onPlaced} />;
  const lg = league.data;

  return (
    <>
      <PageHead
        title={lg?.openWeek ? `${lg.openWeek.label} board` : "Board"}
        sub={
          lg
            ? `Lines from ${lg.books.map((b) => (b === "draftkings" ? "DraftKings" : b === "fanduel" ? "FanDuel" : b)).join(", then ")}, updated ${ago(lg.lastPullAt, now)}. Refreshed every ${lg.pullEveryMinutes} minutes from 8am to 1am ET, and whenever someone bets. All times Eastern.`
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
                  {gs.map((g) => <GameCard key={g.id} game={g} now={now} />)}
                </div>
              </section>
            ))}
          </div>
          <aside className="slip-panel card pad" aria-label="Bet slip">
            <div className="row spread" style={{ marginBottom: 10 }}>
              <h2>Bet slip</h2>
              {slip.picks.length ? <button className="btn link small" onClick={() => slip.clear()}>Clear</button> : null}
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
          <div className="sheet" role="dialog" aria-label="Bet slip">
            <div className="sheet-grip" />
            <div className="row spread" style={{ marginBottom: 10 }}>
              <h2>Bet slip</h2>
              <div className="row">
                {slip.picks.length ? <button className="btn link small" onClick={() => slip.clear()}>Clear</button> : null}
                <button className="btn small" onClick={() => slip.setOpen(false)}>Close</button>
              </div>
            </div>
            {body}
          </div>
        </>
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          <span>{toast.ids.length > 1 ? `${toast.ids.length} bets placed` : "Bet placed"}{undoError ? ` · ${undoError}` : ""}</span>
          <button className="btn small" onClick={undoAll}>Undo</button>
          <button className="btn small" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      ) : null}
    </>
  );
}
