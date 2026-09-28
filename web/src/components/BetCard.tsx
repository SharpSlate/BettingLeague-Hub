import { useState } from "react";
import { betTypeName, kickoff, legLabel, odds, units } from "../lib/format.ts";
import { useNow } from "../lib/hooks.ts";
import type { SlipView } from "../lib/types.ts";
import { StatusChip } from "./ui.tsx";

const RESULT_MARK: Record<string, string> = { won: "✓", lost: "✗", push: "P", void: "V", pending: "" };

export function BetCard({ slip, showEntry = true, undoMinutes = 0, onUndo, onVoid }: {
  slip: SlipView;
  showEntry?: boolean;
  undoMinutes?: number;
  onUndo?: (id: string) => void;
  onVoid?: (id: string) => void;
}) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const hidden = slip.legCount - slip.legs.length;
  const firstKick = Math.min(...slip.legs.map((l) => Date.parse(l.game.kickoffAt)));
  const undoLeft = slip.placedAt ? Date.parse(slip.placedAt) + undoMinutes * 60_000 - now : 0;
  const canUndo = onUndo && slip.status === "pending" && undoLeft > 0 && (!slip.legs.length || firstKick > now);
  const title = slip.type === "teaser" ? `${slip.legCount}-leg ${slip.teaserPoints}-pt teaser` : slip.type === "parlay" ? `${slip.legCount}-leg parlay` : betTypeName.straight;
  const pays = slip.status === "pending" ? slip.potentialPayoutCents : slip.payoutCents ?? 0;

  return (
    <article className="card bet">
      <div className="bet-top">
        <div className="row wrap">
          <b>{title}</b>
          {slip.type !== "straight" ? <span className="chip num">{odds(slip.quotedAmerican)}</span> : null}
          {showEntry ? <span className="chip">{slip.entryName}</span> : null}
        </div>
        <StatusChip status={slip.status} />
      </div>
      <div className="bet-legs">
        {slip.legs.map((l) => {
          const g = l.game;
          const score = g.status === "live" || g.status === "final" ? ` · ${g.away.abbr} ${g.awayScore}–${g.homeScore} ${g.home.abbr}${g.status === "live" ? " (live)" : ""}` : ` · ${kickoff(g.kickoffAt)}`;
          return (
            <div className="bet-leg" key={l.legNo}>
              <div>
                <div>
                  {legLabel(g, l)} {slip.type !== "teaser" ? <span className="muted num">{odds(l.price)}</span> : null}
                </div>
                <div className="gm">{g.away.shortName} at {g.home.shortName}{score}</div>
              </div>
              <span className={`num ${l.result === "won" ? "good" : l.result === "lost" ? "bad" : "muted"}`} aria-label={l.result}>{RESULT_MARK[l.result]}</span>
            </div>
          );
        })}
        {hidden > 0 ? <div className="hidden-legs">{hidden} more {hidden === 1 ? "leg is" : "legs are"} hidden until {hidden === 1 ? "its" : "their"} kickoff.</div> : null}
      </div>
      <div className="bet-foot">
        <span>
          Stake <b className="num">{units(slip.stakeCents)}</b> · {slip.status === "pending" ? "Pays" : "Paid"} <b className="num">{units(pays)}</b>
        </span>
        <span>{kickoff(slip.placedAt)}{slip.placedByName ? ` · ${slip.placedByName}` : ""}</span>
      </div>
      {canUndo || onVoid ? (
        <div className="row">
          {canUndo ? (
            <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); try { await onUndo!(slip.id); } finally { setBusy(false); } }}>
              Undo ({Math.floor(undoLeft / 60000)}:{String(Math.floor((undoLeft % 60000) / 1000)).padStart(2, "0")})
            </button>
          ) : null}
          {onVoid && slip.status !== "void" ? <button className="btn small danger" onClick={() => onVoid(slip.id)}>Void…</button> : null}
        </div>
      ) : null}
    </article>
  );
}
