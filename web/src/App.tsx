import { useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell.tsx";
import { Loading } from "./components/ui.tsx";
import { useApi } from "./lib/api.ts";
import { useLoad } from "./lib/hooks.ts";
import { MeContext } from "./lib/me.ts";
import { SlipProvider } from "./lib/slip.tsx";
import { Admin } from "./pages/Admin.tsx";
import { Board } from "./pages/Board.tsx";
import { Entry } from "./pages/Entry.tsx";
import { League } from "./pages/League.tsx";
import { MyBets } from "./pages/MyBets.tsx";
import { Picks } from "./pages/Picks.tsx";
import { Profile } from "./pages/Profile.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { Standings } from "./pages/Standings.tsx";

export function App() {
  const api = useApi();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    const check = () => api.getSession().then((s) => setSignedIn(!!s));
    check();
    return api.onAuthChange(check);
  }, [api]);

  if (signedIn === null) return <Loading what="Starting" />;
  if (!signedIn) return <SignIn />;
  return <SignedIn />;
}

function SignedIn() {
  const api = useApi();
  const me = useLoad(() => api.me(), []);
  const league = useLoad(() => api.league(), [], 120_000);
  if (me.error) return <div className="signin"><div className="card stack"><b>Couldn't load your account.</b><span className="small muted">{me.error}</span><button className="btn" onClick={() => api.signOut()}>Sign out</button></div></div>;
  if (!me.data) return <Loading what="Loading your account" />;
  return (
    <MeContext.Provider value={me.data}>
      <SlipProvider>
        <HashRouter>
          <Shell me={me.data} league={league.data}>
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
        </HashRouter>
      </SlipProvider>
    </MeContext.Provider>
  );
}
