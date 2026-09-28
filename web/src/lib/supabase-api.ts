// The real backend. Reads go straight to Supabase and are limited by Row Level
// Security; bets and admin work go through database functions and Edge Functions.
import { createClient, FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";
import type { RuleSet } from "@rules";
import type {
  AdminUser, Api, AuditRow, Entrant, GameView, HiddenPick, League, LegView, Me, MyEntry, PlacementRequest, PlaceResult,
  RuleVersion, SlipView, SplashImport, StandingRow, Team, WeekInfo,
} from "./types.ts";

const n = (x: unknown) => (x === null || x === undefined ? null : Number(x));
const num = (x: unknown) => Number(x ?? 0);

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

function week(w: any): WeekInfo {
  return { week: w.week, label: w.label, startsAt: w.starts_at, endsAt: w.ends_at, status: w.status, ruleSetVersion: w.rule_set_version };
}

function leg(l: any, teams: Map<string, Team>): LegView {
  const g = l.games;
  return {
    legNo: l.leg_no, gameId: l.game_id, market: l.market, side: l.side, point: n(l.point), price: l.price,
    teasedPoint: n(l.teased_point), book: l.book, result: l.result,
    game: {
      home: teams.get(g.home_team)!, away: teams.get(g.away_team)!, kickoffAt: g.kickoff_at, status: g.status,
      homeScore: g.home_score, awayScore: g.away_score,
    },
  };
}

export class SupabaseApi implements Api {
  readonly demo = false;
  private db: SupabaseClient;
  private teamCache: Promise<Team[]> | null = null;

  constructor(url: string, anonKey: string) {
    this.db = createClient(url, anonKey, { auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true } });
  }

  async getSession() {
    const { data } = await this.db.auth.getSession();
    return data.session ? { userId: data.session.user.id } : null;
  }
  onAuthChange(cb: () => void) {
    const { data } = this.db.auth.onAuthStateChange(() => cb());
    return () => data.subscription.unsubscribe();
  }
  async sendCode(email: string) {
    const { error } = await this.db.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
    if (error) throw new Error(error.message.includes("Signups not allowed") ? "That email isn't on the league list. Ask the commissioner to add you." : error.message);
  }
  async verifyCode(email: string, code: string) {
    const { error } = await this.db.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    if (error) throw new Error("That code didn't work. Check it, or send a new one.");
  }
  async signInWithGoogle() {
    const { error } = await this.db.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin + window.location.pathname } });
    if (error) throw new Error(error.message);
  }
  async signOut() {
    await this.db.auth.signOut();
  }
  async me(): Promise<Me> {
    const s = await this.getSession();
    if (!s) throw new Error("not signed in");
    const p = check(await this.db.from("profiles").select("id, display_name, is_admin").eq("id", s.userId).single()) as any;
    return { id: p.id, displayName: p.display_name, isAdmin: p.is_admin };
  }

  async league(): Promise<League> {
    const [settings, open, pull, credits] = await Promise.all([
      this.db.from("league_settings").select("*").single(),
      this.db.from("weeks").select("*").eq("status", "open").maybeSingle(),
      this.db.from("line_pulls").select("at").eq("kind", "lines").eq("ok", true).order("at", { ascending: false }).limit(1).maybeSingle(),
      this.db.from("line_pulls").select("credits_remaining").not("credits_remaining", "is", null).order("at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const s = check(settings);
    return {
      name: s.league_name,
      openWeek: open.data ? week(open.data) : null,
      timezone: s.timezone,
      pullWindowStart: String(s.pull_window_start).slice(0, 5),
      pullWindowEnd: String(s.pull_window_end).slice(0, 5),
      pullEveryMinutes: s.pull_every_minutes,
      books: s.books,
      lastPullAt: pull.data?.at ?? null,
      creditsRemaining: credits.data?.credits_remaining ?? null,
    };
  }

  teams(): Promise<Team[]> {
    this.teamCache ??= (async () => {
      const rows = check(await this.db.from("teams").select("*")) as any[];
      return rows.map((t) => ({ abbr: t.abbr, name: t.name, shortName: t.short_name }));
    })();
    return this.teamCache;
  }

  async standings(range?: { from?: string; to?: string }): Promise<StandingRow[]> {
    const rows = check(await this.db.rpc("standings", { p_from: range?.from ?? null, p_to: range?.to ?? null }));
    return (rows as any[]).map((r) => ({
      entryId: r.entry_id, name: r.name, isMine: r.is_mine, bankCents: num(r.bank_cents), seasonNetCents: num(r.season_net_cents),
      seasonWinningsCents: num(r.season_winnings_cents), wins: r.wins, losses: r.losses, pushes: r.pushes, riskCents: num(r.risk_cents),
      returnCents: num(r.return_cents), netCents: num(r.net_cents), winningsCents: num(r.winnings_cents), atRiskCents: num(r.at_risk_cents),
      week: r.week, requiredCents: n(r.required_cents), wageredCents: num(r.wagered_cents),
    }));
  }

  async games(weekNo: number): Promise<GameView[]> {
    const [teams, gamesRes] = await Promise.all([this.teams(), this.db.from("games").select("*").eq("week", weekNo).order("kickoff_at")]);
    const games = check(gamesRes) as any[];
    const byAbbr = new Map(teams.map((t) => [t.abbr, t]));
    const lines = games.length
      ? (check(await this.db.from("current_lines").select("*").in("game_id", games.map((g) => g.id))) as any[])
      : [];
    return games.map((g) => ({
      id: g.id, week: g.week, kickoffAt: g.kickoff_at, home: byAbbr.get(g.home_team)!, away: byAbbr.get(g.away_team)!,
      status: g.status, homeScore: g.home_score, awayScore: g.away_score,
      lines: lines.filter((l) => l.game_id === g.id).map((l) => ({
        market: l.market, side: l.side, point: n(l.point), price: l.price, source: l.source, asOf: l.as_of,
      })),
    }));
  }

  async myEntries(): Promise<MyEntry[]> {
    const rows = check(await this.db.rpc("my_entries")) as any[];
    return rows.map((r) => ({
      entryId: r.entry_id, name: r.name, availableCents: num(r.available_cents), pendingCents: num(r.pending_cents),
      bankCents: num(r.bank_cents), week: r.week, requiredCents: n(r.required_cents), wageredCents: num(r.wagered_cents),
    }));
  }

  async slips(q: { entryId?: string; mine?: boolean; week?: number; settled?: boolean; limit?: number }): Promise<SlipView[]> {
    let query = this.db
      .from("slips")
      .select("*, entries(name), profiles!slips_placed_by_fkey(display_name), slip_legs(*, games(home_team, away_team, kickoff_at, status, home_score, away_score))")
      .neq("status", "undone")
      .order("placed_at", { ascending: false })
      .limit(q.limit ?? 200);
    if (q.entryId) query = query.eq("entry_id", q.entryId);
    if (q.week !== undefined) query = query.eq("week", q.week);
    if (q.settled === true) query = query.neq("status", "pending");
    if (q.settled === false) query = query.eq("status", "pending");
    if (q.mine) {
      const ids = (await this.myEntries()).map((e) => e.entryId);
      if (!ids.length) return [];
      query = query.in("entry_id", ids);
    }
    const [rows, teams] = [check(await query) as any[], new Map((await this.teams()).map((t) => [t.abbr, t]))];
    return rows.map((s) => ({
      id: s.id, entryId: s.entry_id, entryName: s.entries?.name ?? "", placedByName: s.profiles?.display_name ?? null,
      week: s.week, type: s.type, teaserPoints: n(s.teaser_points), stakeCents: num(s.stake_cents), quotedAmerican: s.quoted_american,
      potentialPayoutCents: num(s.potential_payout_cents), legCount: s.leg_count, ruleSetVersion: s.rule_set_version, status: s.status,
      payoutCents: n(s.payout_cents), placedAt: s.placed_at, settledAt: s.settled_at,
      legs: (s.slip_legs ?? []).map((l: any) => leg(l, teams)).sort((a: LegView, b: LegView) => a.legNo - b.legNo),
    }));
  }

  async hiddenActivity(): Promise<HiddenPick[]> {
    const rows = check(await this.db.rpc("hidden_activity", { p_limit: 100 })) as any[];
    return rows.map((r) => ({ entryId: r.entry_id, name: r.name, placedAt: r.placed_at }));
  }

  async ruleVersions(): Promise<RuleVersion[]> {
    const rows = check(await this.db.from("rule_sets").select("*").order("version", { ascending: false })) as any[];
    return rows.map((r) => ({ version: r.version, effectiveWeek: r.effective_week, document: r.document, note: r.note, createdAt: r.created_at }));
  }

  async weeks(): Promise<WeekInfo[]> {
    return (check(await this.db.from("weeks").select("*").order("week")) as any[]).map(week);
  }

  async entrants(): Promise<Entrant[]> {
    const rows = check(await this.db.from("entries").select("id, name, status, entry_managers(profiles(display_name))").order("name")) as any[];
    return rows.map((e) => ({
      entryId: e.id, name: e.name, status: e.status,
      managers: (e.entry_managers ?? []).map((m: any) => m.profiles?.display_name).filter(Boolean),
    }));
  }

  async auditLog(limit = 200): Promise<AuditRow[]> {
    const rows = check(await this.db.from("audit_log").select("*, profiles(display_name)").order("id", { ascending: false }).limit(limit)) as any[];
    return rows.map((r) => ({
      id: r.id, actorName: r.profiles?.display_name ?? null, action: r.action, targetType: r.target_type, targetId: r.target_id,
      before: r.before, after: r.after, reason: r.reason, createdAt: r.created_at,
    }));
  }

  async placeSlip(req: PlacementRequest): Promise<PlaceResult> {
    const { data, error } = await this.db.functions.invoke("place-slip", { body: req as unknown as Record<string, unknown> });
    if (!error) return { ok: true, slipId: data.slipId, payoutCents: data.payoutCents, american: data.american };
    let body: any = null;
    if (error instanceof FunctionsHttpError) body = await error.context.json().catch(() => null);
    if (body?.error === "line_moved" && Array.isArray(body.lines)) return { ok: false, kind: "moved", message: body.message, lines: body.lines };
    if (body?.error === "invalid") return { ok: false, kind: "invalid", problems: body.problems ?? [] };
    return { ok: false, kind: "error", message: body?.message ?? "Couldn't place the bet. Try again." };
  }

  async undoSlip(slipId: string) {
    check(await this.db.rpc("undo_slip", { p_slip: slipId }));
  }
  async setDisplayName(name: string) {
    check(await this.db.rpc("set_display_name", { p_name: name }));
  }

  async adminUsers(): Promise<AdminUser[]> {
    const rows = check(await this.db.rpc("admin_list_users")) as any[];
    return rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, isAdmin: r.is_admin, entryNames: r.entry_names ?? [] }));
  }
  private async invoke(name: string, body: Record<string, unknown>) {
    const { data, error } = await this.db.functions.invoke(name, { body });
    if (error) {
      const b = error instanceof FunctionsHttpError ? await error.context.json().catch(() => null) : null;
      throw new Error(b?.message ?? b?.error ?? error.message);
    }
    return data;
  }
  async adminAddMember(email: string, displayName: string, entryId: string | null) {
    await this.invoke("add-member", { email, displayName, entryId });
  }
  async adminAddEntry(name: string, startingBankCents: number) {
    return check(await this.db.rpc("admin_add_entry", { p_name: name, p_starting_bank_cents: startingBankCents })) as string;
  }
  async adminSetManager(entryId: string, userId: string, add: boolean) {
    check(await this.db.rpc("admin_set_manager", { p_entry: entryId, p_user: userId, p_add: add }));
  }
  async adminImportSplash(a: SplashImport) {
    check(await this.db.rpc("admin_import_splash", {
      p_entry: a.entryId, p_bank_cents: a.bankCents, p_net_cents: a.netCents, p_wins: a.wins, p_losses: a.losses, p_pushes: a.pushes,
      p_risk_cents: a.riskCents, p_return_cents: a.returnCents, p_winnings_cents: a.winningsCents, p_note: a.note,
    }));
  }
  async adminAdjustBank(entryId: string, amountCents: number, reason: string) {
    check(await this.db.rpc("admin_adjust_bank", { p_entry: entryId, p_amount_cents: amountCents, p_reason: reason }));
  }
  async adminOpenNextWeek(reason: string) {
    return check(await this.db.rpc("admin_open_next_week", { p_reason: reason || null })) as number;
  }
  async adminSetLine(gameId: string, market: string, a: { point: number | null; price: number }, b: { point: number | null; price: number }, offered: boolean, reason: string) {
    check(await this.db.rpc("admin_set_line", {
      p_game: gameId, p_market: market, p_point_a: a.point, p_price_a: a.price, p_point_b: b.point, p_price_b: b.price, p_offered: offered, p_reason: reason,
    }));
  }
  async adminClearLine(gameId: string, market: string, reason: string) {
    check(await this.db.rpc("admin_clear_line", { p_game: gameId, p_market: market, p_reason: reason }));
  }
  async adminSetGameStatus(gameId: string, status: string, kickoffAt: string | null, reason: string) {
    check(await this.db.rpc("admin_set_game_status", { p_game: gameId, p_status: status, p_kickoff_at: kickoffAt, p_reason: reason }));
  }
  async adminSetFinalScore(gameId: string, home: number, away: number, reason: string) {
    check(await this.db.rpc("admin_set_final_score", { p_game: gameId, p_home: home, p_away: away, p_reason: reason }));
  }
  async adminVoidSlip(slipId: string, reason: string) {
    check(await this.db.rpc("admin_void_slip", { p_slip: slipId, p_reason: reason }));
  }
  async adminRunJob(job: "pull-lines" | "pull-scores") {
    return JSON.stringify(await this.invoke(job, { trigger: "admin" }));
  }
  async adminPublishRules(document: RuleSet, effectiveWeek: number, note: string) {
    return (await this.invoke("publish-rules", { document, effectiveWeek, note })).version as number;
  }
}
