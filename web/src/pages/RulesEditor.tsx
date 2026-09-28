// The commissioner's rules editor: every setting in the rule-set document, checked
// with the same code the server uses, published as a new version from a future week.
import { useMemo, useState } from "react";
import { validateRuleSet, type RuleSet, type SameGameRules } from "@rules";
import { errorText } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { parseNumber } from "../lib/format.ts";
import type { RuleVersion } from "../lib/types.ts";

// structuredClone keeps an unreadable number as NaN, so the rules check keeps flagging it
// (a JSON copy would turn it into null, which slips past comparisons).
const clone = <T,>(x: T): T => structuredClone(x);

function flatten(o: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (o && typeof o === "object" && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = JSON.stringify(o);
  return out;
}

/** A number field that keeps what's typed (e.g. a lone minus sign) while the value is incomplete. */
function NumInput({ value, onChange, label, className = "input num", style }: {
  value: number | null | undefined;
  onChange: (n: number) => void;
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  // (Copies of the rules go through JSON, which turns NaN into null, so null counts as unreadable too.)
  const unreadable = value === undefined || value === null || Number.isNaN(value);
  const shown = unreadable || !Number.isFinite(value) ? "" : String(value);
  const [text, setText] = useState(shown);
  // Follow the value when it changes from outside (e.g. a reset); keep the typed text otherwise.
  const current = parseNumber(text);
  const display = (Number.isNaN(current) ? unreadable : current === value) ? text : shown;
  return (
    <input className={className} style={style} inputMode="decimal" aria-label={label} value={display}
      onChange={(e) => { setText(e.target.value); onChange(parseNumber(e.target.value)); }} />
  );
}

/** The per-bet cap: blank means no cap; anything else unreadable is kept as NaN so the rules check flags it. */
function MaxPctInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  return (
    <input className="input num" inputMode="decimal" value={text}
      onChange={(e) => { setText(e.target.value); onChange(e.target.value.trim() === "" ? null : parseNumber(e.target.value)); }} />
  );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <NumInput value={value} onChange={onChange} />
    </label>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (b: boolean) => void }) {
  return (
    <label className="row small" style={{ gap: 8 }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function SameGame({ value, onChange }: { value: SameGameRules; onChange: (v: SameGameRules) => void }) {
  const set = (k: keyof SameGameRules) => (b: boolean) => onChange({ ...value, [k]: b });
  return (
    <div className="stack-sm">
      <Check label="Spread + total" value={value.spreadTotal} onChange={set("spreadTotal")} />
      <Check label="Moneyline + total" value={value.moneylineTotal} onChange={set("moneylineTotal")} />
      <Check label="Spread + either moneyline" value={value.spreadMoneyline} onChange={set("spreadMoneyline")} />
      <Check label="Both sides of one market" value={value.bothSides} onChange={set("bothSides")} />
    </div>
  );
}

export function RulesEditor({ current, openWeek, onPublished }: { current: RuleVersion; openWeek: number | null; onPublished: () => void }) {
  const api = useApi();
  const [doc, setDoc] = useState<RuleSet>(() => clone(current.document));
  const [pointsText, setPointsText] = useState(current.document.betTypes.teaser.points.join(", "));
  // A new version starts after the open week, and no earlier than the version it replaces.
  const [week, setWeek] = useState<number>(Math.max((openWeek ?? 0) + 1, current.effectiveWeek));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const edit = (fn: (d: RuleSet) => void) => setDoc((d) => { const n = clone(d); fn(n); return n; });
  const t = doc.betTypes.teaser;
  const problems = useMemo(() => {
    try { return validateRuleSet(doc); } catch { return [{ code: "malformed", message: "The rules are incomplete." }]; }
  }, [doc]);
  const changes = useMemo(() => {
    const a = flatten(current.document);
    const b = flatten(doc);
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
  }, [current.document, doc]);
  // The table runs from 2 legs even when new cards need more: a card cut down by
  // pushes or voids is priced on the legs left, down to 2.
  const legRange = Number.isInteger(t.minLegs) && Number.isInteger(t.maxLegs) && t.maxLegs >= t.minLegs && t.maxLegs <= 20
    ? Array.from({ length: t.maxLegs - 1 }, (_, i) => 2 + i) : [];

  const setPoints = (text: string) => {
    setPointsText(text);
    const pts = text.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    edit((d) => {
      d.betTypes.teaser.points = pts;
      for (const p of pts) d.betTypes.teaser.prices[String(p)] ??= {};
    });
  };

  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Editing a copy of version {current.version}. Publishing creates version {current.version + 1}, which takes effect from the week you choose.
        Bets already placed keep the rules they were placed under.
      </p>

      <details className="card" open>
        <summary>Bet types and legs</summary>
        <div className="body stack">
          <Check label="Straight bets" value={doc.betTypes.straight.enabled} onChange={(b) => edit((d) => { d.betTypes.straight.enabled = b; })} />
          <Check label="Parlays" value={doc.betTypes.parlay.enabled} onChange={(b) => edit((d) => { d.betTypes.parlay.enabled = b; })} />
          <div className="row"><Num label="Parlay min legs" value={doc.betTypes.parlay.minLegs} onChange={(n) => edit((d) => { d.betTypes.parlay.minLegs = n; })} /><Num label="Parlay max legs" value={doc.betTypes.parlay.maxLegs} onChange={(n) => edit((d) => { d.betTypes.parlay.maxLegs = n; })} /></div>
          <Check label="Teasers" value={t.enabled} onChange={(b) => edit((d) => { d.betTypes.teaser.enabled = b; })} />
          <div className="row"><Num label="Teaser min legs" value={t.minLegs} onChange={(n) => edit((d) => { d.betTypes.teaser.minLegs = n; })} /><Num label="Teaser max legs" value={t.maxLegs} onChange={(n) => edit((d) => { d.betTypes.teaser.maxLegs = n; })} /></div>
          <label className="field"><span>Teaser points (comma-separated)</span><input className="input" value={pointsText} onChange={(e) => setPoints(e.target.value)} /></label>
          <Check label="A total can only be teased alongside a spread (Splash's rule)" value={t.totalsNeedSpread} onChange={(b) => edit((d) => { d.betTypes.teaser.totalsNeedSpread = b; })} />
          <label className="field"><span>Teaser push rule</span>
            <select className="input" value={t.pushRule} onChange={(e) => edit((d) => { d.betTypes.teaser.pushRule = e.target.value as RuleSet["betTypes"]["teaser"]["pushRule"]; })}>
              <option value="reduce">Reduce: price the legs left (a lone leg gets the 2-leg price)</option>
              <option value="refund">Any push refunds the card</option>
              <option value="lose">A push loses the card</option>
            </select>
          </label>
        </div>
      </details>

      <details className="card">
        <summary>Teaser price table</summary>
        <div className="body scroll-x">
          <table className="table teaser-table">
            <thead><tr><th>Legs</th>{t.points.map((p) => <th key={p}>{p} pts</th>)}</tr></thead>
            <tbody>
              {legRange.map((n) => (
                <tr key={n}>
                  <td>{n}</td>
                  {t.points.map((p) => (
                    <td key={p}>
                      <NumInput style={{ minWidth: 84, textAlign: "center" }} label={`${n} legs at ${p} points`}
                        value={t.prices[String(p)]?.[String(n)]}
                        onChange={(v) => edit((d) => {
                          const row = (d.betTypes.teaser.prices[String(p)] ??= {});
                          // An unreadable price is kept as NaN so the rules check flags the cell.
                          row[String(n)] = v;
                        })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="card">
        <summary>Same-game combinations</summary>
        <div className="body grid-2">
          <div><h3 style={{ marginBottom: 8 }}>Parlays may combine</h3><SameGame value={doc.betTypes.parlay.sameGame} onChange={(v) => edit((d) => { d.betTypes.parlay.sameGame = v; })} /></div>
          <div><h3 style={{ marginBottom: 8 }}>Teasers may combine</h3><SameGame value={t.sameGame} onChange={(v) => edit((d) => { d.betTypes.teaser.sameGame = v; })} /></div>
        </div>
      </details>

      <details className="card">
        <summary>Prices, stakes, undo</summary>
        <div className="body stack">
          <label className="field"><span>Straight bets on spreads and totals pay</span>
            <select className="input" value={doc.pricing.straight} onChange={(e) => edit((d) => { d.pricing.straight = e.target.value as "book" | "flat"; })}>
              <option value="book">The sportsbook's posted price</option>
              <option value="flat">A flat price</option>
            </select>
          </label>
          {doc.pricing.straight === "flat" ? <Num label="Flat price" value={doc.pricing.flatPrice} onChange={(n) => edit((d) => { d.pricing.flatPrice = n; })} /> : null}
          <div className="row"><Num label="Min stake" value={doc.stake.minUnits} onChange={(n) => edit((d) => { d.stake.minUnits = n; })} /><Num label="Max stake" value={doc.stake.maxUnits} onChange={(n) => edit((d) => { d.stake.maxUnits = n; })} /></div>
          <div className="row">
            <Num label="Stake steps (units)" value={doc.stake.incrementUnits} onChange={(n) => edit((d) => { d.stake.incrementUnits = n; })} />
            <label className="field"><span>Max % of bank per bet (blank = none)</span>
              <MaxPctInput value={doc.stake.maxPctOfBank} onChange={(v) => edit((d) => { d.stake.maxPctOfBank = v; })} />
            </label>
          </div>
          <Num label="Undo window (minutes)" value={doc.undoMinutes} onChange={(n) => edit((d) => { d.undoMinutes = n; })} />
        </div>
      </details>

      <details className="card">
        <summary>Weekly minimum, visibility, lock, banks</summary>
        <div className="body stack">
          <div className="row">
            <Num label="Weekly minimum (% of bank)" value={doc.weeklyMinimum.pct} onChange={(n) => edit((d) => { d.weeklyMinimum.pct = n; })} />
            <label className="field"><span>If an entry falls short</span>
              <select className="input" value={doc.weeklyMinimum.penalty} onChange={(e) => edit((d) => { d.weeklyMinimum.penalty = e.target.value as RuleSet["weeklyMinimum"]["penalty"]; })}>
                <option value="deduct_shortfall">Deduct the shortfall</option>
                <option value="warn">Warn only</option>
                <option value="none">Show only</option>
              </select>
            </label>
          </div>
          <label className="field"><span>Other members see picks</span>
            <select className="input" value={doc.visibility} onChange={(e) => edit((d) => { d.visibility = e.target.value as RuleSet["visibility"]; })}>
              <option value="kickoff_per_leg">At each game's kickoff, leg by leg</option>
              <option value="week_first_kickoff">When the week's first game starts</option>
              <option value="on_placement">As soon as they're placed</option>
            </select>
          </label>
          <label className="field"><span>Bets lock</span>
            <select className="input" value={doc.lock} onChange={(e) => edit((d) => { d.lock = e.target.value as RuleSet["lock"]; })}>
              <option value="game_kickoff">At each game's kickoff</option>
              <option value="week_first_kickoff">For the whole week at its first kickoff</option>
            </select>
          </label>
          <div className="row"><Num label="New entry bank" value={doc.bank.startUnits} onChange={(n) => edit((d) => { d.bank.startUnits = n; })} /><Num label="Sign-up bonus" value={doc.bank.bonusUnits} onChange={(n) => edit((d) => { d.bank.bonusUnits = n; })} /></div>
        </div>
      </details>

      <div className="card pad stack">
        <div className="row">
          <Num label="Takes effect from week" value={week} onChange={setWeek} />
          <label className="field"><span>Note (shown on the Rules page)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" /></label>
        </div>
        {changes.length ? <div className="small muted">Changes: {changes.join(", ")}</div> : <div className="small muted">No changes yet.</div>}
        {problems.map((p, i) => <div className="problem" key={i}>{p.message}</div>)}
        {openWeek !== null && week <= openWeek ? <div className="problem">Rules can only change from a week that hasn't opened yet (after week {openWeek}).</div> : null}
        {week < current.effectiveWeek ? <div className="problem">Version {current.version} is scheduled from week {current.effectiveWeek}, so this one can start no earlier than that.</div> : null}
        {!Number.isInteger(week) ? <div className="problem">Enter the week this takes effect from as a whole number.</div> : null}
        {msg ? <div className={`banner ${msg.ok ? "" : "bad"}`}>{msg.text}</div> : null}
        <button
          className="btn primary"
          disabled={busy || !changes.length || problems.length > 0 || (openWeek !== null && week <= openWeek) || week < current.effectiveWeek || !Number.isInteger(week) || note.trim().length < 3}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const v = await api.adminPublishRules(doc, week, note.trim());
              setMsg({ ok: true, text: `Published version ${v}, effective from week ${week}.` });
              onPublished();
            } catch (e) {
              setMsg({ ok: false, text: errorText(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          Publish version {current.version + 1}
        </button>
        {note.trim().length < 3 ? <div className="tiny muted">Add a note to publish.</div> : null}
      </div>
    </div>
  );
}
