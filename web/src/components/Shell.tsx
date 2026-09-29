import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useApi } from "../lib/api.ts";
import type { League, Me } from "../lib/types.ts";
import { AdminIcon, BetsIcon, BoardIcon, LeagueIcon, PicksIcon, StandingsIcon, UserIcon } from "./icons.tsx";

const TABS = [
  { to: "/", label: "Standings", icon: StandingsIcon, end: true },
  { to: "/board", label: "Board", icon: BoardIcon },
  { to: "/picks", label: "League Picks", short: "Picks", icon: PicksIcon },
  { to: "/bets", label: "My Bets", icon: BetsIcon },
  { to: "/league", label: "League", icon: LeagueIcon },
];

function Brand({ league }: { league: League | undefined }) {
  // One word per line, so the whole name fits in the sidebar and the phone's top bar.
  const words = (league?.name ?? "BALTIMORE DEGENERATES").split(/\s+/).filter(Boolean);
  return (
    <Link to="/" className="brand" aria-label="Standings">
      <span className="brand-mark" aria-hidden="true">BD</span>
      <span style={{ minWidth: 0 }}>
        <div className="brand-name">{words.map((w, i) => <span key={i}>{w}</span>)}</div>
        <div className="brand-sub">{league?.openWeek ? `${league.openWeek.label} is open` : "Betting closed"}</div>
      </span>
    </Link>
  );
}

export function Shell({ me, league, children }: { me: Me; league: League | undefined; children: ReactNode }) {
  const api = useApi();
  return (
    <>
      {api.demo ? <div className="demo-ribbon">Demo with sample data: nothing here is real, and it resets when you reload.</div> : null}
      <div className="app">
        <nav className="sidebar" aria-label="Main">
          <Brand league={league} />
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `side-link${isActive ? " active" : ""}`}>
              <t.icon />
              {t.label}
            </NavLink>
          ))}
          {me.isAdmin ? (
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
            {me.isAdmin ? (
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
