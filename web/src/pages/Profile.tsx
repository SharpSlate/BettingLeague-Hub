import { useState } from "react";
import { PageHead, Segmented } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { useMe } from "../lib/me.ts";

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
