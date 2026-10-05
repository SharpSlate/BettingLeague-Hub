// What the pages work with. Two backends implement Api: Supabase (the real site)
// and an in-memory demo with sample data.
import type { BetType, Leg, LegResult, Market, Problem, PropMarket, RuleSet, Side, SlipResult } from "@rules";

export type GameStatus = "scheduled" | "live" | "final" | "postponed" | "void";

export interface Me {
  id: string;
  displayName: string;
  /** Runs the games, lines and pulls every league shares. Gives no say in anyone's league. */
  isSiteAdmin: boolean;
  /** A commissioner of the league being viewed: runs its rules, entries, weeks and banks. */
  isCommissioner: boolean;
}

/** A league the signed-in member belongs to. */
export interface LeagueSummary {
  id: string;
  name: string;
  role: "commissioner" | "member";
  /** Only for commissioners, who decide who gets it. */
  inviteCode: string | null;
  selfEntry: boolean;
  openWeek: number | null;
}

/** What an invite code leads to. */
export interface InvitePreview {
  leagueId: string;
  name: string;
  members: number;
  alreadyMember: boolean;
  /** Whether joining comes with an entry of your own. */
  selfEntry: boolean;
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
  id: string;
  name: string;
  role: "commissioner" | "member";
  inviteCode: string | null;
  selfEntry: boolean;
  openWeek: WeekInfo | null;
  timezone: string;
  pullWindowStart: string;
  pullWindowEnd: string;
  pullEveryMinutes: number;
  pullNearKickoffMinutes: number;
  nearKickoffHours: number;
  /** A bet refreshes the lines when they're older than this... */
  refreshOnBetSeconds: number;
  /** ...at most once this often for each member's bets. */
  betRefreshMemberMinutes: number;
  books: string[];
  lastPullAt: string | null;
  creditsRemaining: number | null;
  /** Off until the site's owner turns the odds feed on; until then nothing calls the Odds API. */
  oddsPullsEnabled: boolean;
  /** When the latest player props were pulled at the books (from the owner's own pulls). */
  propsPulledAt: string | null;
  /** Props older than this can't be bet on. */
  propMaxAgeMinutes: number;
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

/** One side of a player prop the league offers. */
export interface PropView {
  market: PropMarket;
  player: string;
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
  props: PropView[];
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
  /** A player prop's player; null for a game's own markets. */
  player: string | null;
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
  isCommissioner: boolean;
  entryNames: string[];
}

export interface PlayerStatsInput {
  passYds: number;
  rushYds: number;
  recYds: number;
  receptions: number;
  tds: number;
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

/**
 * One bet's undo. code says why one wasn't undone; only undo_lines_stale (the lines
 * couldn't be pulled just then) and error are worth trying again soon.
 */
export type UndoResult = { slipId: string; undone: true } | { slipId: string; undone: false; code: string; message: string };

export interface Api {
  readonly demo: boolean;

  /** newPassword: a password-reset email just signed them in, so the site asks for a new password first. */
  getSession(): Promise<{ userId: string; newPassword: boolean } | null>;
  onAuthChange(cb: () => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  /** Makes an account and signs in. New accounts don't confirm their email, so nothing is sent. */
  signUp(email: string, password: string): Promise<void>;
  /** Emails a 6-digit code for choosing a new password; before the site has its own sender, a link. */
  sendPasswordReset(email: string): Promise<void>;
  /** Signs in with that code; the site then asks for the new password. */
  verifyResetCode(email: string, code: string): Promise<void>;
  /** Changes the signed-in member's password. */
  setPassword(password: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  me(): Promise<Me>;

  /** The leagues the signed-in member belongs to. */
  myLeagues(): Promise<LeagueSummary[]>;
  /** Picks the league every league-level call below is about. */
  setLeague(leagueId: string): void;
  /** Starts a league with the caller as commissioner; returns its id. */
  createLeague(name: string): Promise<string>;
  inviteInfo(code: string): Promise<InvitePreview | null>;
  /** Joins by invite code, with an entry of your own when entryName is given; returns the league's id. */
  joinLeague(code: string, entryName: string | null): Promise<string>;

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
  /** Undoes bets, each on its own: the answer says what happened to each. */
  undoSlips(slipIds: string[]): Promise<UndoResult[]>;
  setDisplayName(name: string): Promise<void>;

  adminUpdateLeague(name: string, selfEntry: boolean, newInvite: boolean): Promise<void>;
  adminSetCommissioner(userId: string, on: boolean): Promise<void>;
  adminRemoveMember(userId: string): Promise<void>;
  adminUsers(): Promise<AdminUser[]>;
  /** Failed pulls and grading problems from the last 3 days, newest first. */
  adminRecentProblems(): Promise<AdminProblem[]>;
  /** created is false when the email already belonged to a member (nobody new was added). */
  adminAddMember(email: string, displayName: string, entryId: string | null): Promise<{ created: boolean }>;
  adminAddEntry(name: string, startingBankCents: number): Promise<string>;
  adminSetManager(entryId: string, userId: string, add: boolean): Promise<void>;
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
  /** A player's stats on a final game, for his props, or null stats when he didn't play. */
  adminSetPlayerStats(gameId: string, player: string, stats: PlayerStatsInput | null, reason: string): Promise<void>;
  adminVoidSlip(slipId: string, reason: string): Promise<void>;
  adminRunJob(job: "pull-lines" | "pull-scores"): Promise<string>;
  adminPublishRules(document: RuleSet, effectiveWeek: number, note: string): Promise<number>;
}
