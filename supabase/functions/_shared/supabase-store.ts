// The jobs' Store, backed by Supabase with the service role (bypasses RLS).
// Typed structurally so it doesn't import supabase-js itself.
import type { GameResult, PendingSlip, Settlement } from "./grading.ts";
import type { Settings, Store, Trigger } from "./jobs.ts";
import type { NormalizedEvent, NormalizedScore } from "./odds-api.ts";
import type { RuleSet } from "./rules/types.ts";

// deno-lint-ignore no-explicit-any
type Query = any;
export interface SupabaseLike {
  from(table: string): Query;
  rpc(fn: string, args?: Record<string, unknown>): Query;
}

async function must<T>(q: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

export class SupabaseStore implements Store {
  constructor(private db: SupabaseLike) {}

  async settings(): Promise<Settings> {
    const s = await must<Record<string, any>>(this.db.from("league_settings").select("*").single(), "settings");
    return {
      timezone: s.timezone,
      pullWindowStart: String(s.pull_window_start).slice(0, 5),
      pullWindowEnd: String(s.pull_window_end).slice(0, 5),
      refreshOnBetSeconds: s.refresh_on_bet_seconds,
      maxLineAgeMinutes: s.max_line_age_minutes,
      creditFloor: s.credit_floor,
      books: s.books,
    };
  }

  async lastCredits() {
    const row = await must<{ credits_remaining: number; at: string } | null>(
      this.db.from("line_pulls").select("credits_remaining, at").not("credits_remaining", "is", null)
        .order("at", { ascending: false }).limit(1).maybeSingle(),
      "last credits",
    );
    return row ? { remaining: row.credits_remaining, at: new Date(row.at) } : null;
  }

  async lastGoodLinesPull() {
    const row = await must<{ at: string } | null>(
      this.db.from("line_pulls").select("at").eq("kind", "lines").eq("ok", true).order("at", { ascending: false }).limit(1).maybeSingle(),
      "last pull",
    );
    return row ? new Date(row.at) : null;
  }

  ingestLines(trigger: Trigger, events: NormalizedEvent[], cost: number | null, remaining: number | null) {
    return must<number>(
      this.db.rpc("ingest_lines_internal", { p_trigger: trigger, p_events: events, p_credits_used: cost, p_credits_remaining: remaining }),
      "ingest lines",
    );
  }

  ingestScores(trigger: Trigger, scores: NormalizedScore[], cost: number | null, remaining: number | null) {
    return must<number>(
      this.db.rpc("ingest_scores_internal", { p_trigger: trigger, p_scores: scores, p_credits_used: cost, p_credits_remaining: remaining }),
      "ingest scores",
    );
  }

  async recordPull(kind: "lines" | "scores", trigger: Trigger, ok: boolean, error: string, cost: number | null, remaining: number | null) {
    await must(
      this.db.rpc("record_pull_internal", {
        p_kind: kind, p_trigger: trigger, p_ok: ok, p_error: error, p_credits_used: cost, p_credits_remaining: remaining,
      }),
      "record pull",
    );
  }

  async claimBetRefresh(minSeconds: number, userId: string | null) {
    return (await must<boolean>(this.db.rpc("claim_bet_refresh_internal", { p_min_seconds: minSeconds, p_user: userId }), "claim refresh")) === true;
  }

  async gamesAwaitingScores(now: Date) {
    // A postponed game can still be played (and its bets still ride), so it keeps
    // pulling scores for 3 days from the feed's new start time.
    return Number(await must<number>(this.db.rpc("games_awaiting_scores_internal", { p_now: now.toISOString() }), "games awaiting scores"));
  }

  async pendingSlips(): Promise<PendingSlip[]> {
    const slips = await must<any[]>(
      this.db.from("slips")
        .select("id, type, stake_cents, teaser_points, rule_set_version, slip_legs(leg_no, game_id, market, side, point, price)")
        .eq("status", "pending"),
      "pending slips",
    );
    if (!slips.length) return [];
    const versions = [...new Set(slips.map((s) => s.rule_set_version))];
    const sets = await must<{ version: number; document: RuleSet }[]>(
      this.db.from("rule_sets").select("version, document").in("version", versions),
      "rule sets",
    );
    const byVersion = new Map(sets.map((r) => [r.version, r.document]));
    return slips.map((s) => ({
      id: s.id,
      type: s.type,
      stakeCents: Number(s.stake_cents),
      teaserPoints: s.teaser_points === null ? null : Number(s.teaser_points),
      rules: byVersion.get(s.rule_set_version)!,
      legs: [...s.slip_legs]
        .sort((a: any, b: any) => a.leg_no - b.leg_no)
        .map((l: any) => ({
          legNo: l.leg_no,
          gameId: l.game_id,
          market: l.market,
          side: l.side,
          point: l.point === null ? null : Number(l.point),
          price: l.price,
        })),
    }));
  }

  async games(ids: string[]) {
    const rows = await must<any[]>(this.db.from("games").select("id, status, home_score, away_score, updated_at").in("id", ids), "games");
    return new Map<string, GameResult>(
      rows.map((g) => [g.id, { id: g.id, status: g.status, homeScore: g.home_score, awayScore: g.away_score, version: String(g.updated_at) }]),
    );
  }

  settle(s: Settlement) {
    return must<boolean>(
      this.db.rpc("settle_slip_internal", {
        p_slip: s.slipId, p_result: s.result, p_payout_cents: s.payoutCents, p_leg_results: s.legResults, p_game_versions: s.gameVersions,
      }),
      "settle",
    );
  }

  advanceWeek() {
    return must<number | null>(this.db.rpc("advance_week_internal"), "advance week");
  }
}
