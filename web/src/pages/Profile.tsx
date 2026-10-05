import { useState } from "react";
import { PageHead, Segmented } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { MIN_PASSWORD } from "../lib/auth.ts";
import { useMe } from "../lib/me.ts";
import { PasswordField } from "./SignIn.tsx";

type Theme = "auto" | "light" | "dark";

// Its own key: the single-league site on the same address keeps its theme under "bd.theme".
const THEME_KEY = "blh.theme";

function readTheme(): Theme {
  try {
    return (localStorage.getItem(THEME_KEY) as Theme) || "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(t: Theme = readTheme()) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

export function Profile({ onChanged }: { onChanged: () => void }) {
  const api = useApi();
  const me = useMe();
  const [name, setName] = useState(me.displayName);
  const [saved, setSaved] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme());

  return (
    <>
      <PageHead title="Profile" />
      <div className="stack" style={{ maxWidth: 480 }}>
        <form
          className="card pad form"
          onSubmit={async (e) => {
            e.preventDefault();
            await api.setDisplayName(name);
            setSaved(true);
            onChanged();
          }}
        >
          <label className="field">
            <span>Display name</span>
            <input className="input" maxLength={40} value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
          </label>
          <button className="btn primary" disabled={!name.trim() || name === me.displayName}>Save</button>
          {saved ? <span className="small good">Saved.</span> : null}
        </form>
        <ChangePassword />
        <div className="card pad stack-sm">
          <b>Appearance</b>
          <Segmented<Theme>
            label="Theme"
            value={theme}
            onChange={(t) => {
              setTheme(t);
              try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
              applyTheme(t);
            }}
            options={[{ value: "auto", label: "Match phone" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          />
        </div>
        <button className="btn danger" onClick={() => api.signOut()}>Sign out</button>
      </div>
    </>
  );
}

/** Sets the password they sign in with. Members who signed in another way can add one here too. */
function ChangePassword() {
  const api = useApi();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="card pad form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setNote(null);
        try {
          await api.setPassword(password);
          setPassword("");
          setNote({ ok: true, text: "Password changed. Use it the next time you sign in." });
        } catch (err) {
          setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <PasswordField label="New password" value={password} onChange={(v) => { setPassword(v); setNote(null); }} isNew />
      <button className="btn primary" disabled={busy || password.length < MIN_PASSWORD}>{busy ? "Saving…" : "Change password"}</button>
      {note ? <span className={`small ${note.ok ? "good" : "bad"}`} role={note.ok ? undefined : "alert"}>{note.text}</span> : null}
    </form>
  );
}
