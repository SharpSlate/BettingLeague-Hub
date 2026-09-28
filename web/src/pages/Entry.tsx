import { useParams, Link } from "react-router-dom";
import { BetCard } from "../components/BetCard.tsx";
import { Empty, Loading, PageHead } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { record, signedUnits, units } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";

export function Entry() {
  const { id = "" } = useParams();
  const api = useApi();
  const standings = useLoad(() => api.standings(), []);
  const slips = useLoad(() => api.slips({ entryId: id, limit: 300 }), [id], 60_000);
  const row = standings.data?.find((r) => r.entryId === id);
  const entrants = useLoad(() => api.entrants(), []);
  const managers = entrants.data?.find((e) => e.entryId === id)?.managers ?? [];

  if (standings.loading && !standings.data) return <Loading />;
  if (!row) return <Empty>That entry isn't in the league.</Empty>;
  return (
    <>
      <PageHead title={row.name} sub={managers.length ? `Managed by ${managers.join(", ")}` : undefined} right={row.isMine ? <Link className="btn small" to="/bets">My Bets</Link> : null} />
      <div className="stack">
        <div className="card pad">
          <div className="kpis">
            <div className="kpi"><div className="k">Bank</div><div className="v num">{units(row.bankCents)}</div></div>
            <div className="kpi"><div className="k">Net</div><div className={`v num ${row.seasonNetCents >= 0 ? "good" : "bad"}`}>{signedUnits(row.seasonNetCents)}</div></div>
            <div className="kpi"><div className="k">Record</div><div className="v num">{record(row.wins, row.losses, row.pushes)}</div></div>
          </div>
        </div>
        <h2>{row.isMine ? "All bets" : "Revealed bets"}</h2>
        {!row.isMine ? <p className="small muted" style={{ margin: 0 }}>Bets show up here as their games kick off.</p> : null}
        {slips.loading && !slips.data ? <Loading /> : (slips.data ?? []).length === 0 ? <Empty>No bets to show yet.</Empty> : (
          <div className="bets">{slips.data!.map((s) => <BetCard key={s.id} slip={s} showEntry={false} />)}</div>
        )}
      </div>
    </>
  );
}
