// Your leagues: switch between them, start one, or join one with an invite code.
// Also the page an invite link opens (#/join/CODE).
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { initials } from "../components/Shell.tsx";
import { errorText, Loading } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { useLoad } from "../lib/hooks.ts";
import type { LeagueSummary } from "../lib/types.ts";

export const SITE_NAME = "Betting League";

/** The link that joins a league, for its commissioners to share. */
export function inviteLink(code: string): string {
  return `${window.location.origin}${window.location.pathname}#/join/${code}`;
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="signin">
      <div className="card">
        <div className="row">
          <span className="brand-mark" aria-hidden="true">{initials(SITE_NAME)}</span>
          <div>
            <h1 style={{ fontSize: 18 }}>{SITE_NAME}</h1>
            <div className="small muted">NFL betting leagues · play units</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Asks a new member for the name everyone in their leagues will see, until they've set one. */
function NameCheck() {
  const api = useApi();
  const me = useLoad(() => api.me(), []);
  const [name, setName] = useState("");
  const [done, setDone] = useState(false);
  if (!me.data || me.data.displayName !== "Member" || done) return null;
  return (
    <form
      className="stack-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        await api.setDisplayName(name.trim());
        setDone(true);
      }}
    >
      <label className="field">
        <span>Your name (everyone in your leagues sees it)</span>
        <input className="input" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button className="btn" disabled={!name.trim()}>Save name</button>
    </form>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Pulls the code out of a pasted invite link, or takes a bare code. */
function codeFrom(text: string): string {
  const m = text.match(/join\/([A-Za-z0-9]+)/);
  return (m ? m[1]! : text).trim().toUpperCase();
}

export function Leagues({ leagues, current, onChoose }: { leagues: LeagueSummary[]; current: string | null; onChoose: (id: string) => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const create = useAction();
  const go = (id: string) => {
    onChoose(id);
    navigate("/");
  };
  return (
    <Page>
      <NameCheck />
      {leagues.length ? (
        <div className="stack-sm">
          <b>Your leagues</b>
          <div className="league-list">
            {leagues.map((l) => (
              <button key={l.id} type="button" className={`league-row ${l.id === current ? "on" : ""}`} onClick={() => go(l.id)}>
                <span className="brand-mark" aria-hidden="true">{initials(l.name)}</span>
                <span className="grow">
                  <b>{l.name}</b>
                  <div className="tiny muted">{l.role === "commissioner" ? "Commissioner" : "Member"} · {l.openWeek ? `Week ${l.openWeek} is open` : "Betting closed"}</div>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>You're not in a league yet. Start one and invite your friends, or join one with the invite link you were sent.</p>
      )}
      <form className="stack-sm" onSubmit={create.run(async () => go(await api.createLeague(name.trim())))}>
        <b>Start a league</b>
        <label className="field">
          <span>League name</span>
          <input className="input" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sunday Sharps" />
        </label>
        <p className="tiny muted" style={{ margin: 0 }}>You'll be its commissioner. It starts on the standard rules, which you can change for any week that hasn't opened. Then you get a link to invite people.</p>
        <button className="btn primary" disabled={create.busy || !name.trim()}>{create.busy ? "Starting…" : "Start league"}</button>
        {create.error ? <div className="banner bad" role="alert">{create.error}</div> : null}
      </form>
      <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); navigate(`/join/${codeFrom(code)}`); }}>
        <b>Join a league</b>
        <label className="field">
          <span>Invite link or code</span>
          <input className="input" required value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <button className="btn" disabled={!code.trim()}>Continue</button>
      </form>
      <button type="button" className="btn link" onClick={() => api.signOut()}>Sign out</button>
    </Page>
  );
}

export function Join({ onJoined }: { onJoined: (id: string) => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const { code = "" } = useParams();
  const info = useLoad(() => api.inviteInfo(code), [code]);
  const [entry, setEntry] = useState("");
  const join = useAction();
  const done = (id: string) => {
    onJoined(id);
    navigate("/");
  };
  if (info.loading && !info.data) return <Page><Loading /></Page>;
  const l = info.data;
  if (!l) {
    return (
      <Page>
        <p style={{ margin: 0 }}>That invite link doesn't work. It may have been replaced by a new one: ask the commissioner for the current link.</p>
        <Link className="btn" to="/leagues">Your leagues</Link>
      </Page>
    );
  }
  if (l.alreadyMember) {
    return (
      <Page>
        <p style={{ margin: 0 }}>You're already in <b>{l.name}</b>.</p>
        <button className="btn primary" onClick={() => done(l.leagueId)}>Go to {l.name}</button>
      </Page>
    );
  }
  return (
    <Page>
      <NameCheck />
      <form className="stack-sm" onSubmit={join.run(async () => done(await api.joinLeague(code, l.selfEntry ? entry.trim() : null)))}>
        <p style={{ margin: 0 }}>Join <b>{l.name}</b>? It has {l.members} member{l.members === 1 ? "" : "s"}.</p>
        {l.selfEntry ? (
          <label className="field">
            <span>Your entry's name (shown in the standings)</span>
            <input className="input" required maxLength={40} value={entry} onChange={(e) => setEntry(e.target.value)} />
          </label>
        ) : (
          <p className="tiny muted" style={{ margin: 0 }}>The commissioner sets up the entries in this league, so you'll get yours from them.</p>
        )}
        <button className="btn primary" disabled={join.busy || (l.selfEntry && !entry.trim())}>{join.busy ? "Joining…" : "Join league"}</button>
        {join.error ? <div className="banner bad" role="alert">{join.error}</div> : null}
      </form>
      <Link className="btn link" to="/leagues">Not now</Link>
    </Page>
  );
}
