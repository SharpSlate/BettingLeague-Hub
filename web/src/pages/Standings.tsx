import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorNote, Loading, PageHead, Segmented } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { record, signedUnits, units } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import type { StandingRow, WeekInfo } from "../lib/types.ts";

type Range = "season" | "week" | "last" | "7d" | "custom";

function rangeDates(range: Range, weeks: WeekInfo[] | undefined, custom: { from: string; to: string }) {
  const open = weeks?.find((w) => w.status === "open");
  if (range === "week" && open) return { from: open.startsAt };
  if (range === "last" && open) {
    const prev = weeks!.filter((w) => w.week < open.week).at(-1);
    return prev ? { from: prev.startsAt, to: prev.endsAt } : undefined;
  }
  if (range === "7d") return { from: new Date(Date.now() - 7 * 86_400_000).toISOString() };
  if (range === "custom" && custom.from) {
    return { from: new Date(`${custom.from}T00:00:00`).toISOString(), to: custom.to ? new Date(`${custom.to}T23:59:59`).toISOString() : undefined };
  }
  return undefined;
}

function rank(rows: StandingRow[], season: boolean): StandingRow[] {
  return [...rows].sort((a, b) =>
    season
      ? b.bankCents - a.bankCents || b.seasonNetCents - a.seasonNetCents || b.seasonWinningsCents - a.seasonWinningsCents
      : b.netCents - a.netCents || b.winningsCents - a.winningsCents || b.bankCents - a.bankCents,
  );
}

function Minimum({ r }: { r: StandingRow }) {
  if (!r.requiredCents) return <span className="muted">—</span>;
  const met = r.wageredCents >= r.requiredCents;
  return met ? (
    <span className="minimum good" title="Met this week's 30% minimum">✓ Met</span>
  ) : (
    <span className={`minimum ${r.isMine ? "warn" : "muted"}`} title={r.isMine ? "Wagered so far this week" : "Counts only bets on games that have started"}>
      <span className="num">{units(r.wageredCents)} / {units(r.requiredCents)}</span>
    </span>
  );
}

export function Standings() {
  const api = useApi();
  const nav = useNavigate();
  const [range, setRange] = useState<Range>("season");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const weeks = useLoad(() => api.weeks(), []);
  const dates = rangeDates(range, weeks.data, custom);
  const season = range === "season" || !dates;
  const data = useLoad(() => api.standings(season ? undefined : dates), [range, custom.from, custom.to, weeks.data?.length], 60_000);
  const rows = useMemo(() => rank(data.data ?? [], season), [data.data, season]);
  const open = weeks.data?.find((w) => w.status === "open");

  return (
    <>
      <PageHead
        title="Standings"
        sub={`${rows.length} entries${open ? ` · ${open.label} is open` : ""} · ranked by ${season ? "bank" : "net for the period"}`}
      />
      <div className="stack">
        <div className="scroll-x">
          <Segmented<Range>
            label="Period"
            value={range}
            onChange={setRange}
            options={[
              { value: "season", label: "Season" },
              { value: "week", label: "This week" },
              { value: "last", label: "Last week" },
              { value: "7d", label: "Last 7 days" },
              { value: "custom", label: "Custom" },
            ]}
          />
        </div>
        {range === "custom" ? (
          <div className="row wrap">
            <label className="field"><span>From</span><input className="input" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="field"><span>To</span><input className="input" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          </div>
        ) : null}
        <ErrorNote error={data.error} />
        {data.loading && !data.data ? <Loading /> : (
          <div className="card">
            <div className="stand-list">
              {rows.map((r, i) => (
                <Link key={r.entryId} to={`/entry/${r.entryId}`} className={`stand-row${r.isMine ? " mine" : ""}`}>
                  <span className={`rank${i < 3 ? " top" : ""}`}>{i + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="stand-name">{r.name}</div>
                    <div className="stand-meta">
                      {r.isMine ? <span className="chip mine">Yours</span> : null}
                      <span className={`num ${(season ? r.seasonNetCents : r.netCents) >= 0 ? "good" : "bad"}`}>{signedUnits(season ? r.seasonNetCents : r.netCents)}</span>
                      <span className="num">{record(r.wins, r.losses, r.pushes)}</span>
                      <Minimum r={r} />
                    </div>
                  </div>
                  <div className="stand-bank num">{units(r.bankCents)}</div>
                </Link>
              ))}
            </div>
            <div className="scroll-x">
              <table className="table stand-table">
                <thead>
                  <tr>
                    <th>#</th><th>Entry</th><th className="num">Bank</th><th className="num">Net</th><th className="num">Record</th>
                    <th className="num">Risk</th><th className="num">Return</th><th className="num">At risk</th><th>This week's 30%</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.entryId} className={r.isMine ? "mine" : ""} onClick={() => nav(`/entry/${r.entryId}`)}>
                      <td className={`rank${i < 3 ? " top" : ""}`}>{i + 1}</td>
                      <td><b>{r.name}</b> {r.isMine ? <span className="chip mine">Yours</span> : null}</td>
                      <td className="num"><b>{units(r.bankCents)}</b></td>
                      <td className={`num ${(season ? r.seasonNetCents : r.netCents) >= 0 ? "good" : "bad"}`}>{signedUnits(season ? r.seasonNetCents : r.netCents)}</td>
                      <td className="num">{record(r.wins, r.losses, r.pushes)}</td>
                      <td className="num">{units(r.riskCents)}</td>
                      <td className="num">{units(r.returnCents)}</td>
                      <td className="num">{units(r.atRiskCents)}</td>
                      <td><Minimum r={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="tiny muted">
          Bank = available units plus stakes still riding. Ties go to net, then total winnings. For other entries, at-risk and the
          30% column count only bets on games that have started, so hidden picks stay hidden.
        </p>
      </div>
    </>
  );
}
