import { useMemo, useState } from "react";
import { quoteSlip, teasedPoint, validateSlip, type BetType, type Leg, type Problem, type RuleSet, type SlipInput } from "@rules";
import { useApi } from "../lib/api.ts";
import { clock, odds, point, toCents, units } from "../lib/format.ts";
import { pushRuleText } from "../lib/rules-text.ts";
import { matchupText, pickText, useSlip, type Pick } from "../lib/slip.tsx";
import type { MyEntry } from "../lib/types.ts";
import { Segmented } from "./ui.tsx";

const COMBO = "combo";

function legOf(p: Pick): Leg {
  return { gameId: p.gameId, market: p.market, side: p.side, point: p.point, price: p.price };
}

function teasedLabel(p: Pick, pts: number): string {
  if (p.market === "moneyline" || p.point === null) return `${pickText(p)} (can't be teased)`;
  return `${pickText(p, teasedPoint(legOf(p), pts))} (from ${p.market === "total" ? p.point : point(p.point)})`;
}

interface Moved { key: string; label: string; from: string; to: string; point: number | null; price: number }

export function SlipBody({ rules, entries, onPlaced }: {
  rules: RuleSet | undefined;
  entries: MyEntry[];
  onPlaced: (slipIds: string[]) => void;
}) {
  const api = useApi();
  const slip = useSlip();
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverProblems, setServerProblems] = useState<Problem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<Moved[]>([]);

  const entry = entries.find((e) => e.entryId === slip.entryId) ?? entries[0];
  const mode = slip.mode;
  const picks = slip.picks;

  // Build the slip(s) to check and quote with the shared rules code.
  const plan = useMemo(() => {
    if (!rules || !entry) return null;
    const ctx = { availableCents: entry.availableCents, bankCents: entry.bankCents };
    if (mode === "straight") {
      let used = 0;
      const items = picks.map((p) => {
        const stakeCents = toCents(slip.stakes[p.key] ?? "") ?? 0;
        const input: SlipInput = { type: "straight", legs: [legOf(p)], stakeCents };
        const problems = validateSlip(input, rules, { ...ctx, availableCents: ctx.availableCents - used });
        used += stakeCents;
        const quote = problems.length ? null : quoteSlip(input, rules);
        return { key: p.key, input, problems, quote };
      });
      return { items, stake: used, payout: items.reduce((a, i) => a + (i.quote?.payoutCents ?? 0), 0) };
    }
    const stakeCents = toCents(slip.stakes[COMBO] ?? "") ?? 0;
    const input: SlipInput = { type: mode, legs: picks.map(legOf), stakeCents, teaserPoints: mode === "teaser" ? slip.teaserPoints : null };
    const problems = validateSlip(input, rules, ctx);
    let quote = null;
    try {
      quote = problems.some((p) => p.code !== "stake" && p.code !== "stake_available") ? null : quoteSlip(input, rules);
    } catch {
      quote = null;
    }
    return { items: [{ key: COMBO, input, problems, quote }], stake: stakeCents, payout: problems.length ? 0 : quote?.payoutCents ?? 0 };
  }, [rules, entry, mode, picks, slip.stakes, slip.teaserPoints]);

  if (!picks.length) {
    return <div className="empty">Tap a price on the board to add it to your slip.</div>;
  }
  if (!rules || !entry || !plan) {
    return entries.length === 0 && rules ? <div className="empty">You don't manage an entry yet. Ask the commissioner to add you to one.</div> : <div className="empty">Loading the rules…</div>;
  }

  const combo = plan.items[0]!;
  const allProblems = plan.items.flatMap((i) => i.problems);
  const blocking = allProblems.filter((p) => attempted || !["stake"].includes(p.code));
  const legProblem = (i: number) =>
    mode === "straight" ? plan.items[i]?.problems.filter((p) => p.leg === 0) ?? [] : combo.problems.filter((p) => p.leg === i);
  const slipProblems = mode === "straight" ? [] : combo.problems.filter((p) => p.leg === undefined && (attempted || p.code !== "stake"));
  const canSubmit = !busy && allProblems.length === 0 && plan.stake > 0;

  async function submit() {
    setAttempted(true);
    setError(null);
    setServerProblems([]);
    setMoved([]);
    if (!plan || allProblems.length || !entry) return;
    setBusy(true);
    const placed: string[] = [];
    try {
      for (const item of plan.items) {
        const r = await api.placeSlip({ entryId: entry.entryId, type: item.input.type, teaserPoints: item.input.teaserPoints ?? null, stakeCents: item.input.stakeCents, legs: item.input.legs });
        if (r.ok) {
          placed.push(r.slipId);
          if (mode === "straight") slip.remove(item.key);
          continue;
        }
        if (r.kind === "moved") {
          const keys = mode === "straight" ? [item.key] : picks.map((p) => p.key);
          setMoved(r.lines.map((m) => {
            const p = picks.find((x) => x.key === keys[mode === "straight" ? 0 : m.leg])!;
            return {
              key: p.key,
              label: pickText(p),
              from: `${p.market === "moneyline" ? "" : `${p.market === "total" ? p.point : point(p.point ?? 0)} `}${odds(p.price)}`,
              to: `${p.market === "moneyline" ? "" : `${p.market === "total" ? m.point : point(m.point ?? 0)} `}${odds(m.price)}`,
              point: m.point,
              price: m.price,
            };
          }));
        } else if (r.kind === "invalid") {
          setServerProblems(r.problems);
        } else {
          setError(r.message);
        }
        break;
      }
    } finally {
      setBusy(false);
    }
    if (placed.length) {
      if (mode !== "straight" || placed.length === plan.items.length) slip.clear();
      setAttempted(false);
      onPlaced(placed);
    }
  }

  const acceptMoved = () => {
    for (const m of moved) slip.updateLine(m.key, m.point, m.price);
    setMoved([]);
  };

  const minPct = entry.requiredCents ? Math.min(100, Math.round((entry.wageredCents / entry.requiredCents) * 100)) : 100;
  const setMode = (m: BetType) => { slip.setMode(m); setAttempted(false); setServerProblems([]); setMoved([]); };

  return (
    <div className="stack">
      {entries.length > 1 ? (
        <label className="field">
          <span>Betting for</span>
          <select className="input" value={entry.entryId} onChange={(e) => slip.setEntry(e.target.value)}>
            {entries.map((e) => <option key={e.entryId} value={e.entryId}>{e.name} · {units(e.availableCents)} available</option>)}
          </select>
        </label>
      ) : (
        <div className="small muted">Betting for <b>{entry.name}</b> · {units(entry.availableCents)} available</div>
      )}

      {entry.requiredCents ? (
        <div className="stack-sm">
          <div className="row spread small">
            <span className="muted">This week's 30% minimum</span>
            <span className="num">{units(entry.wageredCents)} / {units(entry.requiredCents)}</span>
          </div>
          <div className={`bar${minPct >= 100 ? " done" : ""}`}><i style={{ width: `${minPct}%` }} /></div>
        </div>
      ) : null}

      <Segmented<BetType>
        full
        label="Bet type"
        value={mode}
        onChange={setMode}
        options={[
          { value: "straight", label: "Straight" },
          { value: "parlay", label: "Parlay" },
          { value: "teaser", label: "Teaser" },
        ]}
      />
      {mode === "teaser" ? (
        <Segmented<number>
          full
          label="Teaser points"
          value={slip.teaserPoints}
          onChange={(v) => slip.setTeaserPoints(v)}
          options={rules.betTypes.teaser.points.map((p) => ({ value: p, label: `${p} pts` }))}
        />
      ) : null}

      <div>
        {picks.map((p, i) => (
          <div className="slip-leg" key={p.key}>
            <div>
              <div><b>{mode === "teaser" ? teasedLabel(p, slip.teaserPoints) : pickText(p)}</b>{" "}
                {mode !== "teaser" ? <span className="muted num">{odds(p.price)}</span> : null}
              </div>
              <div className="tiny muted">{matchupText(p)} · {clock(p.kickoffAt)}</div>
            </div>
            <button className="x" aria-label={`Remove ${pickText(p)}`} onClick={() => slip.remove(p.key)}>×</button>
            {mode === "straight" ? (
              <label className="field" style={{ gridColumn: "1 / -1", marginTop: 6 }}>
                <span className="sr-only">Stake for {pickText(p)}</span>
                <input className="input num" inputMode="decimal" placeholder="Stake (units)" value={slip.stakes[p.key] ?? ""} onChange={(e) => slip.setStake(p.key, e.target.value)} />
              </label>
            ) : null}
            {legProblem(i).filter((x) => x.code !== "stake" || attempted).map((x) => <div className="bad" key={x.code}>{x.message}</div>)}
          </div>
        ))}
      </div>

      {mode !== "straight" ? (
        <label className="field">
          <span>Stake (units)</span>
          <input className="input num" inputMode="decimal" placeholder="0" value={slip.stakes[COMBO] ?? ""} onChange={(e) => slip.setStake(COMBO, e.target.value)} />
        </label>
      ) : null}

      <div className="payout">
        <span className="small muted">
          {mode === "straight" ? `${picks.length} bet${picks.length > 1 ? "s" : ""} · stake ${units(plan.stake)}` : `${mode === "teaser" ? "Teaser" : "Parlay"} ${combo.quote ? odds(combo.quote.american) : ""} · stake ${units(plan.stake)}`}
        </span>
        <span>
          <span className="small muted">Returns </span>
          <b className="num">{units(plan.payout)}</b>
        </span>
      </div>

      {slipProblems.map((p) => <div className="problem" key={p.code}>{p.message}</div>)}
      {mode === "straight" && attempted ? blocking.filter((p) => p.leg === undefined && p.code !== "stake").map((p) => <div className="problem" key={p.code}>{p.message}</div>) : null}
      {serverProblems.map((p, i) => <div className="problem" key={i}>{p.message}</div>)}
      {error ? <div className="problem" role="alert">{error}</div> : null}
      {moved.length ? (
        <div className="banner warn" role="alert">
          <div className="stack-sm">
            <b>A line moved.</b>
            {moved.map((m) => <span key={m.key}>{m.label}: {m.from} → <b>{m.to}</b></span>)}
            <div><button className="btn small primary" onClick={acceptMoved}>Accept the new line{moved.length > 1 ? "s" : ""}</button></div>
          </div>
        </div>
      ) : null}

      <button className="btn primary block" disabled={!canSubmit} onClick={submit}>
        {busy ? "Placing…" : mode === "straight" && picks.length > 1 ? `Place ${picks.length} bets` : "Place bet"}
      </button>
      <p className="rules-note">
        {mode === "teaser" ? pushRuleText(rules) : mode === "parlay" ? "A pushed leg drops out and the rest are multiplied." : "A push returns your stake."}{" "}
        Each leg locks at its game's kickoff. You can undo within {rules.undoMinutes} minutes.
      </p>
    </div>
  );
}
