import { useEffect, useState } from "react";
import { HashRouter, MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell.tsx";
import { Loading } from "./components/ui.tsx";
import { useApi } from "./lib/api.ts";
import { useLoad } from "./lib/hooks.ts";
import { MeContext } from "./lib/me.ts";
import { SlipProvider, slipStorageKey } from "./lib/slip.tsx";
import type { LeagueSummary } from "./lib/types.ts";
import { Admin } from "./pages/Admin.tsx";
import { Board } from "./pages/Board.tsx";
import { Entry } from "./pages/Entry.tsx";
import { League } from "./pages/League.tsx";
import { Join, Leagues } from "./pages/Leagues.tsx";
import { MyBets } from "./pages/MyBets.tsx";
import { Picks } from "./pages/Picks.tsx";
import { Profile } from "./pages/Profile.tsx";
import { NewPassword, SignIn } from "./pages/SignIn.tsx";
import { Standings } from "./pages/Standings.tsx";

export function App() {
  const api = useApi();
  // "new-password": a password-reset email signed them in, so they choose a password first.
  const [auth, setAuth] = useState<"out" | "in" | "new-password" | null>(null);
  useEffect(() => {
    const check = () => api.getSession().then((s) => setAuth(!s ? "out" : s.newPassword ? "new-password" : "in"));
    check();
    return api.onAuthChange(check);
  }, [api]);

  if (auth === null) return <Loading what="Starting" />;
  if (auth === "out") return <SignIn />;
  if (auth === "new-password") return <NewPassword onDone={() => setAuth("in")} />;
  return <SignedIn />;
}

const LAST_LEAGUE = "blh.league";
function storedLeague(): string | null {
  try {
    return localStorage.getItem(LAST_LEAGUE);
  } catch {
    return null;
  }
}

/** The member's leagues, and the one they're looking at. */
function SignedIn() {
  const api = useApi();
  const leagues = useLoad(() => api.myLeagues(), []);
  const [chosen, setChosen] = useState<string | null>(storedLeague());
  // A league just started or joined isn't in the list until the list reloads. Wait for it,
  // rather than opening another league or sending the member back to the list.
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => setOpening(null), [leagues.data]);
  const choose = (id: string) => {
    setChosen(id);
    setOpening(id);
    try { localStorage.setItem(LAST_LEAGUE, id); } catch { /* ignore */ }
    leagues.reload();
  };
  if (leagues.error) return <div className="signin"><div className="card stack"><b>Couldn't load your leagues.</b><span className="small muted">{leagues.error}</span><button className="btn" onClick={() => api.signOut()}>Sign out</button></div></div>;
  if (!leagues.data) return <Loading what="Loading your leagues" />;
  const list = leagues.data;
  if (opening && !list.some((l) => l.id === opening)) return <Loading what="Opening your league" />;
  const current = list.find((l) => l.id === chosen) ?? list[0] ?? null;
  // Pages uses #/ routes; the demo page embedded elsewhere keeps its route in memory.
  const Router = import.meta.env.VITE_ROUTER === "memory" ? MemoryRouter : HashRouter;
  return (
    <Router>
      <Routes>
        <Route path="/join/:code" element={<Join onJoined={choose} />} />
        <Route path="/leagues" element={<Leagues leagues={list} current={current?.id ?? null} onChoose={choose} />} />
        <Route path="*" element={current ? <LeagueApp key={current.id} league={current} leagues={list} onChoose={choose} /> : <Navigate to="/leagues" replace />} />
      </Routes>
    </Router>
  );
}

/** Everything inside one league. Remounted when the league changes, so nothing carries over. */
function LeagueApp({ league: summary, leagues, onChoose }: { league: LeagueSummary; leagues: LeagueSummary[]; onChoose: (id: string) => void }) {
  const api = useApi();
  api.setLeague(summary.id);
  const me = useLoad(() => api.me(), []);
  const league = useLoad(() => api.league(), [], 120_000);
  if (me.error) return <div className="signin"><div className="card stack"><b>Couldn't load your account.</b><span className="small muted">{me.error}</span><button className="btn" onClick={() => api.signOut()}>Sign out</button></div></div>;
  if (!me.data) return <Loading what="Loading your account" />;
  return (
    <MeContext.Provider value={me.data}>
      <SlipProvider storageKey={slipStorageKey(summary.id)}>
        <Shell me={me.data} league={league.data} leagues={leagues} onChoose={onChoose}>
          <Routes>
            <Route path="/" element={<Standings />} />
            <Route path="/board" element={<Board />} />
            <Route path="/picks" element={<Picks />} />
            <Route path="/bets" element={<MyBets />} />
            <Route path="/league" element={<League />} />
            <Route path="/entry/:id" element={<Entry />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/profile" element={<Profile onChanged={me.reload} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </SlipProvider>
    </MeContext.Provider>
  );
}
