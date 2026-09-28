import { useState } from "react";
import { useApi } from "../lib/api.ts";

export function SignIn() {
  const api = useApi();
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
          <span className="brand-mark" aria-hidden="true">BD</span>
          <div>
            <h1 style={{ fontSize: 18 }}>BALTIMORE DEGENERATES</h1>
            <div className="small muted">NFL betting league · play units</div>
          </div>
        </div>
        {api.demo ? <div className="banner">Demo: use any email, then any 6 digits.</div> : null}
        {!sent ? (
          <>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <button className="btn primary block" disabled={busy || !email}>{busy ? "Sending…" : "Email me a sign-in code"}</button>
            <div className="divider">or</div>
            <button type="button" className="btn block" disabled={busy} onClick={() => run(() => api.signInWithGoogle())}>Continue with Google</button>
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
        <p className="tiny muted" style={{ margin: 0 }}>Only league members can sign in. New here? Ask the commissioner to add your email.</p>
      </form>
    </div>
  );
}
