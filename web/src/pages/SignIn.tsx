import { useState } from "react";
import { initials } from "../components/Shell.tsx";
import { useApi } from "../lib/api.ts";
import { SITE_NAME } from "./Leagues.tsx";

export function SignIn() {
  const api = useApi();
  // The deploy sets VITE_GOOGLE once the site has a Google sign-in client, and
  // VITE_EMAIL_CODES once it has its own email sender. Until then the email is
  // Supabase's standard one, which has a sign-in link rather than a code.
  const google = api.demo || import.meta.env.VITE_GOOGLE === "true";
  const codes = api.demo || import.meta.env.VITE_EMAIL_CODES === "true";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!sent) run(async () => { await api.sendCode(email); setSent(true); });
          else run(() => api.verifyCode(email, code));
        }}
      >
        <div className="row">
          <span className="brand-mark" aria-hidden="true">{initials(SITE_NAME)}</span>
          <div>
            <h1 style={{ fontSize: 18 }}>{SITE_NAME}</h1>
            <div className="small muted">NFL betting leagues · play units</div>
          </div>
        </div>
        {api.demo ? <div className="banner">Demo: use any email, then any 6 digits.</div> : null}
        {!sent ? (
          <>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <button className="btn primary block" disabled={busy || !email}>{busy ? "Sending…" : codes ? "Email me a sign-in code" : "Email me a sign-in link"}</button>
            {google ? (
              <>
                <div className="divider">or</div>
                <button type="button" className="btn block" disabled={busy} onClick={() => run(() => api.signInWithGoogle())}>Continue with Google</button>
              </>
            ) : null}
          </>
        ) : !codes ? (
          <>
            <p className="small muted" style={{ margin: 0 }}>We sent a sign-in link to <b>{email}</b>. Open it in this browser to sign in. It works for an hour.</p>
            <button type="button" className="btn link" onClick={() => setSent(false)}>Use a different email</button>
          </>
        ) : (
          <>
            <p className="small muted" style={{ margin: 0 }}>We sent a 6-digit code to <b>{email}</b>. It works for an hour.</p>
            <label className="field">
              <span>Code</span>
              <input className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••" />
            </label>
            <button className="btn primary block" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
            <button type="button" className="btn link" onClick={() => { setSent(false); setCode(""); }}>Use a different email</button>
          </>
        )}
        {error ? <div className="banner bad" role="alert">{error}</div> : null}
        <p className="tiny muted" style={{ margin: 0 }}>New here? Sign in with your email and you can start a league or join one with an invite link. Play units only: no real money changes hands on this site.</p>
      </form>
    </div>
  );
}
