// Display formatting. Times are shown in Eastern, like every kickoff on Splash.
import type { Market, Side } from "@rules";
import type { GameView, LegView, Team } from "./types.ts";

export const TZ = "America/New_York";
const MINUS = "−";

/** 1234567 cents -> "12,345.67"; whole units drop the decimals. */
export function units(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const whole = cents % 100 === 0;
  const s = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return cents < 0 ? `${MINUS}${s}` : s;
}

/** Signed units for net figures: "+1,200" / "−350.50". */
export function signedUnits(cents: number): string {
  return cents > 0 ? `+${units(cents)}` : units(cents);
}

export function odds(american: number): string {
  return american > 0 ? `+${american}` : `${MINUS}${Math.abs(american)}`;
}

export function point(p: number): string {
  if (p === 0) return "PK";
  return p > 0 ? `+${p}` : `${MINUS}${Math.abs(p)}`;
}

const kickoffFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" });

/** "Sun, Oct 4, 1:00 PM EDT" */
export const kickoff = (iso: string) => kickoffFmt.format(new Date(iso));
export const clock = (iso: string) => timeFmt.format(new Date(iso));
export const day = (iso: string) => dayFmt.format(new Date(iso));

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function matchup(g: Pick<GameView, "home" | "away">): string {
  return `${g.away.shortName} at ${g.home.shortName}`;
}

export function teamFor(g: Pick<GameView, "home" | "away">, side: Side): Team {
  return side === "home" ? g.home : g.away;
}

/** A stat prop's short name after its number: "Over 245.5 pass yds". */
export const PROP_UNIT: Record<string, string> = {
  receptions: "receptions",
  rush_yds: "rush yds",
  rec_yds: "rec yds",
  pass_yds: "pass yds",
};

/**
 * "Chiefs −3", "Over 47.5", "Bills ML", "Josh Allen anytime TD", "Josh Allen Over 245.5
 * pass yds" — the pick itself, without the price.
 */
export function pickLabel(g: Pick<GameView, "home" | "away">, market: Market, side: Side, pt: number | null, player?: string | null): string {
  if (market === "anytime_td") return `${player ?? "?"} anytime TD`;
  if (PROP_UNIT[market]) return `${player ?? "?"} ${side === "over" ? "Over" : "Under"} ${pt} ${PROP_UNIT[market]}`;
  if (market === "total") return `${side === "over" ? "Over" : "Under"} ${pt}`;
  const t = teamFor(g, side).shortName;
  return market === "moneyline" ? `${t} ML` : `${t} ${point(pt ?? 0)}`;
}

/** A line's number as the slip shows it: "+3", "47.5", or nothing for a moneyline or an anytime TD. */
export function lineNumber(market: Market, pt: number | null): string {
  if (market === "moneyline" || market === "anytime_td" || pt === null) return "";
  return market === "spread" ? point(pt) : String(pt);
}

export function legLabel(g: Pick<GameView, "home" | "away"> | undefined, leg: Pick<LegView, "market" | "side" | "point" | "teasedPoint" | "player">): string {
  if (!g) return "Hidden until kickoff";
  const shown = leg.teasedPoint ?? leg.point;
  const base = pickLabel(g, leg.market, leg.side, shown, leg.player);
  return leg.teasedPoint !== null && leg.teasedPoint !== undefined ? `${base} (teased from ${leg.market === "total" ? leg.point : point(leg.point ?? 0)})` : base;
}

export const betTypeName = { straight: "Straight", parlay: "Parlay", teaser: "Teaser" } as const;

export function record(w: number, l: number, p: number): string {
  return p ? `${w}-${l}-${p}` : `${w}-${l}`;
}

/**
 * Reads a number as typed: a minus sign may be a hyphen or a typographic minus (as
 * the Rules page shows prices), and anything that isn't a plain number is NaN, so a
 * rules check flags it instead of the sign being silently dropped.
 */
export function parseNumber(text: string): number {
  const t = text.trim().replace(/^[\u2212\u2013]/, "-").replace(/,/g, "");
  return /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : NaN;
}

/** When a calendar day ("2026-10-04") starts in Eastern time, as an ISO instant. */
export function easternDayStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, offset);
    if (Number(hour.format(t)) === 0) return new Date(t).toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d, 5)).toISOString();
}

/** The calendar day after the given one. */
export function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function toCents(unitsText: string): number | null {
  const t = unitsText.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
