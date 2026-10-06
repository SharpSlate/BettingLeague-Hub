import type { ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useApi } from "../lib/api.ts";
import type { League, LeagueSummary, Me } from "../lib/types.ts";
import { AdminIcon, BetsIcon, BoardIcon, LeagueIcon, PicksIcon, RulesIcon, StandingsIcon, UserIcon } from "./icons.tsx";

const TABS = [
  { to: "/", label: "Standings", icon: StandingsIcon, end: true },
  { to: "/board", label: "Board", icon: BoardIcon },
  { to: "/picks", label: "League Picks", short: "Picks", icon: PicksIcon },
  { to: "/bets", label: "My Bets", icon: BetsIcon },
  { to: "/rules", label: "Rules", icon: RulesIcon },
  { to: "/league", label: "League", icon: LeagueIcon },
];

/** Up to two letters for the league's badge: its first two words' initials. */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "").slice(0, 2)).toUpperCase();
}

function Brand({ league }: { league: League | undefined }) {
  // One word per line, so the whole name fits in the sidebar and the phone's top bar.
  const words = (league?.name ?? "").split(/\s+/).filter(Boolean);
  return (
    <Link to="/" className="brand" aria-label="Standings">
      <span className="brand-mark" aria-hidden="true">{initials(league?.name ?? "")}</span>
      <span style={{ minWidth: 0 }}>
        <div className="brand-name">{words.map((w, i) => <span key={i}>{w}</span>)}</div>
        <div className="brand-sub">{league?.openWeek ? `${league.openWeek.label} is open` : "Betting closed"}</div>
      </span>
    </Link>
  );
}

const NEW = "__new__";

/** Switches between the member's leagues, or goes to start or join another. */
function LeagueSwitch({ current, leagues, onChoose, className }: { current: string; leagues: LeagueSummary[]; onChoose: (id: string) => void; className?: string }) {
  const navigate = useNavigate();
  return (
    <select
      className={`input ${className ?? ""}`}
      aria-label="League"
      value={current}
      onChange={(e) => {
        if (e.target.value === NEW) navigate("/leagues");
        else {
          onChoose(e.target.value);
          navigate("/");
        }
      }}
    >
      {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      <option value={NEW}>Start or join a league…</option>
    </select>
  );
}

export function Shell({ me, league, leagues, onChoose, children }: {
  me: Me;
  league: League | undefined;
  leagues: LeagueSummary[];
  onChoose: (id: string) => void;
  children: ReactNode;
}) {
  const api = useApi();
  const admin = me.isCommissioner || me.isSiteAdmin;
  const current = league?.id ?? leagues[0]?.id ?? "";
  return (
    <>
      {api.demo ? <div className="demo-ribbon">Demo with sample data: nothing here is real, and it resets when you reload.</div> : null}
      <div className="app">
        <nav className="sidebar" aria-label="Main">
          <Brand league={league} />
          <LeagueSwitch current={current} leagues={leagues} onChoose={onChoose} className="league-switch" />
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `side-link${isActive ? " active" : ""}`}>
              <t.icon />
              {t.label}
            </NavLink>
          ))}
          {admin ? (
            <NavLink to="/admin" className={({ isActive }) => `side-link${isActive ? " active" : ""}`}>
              <AdminIcon />
              Admin
            </NavLink>
          ) : null}
          <div className="foot">
            <NavLink to="/profile" className={({ isActive }) => `side-link${isActive ? " active" : ""}`}>
              <UserIcon />
              {me.displayName}
            </NavLink>
          </div>
        </nav>
        <div>
          <header className="topbar">
            <Brand league={league} />
            <span className="spacer" />
            <LeagueSwitch current={current} leagues={leagues} onChoose={onChoose} className="league-switch only-sm" />
            {admin ? (
              <Link to="/admin" className="icon-btn only-sm" aria-label="Admin"><AdminIcon /></Link>
            ) : null}
            <Link to="/profile" className="icon-btn only-sm" aria-label="Profile"><UserIcon /></Link>
          </header>
          <main className="main">{children}</main>
        </div>
      </div>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
            <t.icon />
            {t.short ?? t.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
