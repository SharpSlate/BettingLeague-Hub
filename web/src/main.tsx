import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ApiContext, makeApi } from "./lib/api.ts";
import { applyTheme } from "./pages/Profile.tsx";
import "./styles.css";

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
