import { useState } from "react";
import { BetCard } from "../components/BetCard.tsx";
import { Empty, ErrorNote, errorText, Loading, PageHead, Segmented } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { kickoff, units } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import type { GameView, MyEntry } from "../lib/types.ts";

function EntryCard({ e, lastKickoff, penalty, minimumPct }: { e: MyEntry; lastKickoff: string | null; penalty: boolean; minimumPct: number }) {
  const req = e.requiredCents ?? 0;
  const short = Math.max(0, req - e.wageredCents);
  const pct = req ? Math.min(100, Math.round((e.wageredCents / req) * 100)) : 100;
  return (
    <article className="card entry-card">
      <div className="row spread">
        <h2>{e.name}</h2>
        <span className="num" title="Bank"><b>{units(e.bankCents)}</b></span>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="k">Available</div><div className="v num">{units(e.availableCents)}</div></div>
        <div className="kpi"><div className="k">At risk</div><div className="v num">{units(e.pendingCents)}</div></div>
        <div className="kpi"><div className="k">This week</div><div className="v num">{units(e.wageredCents)}</div></div>
      </div>
      {req ? (
        <div className="stack-sm">
          <div className="row spread small">
            <span className="muted">{minimumPct}% minimum for week {e.week}</span>
            <span className="num">{units(e.wageredCents)} / {units(req)}</span>
          </div>
          <div className={`bar${short === 0 ? " done" : ""}`}><i style={{ width: `${pct}%` }} /></div>
          {short > 0 ? (
            <div className="banner warn small">
              Wager {units(short)} more{lastKickoff ? ` before the week's last kickoff (${kickoff(lastKickoff)})` : ""}
              {penalty ? ", or the shortfall comes off your bank when the week closes." : "."}
            </div>
          ) : <div className="small good">Minimum met for this week.</div>}
        </div>
      ) : null}
    </article>
  );
}

export function MyBets() {
  const api = useApi();
  const [tab, setTab] = useState<"pending" | "settled">("pending");
  const [entryId, setEntryId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const league = useLoad(() => api.league(), []);
  const entries = useLoad(() => api.myEntries(), [], 60_000);
  const rules = useLoad(() => api.ruleVersions(), []);
  const week = league.data?.openWeek?.week;
  const games = useLoad(() => (week ? api.games(week) : Promise.resolve([] as GameView[])), [week]);
  const slips = useLoad(() => api.slips({ mine: true, settled: tab === "settled", entryId: entryId || undefined, limit: 300 }), [tab, entryId], 60_000);
  const weekRules = rules.data?.find((r) => r.version === league.data?.openWeek?.ruleSetVersion)?.document;
  const lastKickoff = (games.data ?? []).filter((g) => g.status === "scheduled").map((g) => g.kickoffAt).sort().at(-1) ?? null;

  const undo = async (id: string) => {
    try {
      await api.undoSlip(id);
      slips.reload();
      entries.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const mine = entries.data ?? [];
  return (
    <>
      <PageHead title="My Bets" sub={mine.length > 1 ? `Your ${mine.length} entries, all under one login.` : undefined} />
      <div className="stack">
        {entries.loading && !entries.data ? <Loading /> : mine.length === 0 ? (
          <Empty>You don't manage an entry yet. Ask the commissioner to add you to one.</Empty>
        ) : (
          <div className="entry-cards">
            {mine.map((e) => <EntryCard key={e.entryId} e={e} lastKickoff={lastKickoff} penalty={weekRules?.weeklyMinimum.penalty === "deduct_shortfall"} minimumPct={weekRules?.weeklyMinimum.pct ?? 30} />)}
          </div>
        )}
        <div className="row wrap spread">
          <Segmented label="Bets" value={tab} onChange={setTab} options={[{ value: "pending", label: "Pending" }, { value: "settled", label: "Settled" }]} />
          {mine.length > 1 ? (
            <select className="input" style={{ width: "auto" }} value={entryId} onChange={(e) => setEntryId(e.target.value)} aria-label="Entry">
              <option value="">All entries</option>
              {mine.map((e) => <option key={e.entryId} value={e.entryId}>{e.name}</option>)}
            </select>
          ) : null}
        </div>
        <ErrorNote error={error ?? slips.error} />
        {slips.loading && !slips.data ? <Loading /> : (slips.data ?? []).length === 0 ? (
          <Empty>{tab === "pending" ? "No open bets. Head to the Board to make one." : "No settled bets yet."}</Empty>
        ) : (
          <div className="bets">
            {slips.data!.map((s) => (
              <BetCard key={s.id} slip={s} showEntry={mine.length > 1} undoMinutes={weekRules?.undoMinutes ?? 0} onUndo={tab === "pending" ? undo : undefined} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
