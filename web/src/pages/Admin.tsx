import { useState, type FormEvent, type ReactNode } from "react";
import type { Market } from "@rules";
import { Empty, errorText, Loading, PageHead } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { ago, kickoff, matchup, odds, toCents } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import { useMe } from "../lib/me.ts";
import type { GameView } from "../lib/types.ts";
import { RulesEditor } from "./RulesEditor.tsx";

/** A form section whose submit shows a result or an error. */
function Action({ title, children, onSubmit, submit = "Save", note }: {
  title: string;
  children: ReactNode;
  onSubmit: () => Promise<string | void>;
  submit?: string;
  note?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const handle = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: (await onSubmit()) || "Done." });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card pad form" onSubmit={handle}>
      <h3>{title}</h3>
      {note ? <p className="small muted" style={{ margin: 0 }}>{note}</p> : null}
      {children}
      <div><button className="btn primary" disabled={busy}>{busy ? "Working…" : submit}</button></div>
      {msg ? <div className={`banner ${msg.ok ? "" : "bad"}`}>{msg.text}</div> : null}
    </form>
  );
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="field"><span>{label}</span>{children}</label>;

function cents(text: string, allowNegative = false): number {
  const neg = allowNegative && text.trim().startsWith("-");
  const c = toCents(text.replace(/^[-+]/, ""));
  if (c === null) throw new Error("Enter an amount in units, e.g. 1500 or 1500.25.");
  return neg ? -c : c;
}

type Section = "status" | "members" | "entries" | "games" | "rules";

export function Admin() {
  const api = useApi();
  const me = useMe();
  const [section, setSection] = useState<Section>("status");
  const league = useLoad(() => api.league(), []);
  if (!me.isAdmin) return <Empty>This page is for the commissioner and admins.</Empty>;
  return (
    <>
      <PageHead title="Admin" sub="Everything here is recorded in the admin log that every member can read." />
      <div className="stack">
        <div className="scroll-x">
          <div className="seg" role="tablist">
            {(["status", "members", "entries", "games", "rules"] as Section[]).map((s) => (
              <button key={s} type="button" className={section === s ? "on" : ""} onClick={() => setSection(s)}>
                {{ status: "Week & feeds", members: "Members", entries: "Entries & banks", games: "Games & lines", rules: "Rules" }[s]}
              </button>
            ))}
          </div>
        </div>
        {section === "status" ? <Status reload={league.reload} /> : section === "members" ? <Members /> : section === "entries" ? <Entries /> : section === "games" ? <Games week={league.data?.openWeek?.week ?? null} /> : <RulesSection openWeek={league.data?.openWeek?.week ?? null} />}
      </div>
    </>
  );
}

function Status({ reload }: { reload: () => void }) {
  const api = useApi();
  const league = useLoad(() => api.league(), []);
  const [reason, setReason] = useState("");
  const lg = league.data;
  return (
    <div className="grid-2">
      <div className="card pad stack-sm">
        <h3>Right now</h3>
        {lg ? (
          <dl className="kv">
            <dt>Open week</dt><dd>{lg.openWeek?.label ?? "None"}{lg.openWeek ? ` (rules version ${lg.openWeek.ruleSetVersion})` : ""}</dd>
            <dt>Last line pull</dt><dd>{ago(lg.lastPullAt)}</dd>
            <dt>Odds API credits</dt><dd className="num">{lg.creditsRemaining?.toLocaleString() ?? "unknown"}</dd>
            <dt>Line window</dt><dd>{lg.pullWindowStart}–{lg.pullWindowEnd} ET, every {lg.pullEveryMinutes} min</dd>
          </dl>
        ) : <Loading />}
      </div>
      <Action title="Run a job now" submit="Pull lines" onSubmit={async () => { const r = await api.adminRunJob("pull-lines"); league.reload(); reload(); return r; }}
        note="Lines refresh on their own; use this if the feed looks behind. Each pull costs 3 credits.">
        <span />
      </Action>
      <Action title="Scores and grading" submit="Pull scores and grade" onSubmit={async () => api.adminRunJob("pull-scores")}
        note="Runs every 10 minutes on its own. It only calls the Odds API while a game is in progress.">
        <span />
      </Action>
      <Action title="Open the next week" submit="Open next week"
        note="The next week opens by itself once every game of this week is final and graded. Use this only around a postponed game. Any shortfall on the 30% minimum is deducted when the week closes."
        onSubmit={async () => {
          if (!window.confirm("Close this week and open the next one now?")) return "Cancelled.";
          const w = await api.adminOpenNextWeek(reason);
          league.reload();
          reload();
          return `Week ${w} is open.`;
        }}>
        <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. BUF–MIA postponed to Tuesday" /></Field>
      </Action>
    </div>
  );
}

function Members() {
  const api = useApi();
  const users = useLoad(() => api.adminUsers(), []);
  const entrants = useLoad(() => api.entrants(), []);
  const [f, setF] = useState({ email: "", name: "", entry: "" });
  const [link, setLink] = useState({ user: "", entry: "", add: "add" });
  const entries = entrants.data ?? [];
  return (
    <div className="grid-2">
      <Action title="Add a member" submit="Add member" note="Sign-ups are closed, so this is how people get in. They then sign in with their email or Google."
        onSubmit={async () => { await api.adminAddMember(f.email, f.name, f.entry || null); users.reload(); setF({ email: "", name: "", entry: "" }); return "Added. They can sign in now."; }}>
        <Field label="Email"><input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Display name"><input className="input" maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Manages entry (optional)">
          <select className="input" value={f.entry} onChange={(e) => setF({ ...f, entry: e.target.value })}>
            <option value="">None yet</option>
            {entries.map((e) => <option key={e.entryId} value={e.entryId}>{e.name}</option>)}
          </select>
        </Field>
      </Action>
      <Action title="Entry managers" submit="Save" note="An entry can have several managers, and one login can manage several entries."
        onSubmit={async () => { await api.adminSetManager(link.entry, link.user, link.add === "add"); users.reload(); entrants.reload(); }}>
        <Field label="Member">
          <select className="input" required value={link.user} onChange={(e) => setLink({ ...link, user: e.target.value })}>
            <option value="">Choose…</option>
            {(users.data ?? []).map((u) => <option key={u.userId} value={u.userId}>{u.displayName} ({u.email})</option>)}
          </select>
        </Field>
        <Field label="Entry">
          <select className="input" required value={link.entry} onChange={(e) => setLink({ ...link, entry: e.target.value })}>
            <option value="">Choose…</option>
            {entries.map((e) => <option key={e.entryId} value={e.entryId}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Action">
          <select className="input" value={link.add} onChange={(e) => setLink({ ...link, add: e.target.value })}>
            <option value="add">Make them a manager</option>
            <option value="remove">Remove them as a manager</option>
          </select>
        </Field>
      </Action>
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="card-head"><h3>Members</h3><span className="small muted">Emails are visible to admins only.</span></div>
        {users.loading && !users.data ? <Loading /> : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Name</th><th>Email</th><th>Entries</th><th>Admin</th></tr></thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <tr key={u.userId}><td>{u.displayName}</td><td>{u.email}</td><td>{u.entryNames.join(", ") || "—"}</td><td>{u.isAdmin ? "Yes" : ""}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Entries() {
  const api = useApi();
  const entrants = useLoad(() => api.entrants(), []);
  const entries = entrants.data ?? [];
  const [add, setAdd] = useState({ name: "", bank: "" });
  const [imp, setImp] = useState({ entry: "", bank: "", net: "", w: "0", l: "0", p: "0", risk: "", ret: "", win: "", note: "Splash standings" });
  const [adj, setAdj] = useState({ entry: "", amount: "", reason: "" });
  const [voidForm, setVoidForm] = useState({ id: "", reason: "" });
  const pick = (value: string, onChange: (v: string) => void) => (
    <select className="input" required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose an entry…</option>
      {entries.map((e) => <option key={e.entryId} value={e.entryId}>{e.name}</option>)}
    </select>
  );
  return (
    <div className="grid-2">
      <Action title="Add an entry" submit="Add entry" note="For a new entry. For an entry coming over from Splash, add it with no bank and then import it."
        onSubmit={async () => { await api.adminAddEntry(add.name.trim(), add.bank ? cents(add.bank) : 0); entrants.reload(); setAdd({ name: "", bank: "" }); }}>
        <Field label="Entry name"><input className="input" required maxLength={40} value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></Field>
        <Field label="Starting bank (units, optional)"><input className="input num" inputMode="decimal" value={add.bank} onChange={(e) => setAdd({ ...add, bank: e.target.value })} placeholder="15000" /></Field>
      </Action>
      <Action title="Import from Splash" submit="Import" note="Copies an entry's Splash standings row: its bank, plus its record and totals for the season columns. Only for an entry with no bets here yet."
        onSubmit={async () => {
          await api.adminImportSplash({
            entryId: imp.entry, bankCents: cents(imp.bank), netCents: cents(imp.net || "0", true), wins: Number(imp.w), losses: Number(imp.l), pushes: Number(imp.p),
            riskCents: imp.risk ? cents(imp.risk) : 0, returnCents: imp.ret ? cents(imp.ret) : 0, winningsCents: imp.win ? cents(imp.win) : 0, note: imp.note,
          });
          return "Imported.";
        }}>
        <Field label="Entry">{pick(imp.entry, (v) => setImp({ ...imp, entry: v }))}</Field>
        <div className="row"><Field label="Bank"><input className="input num" required value={imp.bank} onChange={(e) => setImp({ ...imp, bank: e.target.value })} /></Field><Field label="Net (±)"><input className="input num" value={imp.net} onChange={(e) => setImp({ ...imp, net: e.target.value })} /></Field></div>
        <div className="row"><Field label="W"><input className="input num" value={imp.w} onChange={(e) => setImp({ ...imp, w: e.target.value })} /></Field><Field label="L"><input className="input num" value={imp.l} onChange={(e) => setImp({ ...imp, l: e.target.value })} /></Field><Field label="P"><input className="input num" value={imp.p} onChange={(e) => setImp({ ...imp, p: e.target.value })} /></Field></div>
        <div className="row"><Field label="Risk"><input className="input num" value={imp.risk} onChange={(e) => setImp({ ...imp, risk: e.target.value })} /></Field><Field label="Return"><input className="input num" value={imp.ret} onChange={(e) => setImp({ ...imp, ret: e.target.value })} /></Field><Field label="Total winnings"><input className="input num" value={imp.win} onChange={(e) => setImp({ ...imp, win: e.target.value })} /></Field></div>
        <Field label="Note"><input className="input" value={imp.note} onChange={(e) => setImp({ ...imp, note: e.target.value })} /></Field>
      </Action>
      <Action title="Adjust a bank" submit="Adjust" note="Adds or removes units, with a reason that goes in the admin log."
        onSubmit={async () => { await api.adminAdjustBank(adj.entry, cents(adj.amount, true), adj.reason); setAdj({ entry: "", amount: "", reason: "" }); }}>
        <Field label="Entry">{pick(adj.entry, (v) => setAdj({ ...adj, entry: v }))}</Field>
        <Field label="Amount (units; negative to take away)"><input className="input num" required value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} placeholder="-250" /></Field>
        <Field label="Reason"><input className="input" required minLength={3} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
      </Action>
      <Action title="Void a bet by ID" submit="Void bet" note="Refunds the stake and takes back any winnings. Revealed bets also have a Void button in League Picks. Hidden bets can only be voided by ID, for example when a member asks."
        onSubmit={async () => { await api.adminVoidSlip(voidForm.id.trim(), voidForm.reason); setVoidForm({ id: "", reason: "" }); }}>
        <Field label="Bet ID"><input className="input" required value={voidForm.id} onChange={(e) => setVoidForm({ ...voidForm, id: e.target.value })} /></Field>
        <Field label="Reason"><input className="input" required minLength={3} value={voidForm.reason} onChange={(e) => setVoidForm({ ...voidForm, reason: e.target.value })} /></Field>
      </Action>
    </div>
  );
}

function Games({ week }: { week: number | null }) {
  const api = useApi();
  const games = useLoad(() => (week ? api.games(week) : Promise.resolve([] as GameView[])), [week]);
  const [id, setId] = useState("");
  const g = games.data?.find((x) => x.id === id);
  const [line, setLine] = useState({ market: "spread" as Market, pa: "", ra: "-110", pb: "", rb: "-110", offered: true, reason: "" });
  const [status, setStatus] = useState({ status: "postponed", kickoff: "", reason: "" });
  const [score, setScore] = useState({ home: "", away: "", reason: "" });
  if (!week) return <Empty>No week is open.</Empty>;
  const cur = (m: Market) => g?.lines.filter((l) => l.market === m) ?? [];
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <div className="stack">
      <select className="input" value={id} onChange={(e) => setId(e.target.value)} aria-label="Game">
        <option value="">Choose a game…</option>
        {(games.data ?? []).map((x) => <option key={x.id} value={x.id}>{matchup(x)} · {kickoff(x.kickoffAt)} · {x.status}</option>)}
      </select>
      {!g ? <Empty>Choose a game to set its lines, status or score.</Empty> : (
        <div className="grid-2">
          <div className="card pad stack-sm">
            <h3>{matchup(g)}</h3>
            <div className="small muted">{kickoff(g.kickoffAt)} · {g.status}{g.homeScore !== null ? ` · ${g.away.abbr} ${g.awayScore}–${g.homeScore} ${g.home.abbr}` : ""}</div>
            {(["spread", "total", "moneyline"] as Market[]).map((m) => (
              <div key={m} className="row spread small">
                <span className="muted">{m}</span>
                <span className="num">{cur(m).map((l) => `${l.side} ${l.point ?? ""} ${odds(l.price)}`).join(" · ") || "off the board"}{cur(m)[0]?.source === "override" ? " (override)" : ""}</span>
              </div>
            ))}
          </div>
          <Action title="Set a line" submit="Set line" note={`Side A is ${line.market === "total" ? "the over" : `${g.home.shortName} (home)`}; side B is ${line.market === "total" ? "the under" : `${g.away.shortName} (away)`}. Replaces the feed's line until you clear it.`}
            onSubmit={async () => {
              await api.adminSetLine(g.id, line.market, { point: num(line.pa), price: Number(line.ra) }, { point: num(line.pb), price: Number(line.rb) }, line.offered, line.reason);
              games.reload();
            }}>
            <Field label="Market">
              <select className="input" value={line.market} onChange={(e) => setLine({ ...line, market: e.target.value as Market })}>
                <option value="spread">Spread</option><option value="total">Total</option><option value="moneyline">Moneyline</option>
              </select>
            </Field>
            {line.market !== "moneyline" ? (
              <div className="row"><Field label="A number"><input className="input num" value={line.pa} onChange={(e) => setLine({ ...line, pa: e.target.value })} /></Field><Field label="B number"><input className="input num" value={line.pb} onChange={(e) => setLine({ ...line, pb: e.target.value })} /></Field></div>
            ) : null}
            <div className="row"><Field label="A price"><input className="input num" value={line.ra} onChange={(e) => setLine({ ...line, ra: e.target.value })} /></Field><Field label="B price"><input className="input num" value={line.rb} onChange={(e) => setLine({ ...line, rb: e.target.value })} /></Field></div>
            <label className="row small"><input type="checkbox" checked={!line.offered} onChange={(e) => setLine({ ...line, offered: !e.target.checked })} /> Take this market off the board instead</label>
            <Field label="Reason"><input className="input" required minLength={3} value={line.reason} onChange={(e) => setLine({ ...line, reason: e.target.value })} /></Field>
            <button type="button" className="btn small" onClick={async () => { await api.adminClearLine(g.id, line.market, line.reason || "Back to the feed's line"); games.reload(); }}>Clear override (use the feed)</button>
          </Action>
          <Action title="Game status" submit="Save status" note="Postponing blocks the automatic week change. Voiding grades every leg on the game as void."
            onSubmit={async () => { await api.adminSetGameStatus(g.id, status.status as "scheduled" | "postponed" | "void", status.kickoff ? new Date(status.kickoff).toISOString() : null, status.reason); games.reload(); }}>
            <Field label="Status">
              <select className="input" value={status.status} onChange={(e) => setStatus({ ...status, status: e.target.value })}>
                <option value="postponed">Postponed</option><option value="scheduled">Scheduled (restore)</option><option value="void">Void (canceled)</option>
              </select>
            </Field>
            <Field label="New kickoff (optional, your local time)"><input className="input" type="datetime-local" value={status.kickoff} onChange={(e) => setStatus({ ...status, kickoff: e.target.value })} /></Field>
            <Field label="Reason"><input className="input" required minLength={3} value={status.reason} onChange={(e) => setStatus({ ...status, reason: e.target.value })} /></Field>
          </Action>
          <Action title="Enter a final score" submit="Save final score" note="Only if the score feed fails. Not allowed once bets on the game are graded."
            onSubmit={async () => { await api.adminSetFinalScore(g.id, Number(score.home), Number(score.away), score.reason); games.reload(); return "Saved. Bets on this game will be graded on the next run."; }}>
            <div className="row"><Field label={`${g.away.shortName} (away)`}><input className="input num" required value={score.away} onChange={(e) => setScore({ ...score, away: e.target.value })} /></Field><Field label={`${g.home.shortName} (home)`}><input className="input num" required value={score.home} onChange={(e) => setScore({ ...score, home: e.target.value })} /></Field></div>
            <Field label="Reason"><input className="input" required minLength={3} value={score.reason} onChange={(e) => setScore({ ...score, reason: e.target.value })} /></Field>
          </Action>
        </div>
      )}
    </div>
  );
}

function RulesSection({ openWeek }: { openWeek: number | null }) {
  const api = useApi();
  const versions = useLoad(() => api.ruleVersions(), []);
  if (versions.loading && !versions.data) return <Loading />;
  const latest = versions.data?.[0];
  if (!latest) return <Empty>No rules published yet.</Empty>;
  return <RulesEditor key={latest.version} current={latest} openWeek={openWeek} onPublished={versions.reload} />;
}
