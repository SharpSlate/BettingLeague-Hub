import { useState } from "react";
import { SiteLogo } from "../components/SiteLogo.tsx";
import { useApi } from "../lib/api.ts";
import { MIN_PASSWORD } from "../lib/auth.ts";

/** One sign-in step at a time: busy while it runs, and its refusal if it fails. */
function useStep() {
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
  return { busy, error, setError, run };
}

function Brand() {
  return (
    <div className="stack-sm">
      <h1><SiteLogo large /></h1>
      <div className="small muted">NFL betting leagues · play units</div>
    </div>
  );
}

/** A password box with its "Show password" switch. A new password says how long it must be. */
export function PasswordField({ label, value, onChange, isNew }: { label: string; value: string; onChange: (v: string) => void; isNew?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="stack-sm">
      <label className="field">
        <span>{label}</span>
        <input
          className="input" type={show ? "text" : "password"} required value={value} onChange={(e) => onChange(e.target.value)}
          autoComplete={isNew ? "new-password" : "current-password"} minLength={isNew ? MIN_PASSWORD : undefined}
        />
      </label>
      <div className="pw-foot small muted">
        {isNew ? <span>At least {MIN_PASSWORD} characters.</span> : <span />}
        <label><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password</label>
      </div>
    </div>
  );
}

type Mode = "signin" | "signup" | "forgot";

/** The example league's "Start your own league" link opens the site on #/signup. */
const firstMode = (): Mode => (window.location.hash === "#/signup" ? "signup" : "signin");

export function SignIn() {
  const api = useApi();
  // The deploy sets VITE_GOOGLE once the site has a Google sign-in client, and
  // VITE_EMAIL_CODES once it has its own email sender. Until then a password reset
  // email is Supabase's standard one, which has a link rather than a code.
  const google = api.demo || import.meta.env.VITE_GOOGLE === "true";
  const codes = api.demo || import.meta.env.VITE_EMAIL_CODES === "true";
  const [mode, setMode] = useState<Mode>(firstMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const { busy, error, setError, run } = useStep();
  const go = (m: Mode) => { setMode(m); setPassword(""); setCode(""); setSent(false); setError(null); };

  const emailField = (
    <label className="field">
      <span>Email</span>
      <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
    </label>
  );
  const googleButton = google ? (
    <>
      <div className="divider">or</div>
      <button type="button" className="btn block" disabled={busy} onClick={() => run(() => api.signInWithGoogle())}>Continue with Google</button>
    </>
  ) : null;

  return (
    <div className="signin">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "signin") run(() => api.signIn(email, password));
          else if (mode === "signup") run(() => api.signUp(email, password));
          else if (!sent) run(async () => { await api.sendPasswordReset(email); setSent(true); });
          else run(() => api.verifyResetCode(email, code));
        }}
      >
        <Brand />
        {api.demo ? <div className="banner">Demo: use any email and a password of {MIN_PASSWORD} or more characters.</div> : null}

        {mode === "signin" ? (
          <>
            {emailField}
            <PasswordField label="Password" value={password} onChange={setPassword} />
            <button className="btn primary block" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</button>
            <button type="button" className="btn link" onClick={() => go("forgot")}>Forgot your password?</button>
            {googleButton}
            {error ? <div className="banner bad" role="alert">{error}</div> : null}
            <p className="small muted" style={{ margin: 0 }}>New here? <button type="button" className="btn link" onClick={() => go("signup")}>Create an account</button></p>
          </>
        ) : mode === "signup" ? (
          <>
            <h2>Create an account</h2>
            {emailField}
            <PasswordField label="Password" value={password} onChange={setPassword} isNew />
            <button className="btn primary block" disabled={busy || !email || password.length < MIN_PASSWORD}>{busy ? "Creating…" : "Create account"}</button>
            {googleButton}
            {error ? <div className="banner bad" role="alert">{error}</div> : null}
            <p className="small muted" style={{ margin: 0 }}>Already have an account? <button type="button" className="btn link" onClick={() => go("signin")}>Sign in</button></p>
          </>
        ) : !sent ? (
          <>
            <h2>Forgot your password?</h2>
            <p className="small muted" style={{ margin: 0 }}>
              {codes ? "We'll email you a code, then you choose a new password." : "We'll email you a link, then you choose a new password."}
              {" "}This also sets a first password for an account your commissioner made for you.
            </p>
            {emailField}
            <button className="btn primary block" disabled={busy || !email}>{busy ? "Sending…" : codes ? "Email me a code" : "Email me a link"}</button>
            {error ? <div className="banner bad" role="alert">{error}</div> : null}
            <button type="button" className="btn link" onClick={() => go("signin")}>Back to sign in</button>
          </>
        ) : !codes ? (
          <>
            <p className="small muted" style={{ margin: 0 }}>If <b>{email}</b> has an account, we just emailed it a link. Open the link in this browser to choose a new password. It works for an hour.</p>
            <button type="button" className="btn link" onClick={() => go("signin")}>Back to sign in</button>
          </>
        ) : (
          <>
            <p className="small muted" style={{ margin: 0 }}>If <b>{email}</b> has an account, we just emailed it a 6-digit code. It works for an hour.</p>
            <label className="field">
              <span>Code</span>
              <input className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••" />
            </label>
            <button className="btn primary block" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Continue"}</button>
            {error ? <div className="banner bad" role="alert">{error}</div> : null}
            <div className="row wrap" style={{ justifyContent: "space-between" }}>
              <button type="button" className="btn link" disabled={busy} onClick={() => run(async () => { setCode(""); await api.sendPasswordReset(email); })}>Send a new code</button>
              <button type="button" className="btn link" onClick={() => go("signin")}>Back to sign in</button>
            </div>
          </>
        )}
        {!api.demo && (mode === "signin" || mode === "signup") ? (
          <a className="btn block" href="demo/">See an example league first</a>
        ) : null}
        <p className="tiny muted" style={{ margin: 0 }}>Start a league, or join one with its invite link. Play units only: no real money changes hands on this site.</p>
      </form>
    </div>
  );
}

/** After a password-reset email signs a member in: they choose the password they'll use from now on. */
export function NewPassword({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const [password, setPassword] = useState("");
  const { busy, error, run } = useStep();
  return (
    <div className="signin">
      <form className="card" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.setPassword(password); onDone(); }); }}>
        <Brand />
        <h2>Choose a new password</h2>
        <p className="small muted" style={{ margin: 0 }}>You're signed in. Choose the password you'll sign in with from now on.</p>
        <PasswordField label="New password" value={password} onChange={setPassword} isNew />
        <button className="btn primary block" disabled={busy || password.length < MIN_PASSWORD}>{busy ? "Saving…" : "Save password"}</button>
        {error ? <div className="banner bad" role="alert">{error}</div> : null}
        <button type="button" className="btn link" onClick={() => api.signOut()}>Sign out</button>
      </form>
    </div>
  );
}
