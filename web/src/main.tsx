import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ApiContext, makeApi } from "./lib/api.ts";
import { applyTheme } from "./pages/Profile.tsx";
import "./styles.css";

applyTheme();
const api = makeApi();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApiContext.Provider value={api}>
      <App />
    </ApiContext.Provider>
  </StrictMode>,
);
