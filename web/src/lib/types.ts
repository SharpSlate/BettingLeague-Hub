// What the pages work with. Two backends implement Api: Supabase (the real site)
// and an in-memory demo with sample data.
import type { BetType, Leg, LegResult, Market, Problem, RuleSet, Side, SlipResult } from "@rules";

export type GameStatus = "scheduled" | "live" | "final" | "postponed" | "void";

export interface Me {
  id: string;
  displayName: string;
  isAdmin: boolean;
}

export interface WeekInfo {
  week: number;
  label: string;
  startsAt: string;
  endsAt: string;
  status: "upcoming" | "open" | "closed";
  ruleSetVersion: number | null;
}

export interface League {
  name: string;
  openWeek: WeekInfo | null;
  timezone: string;
  pullWindowStart: string;
  pullWindowEnd: string;
  pullEveryMinutes: number;
  books: string[];
  lastPullAt: string | null;
  creditsRemaining: number | null;
}

export interface Team {
  abbr: string;
  name: string;
  shortName: string;
}

export interface LineView {
  market: Market;
  side: Side;
  point: number | null;
  price: number;
  source: string;
  asOf: string;
}

export interface GameView {
  id: string;
  week: number;
  kickoffAt: string;
  /** When betting on it closes: the kickoff, or the feed's own start time if that's earlier. */
  locksAt: string;
  home: Team;
  away: Team;
  status: GameStatus;
  homeScore: number | null;
  awayScore: number | null;
  lines: LineView[];
}

export interface StandingRow {
  entryId: string;
  name: string;
  isMine: boolean;
  bankCents: number;
  seasonNetCents: number;
  seasonWinningsCents: number;
  wins: number;
  losses: number;
  pushes: number;
  riskCents: number;
  returnCents: number;
  netCents: number;
  winningsCents: number;
  atRiskCents: number;
  week: number | null;
  requiredCents: number | null;
  wageredCents: number;
}

export interface MyEntry {
  entryId: string;
  name: string;
  availableCents: number;
  pendingCents: number;
  bankCents: number;
  week: number | null;
  requiredCents: number | null;
  wageredCents: number;
}

export interface LegGame {
  home: Team;
  away: Team;
  kickoffAt: string;
  /** When betting on it closed or closes: the kickoff, or the feed's own start time if that's earlier. */
  locksAt: string;
  status: GameStatus;
  homeScore: number | null;
  awayScore: number | null;
}

export interface LegView {
  legNo: number;
  game: LegGame;
  gameId: string;
  market: Market;
  side: Side;
  point: number | null;
  price: number;
  teasedPoint: number | null;
  book: string;
  result: LegResult;
}

export interface SlipView {
  id: string;
  entryId: string;
  entryName: string;
  placedByName: string | null;
  week: number;
  type: BetType;
  teaserPoints: number | null;
  stakeCents: number;
  /** The slip's odds and payout. Null on another entry's parlay until every leg is revealed. */
  quotedAmerican: number | null;
  potentialPayoutCents: number | null;
  legCount: number;
  ruleSetVersion: number;
  status: SlipResult | "undone";
  payoutCents: number | null;
  placedAt: string;
  settledAt: string | null;
  /** Only the legs the viewer may see; others stay hidden until their kickoffs. */
  legs: LegView[];
}

export interface HiddenPick {
  entryId: string;
  name: string;
  placedAt: string;
}

export interface RuleVersion {
  version: number;
  effectiveWeek: number;
  document: RuleSet;
  note: string;
  createdAt: string;
}

export interface Entrant {
  entryId: string;
  name: string;
  status: string;
  managers: string[];
}

export interface AuditRow {
  id: number;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  reason: string;
  createdAt: string;
}

/** A failed line or score pull, or a grading problem, for the admins. */
export interface AdminProblem {
  at: string;
  kind: string;
  trigger: string;
  error: string;
}

export interface AdminUser {
  userId: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  entryNames: string[];
}

export interface PlacementRequest {
  entryId: string;
  type: BetType;
  teaserPoints: number | null;
  stakeCents: number;
  legs: Leg[];
  /** A random id for this bet, reused on a retry so the bet can't be placed twice. */
  clientRef: string;
}

export type PlaceResult =
  | { ok: true; slipId: string; payoutCents: number; american: number }
  | { ok: false; kind: "moved"; message: string; lines: { leg: number; point: number | null; price: number }[] }
  | { ok: false; kind: "invalid"; problems: Problem[] }
  | { ok: false; kind: "error"; message: string; code?: string };

export interface SplashImport {
  entryId: string;
  bankCents: number;
  netCents: number;
  wins: number;
  losses: number;
  pushes: number;
  riskCents: number;
  returnCents: number;
  winningsCents: number;
  note: string;
}

export interface Api {
  readonly demo: boolean;

  getSession(): Promise<{ userId: string } | null>;
  onAuthChange(cb: () => void): () => void;
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  me(): Promise<Me>;

  league(): Promise<League>;
  teams(): Promise<Team[]>;
  /** Season standings, or one week's (by week number), or bets settled between two times. */
  standings(range?: { from?: string; to?: string; week?: number }): Promise<StandingRow[]>;
  games(week: number): Promise<GameView[]>;
  myEntries(): Promise<MyEntry[]>;
  slips(q: { entryId?: string; mine?: boolean; week?: number; settled?: boolean; limit?: number }): Promise<SlipView[]>;
  hiddenActivity(): Promise<HiddenPick[]>;
  ruleVersions(): Promise<RuleVersion[]>;
  weeks(): Promise<WeekInfo[]>;
  entrants(): Promise<Entrant[]>;
  auditLog(limit?: number): Promise<AuditRow[]>;

  placeSlip(req: PlacementRequest): Promise<PlaceResult>;
  undoSlip(slipId: string): Promise<void>;
  setDisplayName(name: string): Promise<void>;

  adminUsers(): Promise<AdminUser[]>;
  /** Failed pulls and grading problems from the last 3 days, newest first. */
  adminRecentProblems(): Promise<AdminProblem[]>;
  adminAddMember(email: string, displayName: string, entryId: string | null): Promise<void>;
  adminAddEntry(name: string, startingBankCents: number): Promise<string>;
  adminSetManager(entryId: string, userId: string, add: boolean): Promise<void>;
  adminSetAdmin(userId: string, isAdmin: boolean): Promise<void>;
  adminImportSplash(args: SplashImport): Promise<void>;
  adminAdjustBank(entryId: string, amountCents: number, reason: string): Promise<void>;
  /** Closes the open week (the one the page shows) and opens the next. Null when no later week has games. */
  adminOpenNextWeek(expectedOpenWeek: number | null, reason: string): Promise<number | null>;
  /** Closes the season's last week (when no later week has games). */
  adminCloseSeason(expectedOpenWeek: number, reason: string): Promise<void>;
  adminSetLine(gameId: string, market: Market, a: { point: number | null; price: number }, b: { point: number | null; price: number }, offered: boolean, reason: string): Promise<void>;
  adminClearLine(gameId: string, market: Market, reason: string): Promise<void>;
  adminSetGameStatus(gameId: string, status: "scheduled" | "postponed" | "void", kickoffAt: string | null, reason: string): Promise<void>;
  adminSetFinalScore(gameId: string, home: number, away: number, reason: string): Promise<void>;
  adminVoidSlip(slipId: string, reason: string): Promise<void>;
  adminRunJob(job: "pull-lines" | "pull-scores"): Promise<string>;
  adminPublishRules(document: RuleSet, effectiveWeek: number, note: string): Promise<number>;
}
