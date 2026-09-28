import { useMemo, useState } from "react";
import { BetCard } from "../components/BetCard.tsx";
import { Empty, ErrorNote, errorText, Loading, PageHead, Segmented } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { ago, betTypeName, clock, day, legLabel, odds, units } from "../lib/format.ts";
import { useLoad, useNow } from "../lib/hooks.ts";
import { useMe } from "../lib/me.ts";
import type { GameView, SlipView } from "../lib/types.ts";
import { StatusChip } from "../components/ui.tsx";

type View = "game" | "entry" | "latest";

export function Picks() {
  const api = useApi();
  const me = useMe();
  const now = useNow(30_000);
  const [view, setView] = useState<View>("game");
  const [entryId, setEntryId] = useState<string>("");
  const weeks = useLoad(() => api.weeks(), []);
  const open = weeks.data?.find((w) => w.status === "open");
  const [weekNo, setWeekNo] = useState<number | null>(null);
  const week = weekNo ?? open?.week ?? null;
  const slips = useLoad(() => (week ? api.slips({ week }) : Promise.resolve([] as SlipView[])), [week], 60_000);
  const games = useLoad(() => (week ? api.games(week) : Promise.resolve([] as GameView[])), [week], 60_000);
  const hidden = useLoad(() => api.hiddenActivity(), [], 60_000);
  const [error, setError] = useState<string | null>(null);
  const isOpenWeek = week === open?.week;

  const voidSlip = me.isAdmin
    ? async (id: string) => {
        const reason = window.prompt("Why is this bet being voided? This goes in the admin log that every member can read.");
        if (!reason) return;
        try {
          await api.adminVoidSlip(id, reason);
          slips.reload();
        } catch (e) {
          setError(errorText(e));
        }
      }
    : undefined;

  const entries = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of slips.data ?? []) m.set(s.entryId, s.entryName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [slips.data]);

  const hiddenByEntry = useMemo(() => {
    const m = new Map<string, { name: string; n: number; last: string }>();
    for (const h of hidden.data ?? []) {
      const x = m.get(h.entryId);
      m.set(h.entryId, { name: h.name, n: (x?.n ?? 0) + 1, last: x && x.last > h.placedAt ? x.last : h.placedAt });
    }
    return [...m.values()].sort((a, b) => b.last.localeCompare(a.last));
  }, [hidden.data]);

  const feed = useMemo(() => {
    const items: { at: string; text: React.ReactNode; key: string }[] = [];
    for (const s of slips.data ?? []) {
      const first = s.legs[0];
      const what = first ? `${legLabel(first.game, first)}${s.legCount > 1 ? ` + ${s.legCount - 1} more` : ""}` : "a pick";
      items.push({ key: `p${s.id}`, at: s.placedAt, text: <><b>{s.entryName}</b> staked {units(s.stakeCents)} on {what} <span className="muted">({betTypeName[s.type].toLowerCase()}{s.type !== "straight" ? ` ${odds(s.quotedAmerican)}` : ""})</span></> });
      if (s.settledAt && s.status !== "pending") {
        items.push({ key: `s${s.id}`, at: s.settledAt, text: <><b>{s.entryName}</b>'s {betTypeName[s.type].toLowerCase()} on {what}: <StatusChip status={s.status} />{s.status === "won" ? <> paid <b className="num">{units(s.payoutCents)}</b></> : null}</> });
      }
    }
    if (isOpenWeek) for (const h of hidden.data ?? []) items.push({ key: `h${h.entryId}${h.placedAt}`, at: h.placedAt, text: <><b>{h.name}</b> made a pick <span className="muted">(hidden until kickoff)</span></> });
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }, [slips.data, hidden.data, isOpenWeek]);

  return (
    <>
      <PageHead
        title="League Picks"
        sub="Everyone's bets, as each game kicks off. Before kickoff you only see that a pick was made."
        right={
          weeks.data ? (
            <select className="input" style={{ width: "auto" }} value={week ?? ""} onChange={(e) => setWeekNo(Number(e.target.value))} aria-label="Week">
              {weeks.data.filter((w) => w.status !== "upcoming").map((w) => <option key={w.week} value={w.week}>{w.label}{w.status === "open" ? " (open)" : ""}</option>)}
            </select>
          ) : null
        }
      />
      <div className="stack">
        <Segmented<View> label="View" value={view} onChange={setView} options={[{ value: "game", label: "By game" }, { value: "entry", label: "By entry" }, { value: "latest", label: "Latest" }]} />
        <ErrorNote error={error ?? slips.error} />
        {isOpenWeek && hiddenByEntry.length ? (
          <div className="card pad small">
            <b>Hidden until kickoff:</b>{" "}
            {hiddenByEntry.map((h, i) => <span key={h.name}>{i ? ", " : ""}{h.name} ({h.n})</span>)}
          </div>
        ) : null}
        {slips.loading && !slips.data ? <Loading /> : view === "game" ? (
          <ByGame games={games.data ?? []} slips={slips.data ?? []} now={now} />
        ) : view === "entry" ? (
          <div className="stack">
            <select className="input" value={entryId} onChange={(e) => setEntryId(e.target.value)} aria-label="Entry">
              <option value="">Choose an entry…</option>
              {entries.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            {entryId ? (
              <div className="bets">
                {(slips.data ?? []).filter((s) => s.entryId === entryId).map((s) => <BetCard key={s.id} slip={s} showEntry={false} onVoid={voidSlip} />)}
              </div>
            ) : <Empty>Pick an entry to see its revealed bets for the week.</Empty>}
          </div>
        ) : (
          <div className="card feed">
            {feed.length ? feed.map((f) => (
              <div className="feed-item" key={f.key}><span>{f.text}</span><span className="when">{ago(f.at, now)}</span></div>
            )) : <Empty>Nothing yet this week.</Empty>}
          </div>
        )}
      </div>
    </>
  );
}

function ByGame({ games, slips, now }: { games: GameView[]; slips: SlipView[]; now: number }) {
  if (!games.length) return <Empty>No games this week.</Empty>;
  return (
    <div className="games">
      {games.map((g) => {
        const started = Date.parse(g.kickoffAt) <= now || g.status !== "scheduled";
        const rows = slips.flatMap((s) => s.legs.filter((l) => l.gameId === g.id).map((l) => ({ s, l })));
        return (
          <article className="card" key={g.id}>
            <div className="card-head">
              <div>
                <b>{g.away.shortName} at {g.home.shortName}</b>
                <div className="tiny muted">{day(g.kickoffAt)} · {clock(g.kickoffAt)}</div>
              </div>
              {g.status === "live" || g.status === "final" ? (
                <span className={`chip ${g.status === "live" ? "live" : ""} num`}>{g.away.abbr} {g.awayScore}–{g.homeScore} {g.home.abbr}{g.status === "final" ? " F" : ""}</span>
              ) : null}
            </div>
            {!started ? (
              <div className="empty small">Picks on this game appear at kickoff.</div>
            ) : rows.length === 0 ? (
              <div className="empty small">No bets on this game.</div>
            ) : (
              <div className="feed">
                {rows.map(({ s, l }) => (
                  <div className="feed-item" key={`${s.id}-${l.legNo}`}>
                    <div className="grow">
                      <div><b>{s.entryName}</b> · {legLabel(g, l)} {s.type !== "teaser" ? <span className="muted num">{odds(l.price)}</span> : null}</div>
                      <div className="tiny muted">
                        {s.type === "straight" ? "Straight" : `Leg of a ${s.legCount}-leg ${s.type}${s.type === "teaser" ? ` (${s.teaserPoints} pts)` : ""}`} · stake {units(s.stakeCents)}
                      </div>
                    </div>
                    <StatusChip status={s.type === "straight" ? s.status : l.result === "pending" ? s.status : l.result} />
                  </div>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
