// The bet slip: picks tapped on the Board, the bet type, stakes and entry.
// Kept in localStorage so a half-built slip survives a reload (per device only).
// What happened on the last submit (a moved line, a problem, a bet in flight) is kept
// here too, not in the slip component, because the Board shows the slip in two places
// (the side panel and the phone sheet) and the phone sheet closes after a bet.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BetType, Market, Problem, Side } from "@rules";
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
  /**
   * The id sent with each bet not yet confirmed placed, by slip item, with the bet it was
   * for. Saved with the slip, so a reload after a lost answer resends the same id and the
   * server returns the bet instead of placing it twice.
   */
  refs: Record<string, { fingerprint: string; ref: string }>;
}

export const pickKey = (gameId: string, market: Market, side: Side) => `${gameId}:${market}:${side}`;

const STORAGE = "bd.slip.v2";
const empty: SlipState = { picks: [], mode: "straight", teaserPoints: 6, stakes: {}, entryId: null, refs: {} };

function load(): SlipState {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? { ...empty, ...JSON.parse(raw) } : empty;
  } catch {
    return empty;
  }
}

/** Drops a bet's id from the saved slip at once, rather than at the next save after a render. */
function unsaveRef(key: string) {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<SlipState>;
    if (!saved.refs?.[key]) return;
    const { [key]: _gone, ...refs } = saved.refs;
    localStorage.setItem(STORAGE, JSON.stringify({ ...saved, refs }));
  } catch {
    /* private mode */
  }
}

export interface Moved { key: string; label: string; from: string; to: string; point: number | null; price: number }

export interface SlipStatus {
  /** A submit is in flight; the slip can't be edited until it's done. */
  busy: boolean;
  attempted: boolean;
  serverProblems: Problem[];
  error: string | null;
  moved: Moved[];
}

const idle: SlipStatus = { busy: false, attempted: false, serverProblems: [], error: null, moved: [] };

/** A random id for a bet. The server places each id once, so a retry can't double a bet. */
export function newClientRef(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
  status: SlipStatus;
  setStatus(s: Partial<SlipStatus>): void;
  /**
   * The id to send with a bet. The same bet (same fingerprint) keeps its id until it's
   * placed, so resending after a lost response returns the bet instead of doubling it.
   */
  clientRef(key: string, fingerprint: string): string;
  forgetRef(key: string): void;
}

const Ctx = createContext<SlipApi | null>(null);

export function SlipProvider({ children }: { children: ReactNode }) {
  const [s, set] = useState<SlipState>(load);
  const [open, setOpen] = useState(false);
  const [status, setStatusState] = useState<SlipStatus>(idle);
  // Read and written synchronously while a submit runs, and mirrored into the saved slip.
  const refs = useRef<SlipState["refs"]>(s.refs ?? {});
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
      clear: (keepEntry = true) => {
        refs.current = {};
        set((x) => ({ ...empty, entryId: keepEntry ? x.entryId : null, mode: x.mode, teaserPoints: x.teaserPoints }));
      },
      setMode: (mode) => set((x) => ({ ...x, mode })),
      setTeaserPoints: (teaserPoints) => set((x) => ({ ...x, teaserPoints })),
      setStake: (key, text) => set((x) => ({ ...x, stakes: { ...x.stakes, [key]: text } })),
      setEntry: (entryId) => set((x) => ({ ...x, entryId })),
      updateLine: (key, point, price) =>
        set((x) => ({ ...x, picks: x.picks.map((p) => (p.key === key ? { ...p, point, price } : p)) })),
      status,
      setStatus: (p) => setStatusState((x) => ({ ...x, ...p })),
      clientRef: (key, fingerprint) => {
        // Another tab may have sent this same bet already: its id is in the saved slip.
        const mine = refs.current[key];
        const saved = load().refs?.[key];
        const cur = mine?.fingerprint === fingerprint ? mine
          : saved?.fingerprint === fingerprint ? saved
          : { fingerprint, ref: newClientRef() };
        const next = { ...refs.current, [key]: cur };
        refs.current = next;
        set((x) => ({ ...x, refs: next }));
        return cur.ref;
      },
      forgetRef: (key) => {
        const { [key]: _gone, ...rest } = refs.current;
        refs.current = rest;
        // clientRef also reads the saved slip, so drop the id there now too; otherwise a
        // resend right after this (see Slip.tsx) would pick the used id back up.
        unsaveRef(key);
        set((x) => ({ ...x, refs: rest }));
      },
    }),
    [s, open, status],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useSlip(): SlipApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("SlipProvider missing");
  return v;
}
