import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ApiContext, makeApi } from "./lib/api.ts";
import { applyTheme } from "./pages/Profile.tsx";
import "./styles.css";

// The deployed site has one address. A copy opened anywhere else, like the older github.io
// address once the site has its own, sends the visitor there, keeping the page they asked
// for (an invite link's #/join/CODE). Only origins are compared, so a path that differs by
// a trailing slash can't send the page in circles.
const home = siteAddress(import.meta.env.VITE_SITE_URL);
if (home && home.origin !== location.origin) location.replace(home.origin + home.pathname + location.search + location.hash);
else start();

function siteAddress(url: string | undefined): URL | null {
  try {
    return url ? new URL(url) : null;
  } catch {
    return null;
  }
}

function start() {
  applyTheme();
  const root = createRoot(document.getElementById("root")!);
  makeApi().then(
    (api) => {
      root.render(
        <StrictMode>
          <ApiContext.Provider value={api}>
            <App />
          </ApiContext.Provider>
        </StrictMode>,
      );
    },
    (e: unknown) => {
      root.render(<div className="empty" role="alert">{e instanceof Error ? e.message : String(e)} Tell the commissioner.</div>);
    },
  );
}
