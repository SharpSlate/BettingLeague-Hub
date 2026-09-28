// The bet slip: picks tapped on the Board, the bet type, stakes and entry.
// Kept in localStorage so a half-built slip survives a reload (per device only).
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BetType, Market, Side } from "@rules";
import { pickLabel } from "./format.ts";

export interface Pick {
  key: string;
  gameId: string;
  market: Market;
  side: Side;
  point: number | null;
  price: number;
  /** Team short names, for labels. */
  home: string;
  away: string;
  kickoffAt: string;
}

const teamsOf = (p: Pick) => ({ home: { abbr: "", name: "", shortName: p.home }, away: { abbr: "", name: "", shortName: p.away } });

/** "Chiefs −3", "Over 47.5", "Bills ML" at the pick's number (or another one, e.g. teased). */
export function pickText(p: Pick, pt: number | null = p.point): string {
  return pickLabel(teamsOf(p), p.market, p.side, pt);
}

export const matchupText = (p: Pick) => `${p.away} at ${p.home}`;

export interface SlipState {
  picks: Pick[];
  mode: BetType;
  teaserPoints: number;
  /** Stake text per pick for straight bets, and under "combo" for a parlay or teaser. */
  stakes: Record<string, string>;
  entryId: string | null;
}

export const pickKey = (gameId: string, market: Market, side: Side) => `${gameId}:${market}:${side}`;

const STORAGE = "bd.slip.v2";
const empty: SlipState = { picks: [], mode: "straight", teaserPoints: 6, stakes: {}, entryId: null };

function load(): SlipState {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? { ...empty, ...JSON.parse(raw) } : empty;
  } catch {
    return empty;
  }
}

interface SlipApi extends SlipState {
  has(key: string): boolean;
  toggle(p: Pick): void;
  remove(key: string): void;
  clear(keepEntry?: boolean): void;
  setMode(m: BetType): void;
  setTeaserPoints(p: number): void;
  setStake(key: string, text: string): void;
  setEntry(id: string): void;
  updateLine(key: string, point: number | null, price: number): void;
  open: boolean;
  setOpen(open: boolean): void;
}

const Ctx = createContext<SlipApi | null>(null);

export function SlipProvider({ children }: { children: ReactNode }) {
  const [s, set] = useState<SlipState>(load);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(s));
    } catch {
      /* private mode: the slip just won't survive a reload */
    }
  }, [s]);

  const api = useMemo<SlipApi>(
    () => ({
      ...s,
      open,
      setOpen,
      has: (key) => s.picks.some((p) => p.key === key),
      toggle: (p) =>
        set((x) => {
          if (x.picks.some((q) => q.key === p.key)) return { ...x, picks: x.picks.filter((q) => q.key !== p.key) };
          const picks = [...x.picks, p];
          return { ...x, picks, mode: x.picks.length === 0 ? "straight" : x.mode };
        }),
      remove: (key) => set((x) => ({ ...x, picks: x.picks.filter((p) => p.key !== key) })),
      clear: (keepEntry = true) => set((x) => ({ ...empty, entryId: keepEntry ? x.entryId : null, mode: x.mode, teaserPoints: x.teaserPoints })),
      setMode: (mode) => set((x) => ({ ...x, mode })),
      setTeaserPoints: (teaserPoints) => set((x) => ({ ...x, teaserPoints })),
      setStake: (key, text) => set((x) => ({ ...x, stakes: { ...x.stakes, [key]: text } })),
      setEntry: (entryId) => set((x) => ({ ...x, entryId })),
      updateLine: (key, point, price) =>
        set((x) => ({ ...x, picks: x.picks.map((p) => (p.key === key ? { ...p, point, price } : p)) })),
    }),
    [s, open],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useSlip(): SlipApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("SlipProvider missing");
  return v;
}
