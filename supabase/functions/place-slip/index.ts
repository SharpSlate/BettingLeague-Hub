// Places a bet slip for the signed-in member.
//
// 1. If this is a retry of a bet already placed (same client ref), returns that bet.
// 2. Checks the slip with the shared rules code, and the entry, week and games,
//    before anything costs credits: a slip that fails here never pulls lines.
// 3. Refreshes the lines if the last good pull is more than 2 minutes old. Bets share
//    one refresh at a time, so they can't run the Odds API credits down.
// 4. Checks each leg against the current lines. If a number moved, answers 409 with
//    the new numbers for the member to accept.
// 5. Hands it to place_slip_internal, which re-checks the invariants and records it.
//
// It also undoes bets ({action: "undo", slipId}). Undo is refused once one of the bet's
// lines has moved, so the lines are refreshed first, the same way; members can't undo
// through the database directly, so they can't undo against lines the site hasn't seen.
import { currentUser, env, serviceClient, siteOrigins } from "../_shared/env.ts";
import { dbErrorCode, friendlyMessage, json, preflight } from "../_shared/http.ts";
import { pullLines } from "../_shared/jobs.ts";
import { checkPlacement, type CurrentLine, type GameInfo, type PlacementInput } from "../_shared/placement.ts";
import type { BetType, Leg, RuleSet } from "../_shared/rules/types.ts";
import { isStale } from "../_shared/schedule.ts";
import { SupabaseStore } from "../_shared/supabase-store.ts";

const TYPES: BetType[] = ["straight", "parlay", "teaser"];
const MARKETS = ["spread", "total", "moneyline"];
const SIDES = ["home", "away", "over", "under"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse(body: unknown): (PlacementInput & { clientRef: string | null }) | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.entryId !== "string" || !TYPES.includes(b.type as BetType)) return null;
  if (!Number.isSafeInteger(b.stakeCents)) return null;
  if (!Array.isArray(b.legs) || b.legs.length === 0 || b.legs.length > 20) return null;
  const legs: Leg[] = [];
  for (const l of b.legs as Record<string, unknown>[]) {
    if (typeof l?.gameId !== "string" || !MARKETS.includes(l.market as string) || !SIDES.includes(l.side as string)) return null;
    if (!(l.point === null || typeof l.point === "number") || typeof l.price !== "number") return null;
    legs.push({ gameId: l.gameId, market: l.market as Leg["market"], side: l.side as Leg["side"], point: l.point as number | null, price: l.price });
  }
  const teaserPoints = typeof b.teaserPoints === "number" ? b.teaserPoints : null;
  if (b.clientRef !== undefined && b.clientRef !== null && !(typeof b.clientRef === "string" && UUID.test(b.clientRef))) return null;
  const clientRef = typeof b.clientRef === "string" ? b.clientRef.toLowerCase() : null;
  return { entryId: b.entryId, type: b.type as BetType, teaserPoints, stakeCents: b.stakeCents as number, legs, clientRef };
}

/** Undoes a bet after bringing the lines up to date, since undo checks they haven't moved. */
async function undo(req: Request, origins: string, userId: string, slipId: unknown): Promise<Response> {
  if (typeof slipId !== "string" || !UUID.test(slipId)) return json(req, origins, 400, { error: "bad_request", message: "That bet couldn't be read." });
  const db = serviceClient();
  const store = new SupabaseStore(db);
  try {
    const settings = await store.settings();
    const before = await store.lastGoodLinesPull();
    if (isStale(before, new Date(), settings.refreshOnBetSeconds)) {
      const pulled = await pullLines(store, env("ODDS_API_KEY"), fetch, "bet", new Date(), userId);
      // Another bet's refresh is on its way: wait a moment for it.
      if (pulled.status === "skipped" && pulled.reason === "recent") {
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const latest = await store.lastGoodLinesPull();
          if (latest && (!before || latest > before)) break;
        }
      }
    }
    const { error } = await db.rpc("undo_slip_internal", { p_slip: slipId.toLowerCase(), p_user: userId });
    if (error) {
      const code = dbErrorCode(error.message);
      return json(req, origins, 409, { error: code, message: friendlyMessage(code) });
    }
    return json(req, origins, 200, { undone: true });
  } catch (e) {
    console.error("undo failed", e);
    return json(req, origins, 500, { error: "error", message: friendlyMessage("error") });
  }
}

Deno.serve(async (req) => {
  const origins = siteOrigins();
  const pre = preflight(req, origins);
  if (pre) return pre;
  if (req.method !== "POST") return json(req, origins, 405, { error: "method_not_allowed" });

  const user = await currentUser(req);
  if (!user) return json(req, origins, 401, { error: "sign_in_required", message: "Please sign in again." });
  const body = await req.json().catch(() => null);
  if (body && typeof body === "object" && (body as Record<string, unknown>).action === "undo") {
    return undo(req, origins, user.id, (body as Record<string, unknown>).slipId);
  }
  const input = parse(body);
  if (!input) return json(req, origins, 400, { error: "bad_request", message: "That slip couldn't be read." });

  const db = serviceClient();
  const store = new SupabaseStore(db);
  try {
    if (input.clientRef) {
      const prior = (await db.from("slips").select("id, entry_id, placed_by, type, teaser_points, stake_cents, leg_count, status, quoted_american, potential_payout_cents")
        .eq("client_ref", input.clientRef).maybeSingle()).data;
      if (prior) {
        // A retry of the same bet gets the bet back. The same ref on a different bet, or on
        // one that's since been undone or voided, isn't a retry. (place_slip_internal
        // checks the same things.)
        const priorLegs = (await db.from("slip_legs").select("game_id, market, side").eq("slip_id", prior.id)).data ?? [];
        const have = new Set(priorLegs.map((l: any) => `${l.game_id}|${l.market}|${l.side}`));
        const want = new Set(input.legs.map((l) => `${l.gameId.toLowerCase()}|${l.market}|${l.side}`));
        const same = prior.entry_id === input.entryId.toLowerCase() && prior.placed_by === user.id && prior.type === input.type
          && (prior.teaser_points === null ? null : Number(prior.teaser_points)) === (input.type === "teaser" ? input.teaserPoints : null)
          && Number(prior.stake_cents) === input.stakeCents && prior.leg_count === input.legs.length
          && want.size === have.size && [...want].every((k) => have.has(k));
        if (!same) return json(req, origins, 409, { error: "client_ref_conflict", message: friendlyMessage("client_ref_conflict") });
        if (prior.status === "undone" || prior.status === "void") {
          return json(req, origins, 409, { error: "client_ref_used", message: friendlyMessage("client_ref_used") });
        }
        return json(req, origins, 200, { slipId: prior.id, american: Number(prior.quoted_american), payoutCents: Number(prior.potential_payout_cents) });
      }
    }

    const week = (await db.from("weeks").select("week, rule_set_version").eq("status", "open").maybeSingle()).data;
    if (!week) return json(req, origins, 409, { error: "no_open_week", message: friendlyMessage("no_open_week") });
    const rules = (await db.from("rule_sets").select("document").eq("version", week.rule_set_version).single()).data?.document as RuleSet;

    const bal = (await db.rpc("entry_balance_internal", { p_entry: input.entryId, p_user: user.id })).data?.[0];
    if (!bal?.manages || !bal.active) return json(req, origins, 403, { error: "not_manager", message: friendlyMessage("not_manager") });

    const gameIds = [...new Set(input.legs.map((l) => l.gameId))];
    const gameRows = (await db.from("games").select("id, kickoff_at, feed_commence, status, week").in("id", gameIds)).data ?? [];
    // Betting on a game closes at its kickoff or at the feed's own start time, whichever
    // comes first (as place_slip_internal checks).
    const locksAt = (g: any) => new Date(Math.min(Date.parse(g.kickoff_at), g.feed_commence ? Date.parse(g.feed_commence) : Infinity));
    const games = new Map<string, GameInfo>(
      gameRows.map((g: any) => [g.id, { id: g.id, locksAt: locksAt(g), status: g.status, week: g.week }]),
    );
    const loadLines = async (): Promise<CurrentLine[]> =>
      ((await db.from("current_lines").select("game_id, market, side, point, price, source").in("game_id", gameIds)).data ?? []).map((l: any) => ({
        gameId: l.game_id, market: l.market, side: l.side, point: l.point === null ? null : Number(l.point), price: l.price, source: l.source,
      }));
    const ctx = { availableCents: Number(bal.available_cents), bankCents: Number(bal.bank_cents) };

    let lines = await loadLines();
    let check = checkPlacement(input, rules, ctx, week.week, games, lines, new Date());
    // A slip that breaks a rule or is on a game that has started fails without a pull.
    if (!check.ok && check.kind === "invalid" && check.problems.some((p) => p.code !== "line_unavailable")) {
      return json(req, origins, 422, { error: "invalid", problems: check.problems });
    }
    const settings = await store.settings();
    const before = await store.lastGoodLinesPull();
    if (isStale(before, new Date(), settings.refreshOnBetSeconds)) {
      const pulled = await pullLines(store, env("ODDS_API_KEY"), fetch, "bet", new Date(), user.id);
      // Too stale to bet on and another bet's refresh is on its way: wait a moment for it
      // rather than refusing this bet as stale. (No wait when a limit stopped the refresh.)
      if (pulled.status === "skipped" && pulled.reason === "recent" && isStale(before, new Date(), settings.maxLineAgeMinutes * 60)) {
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const latest = await store.lastGoodLinesPull();
          if (latest && (!before || latest > before)) break;
        }
      }
      lines = await loadLines();
      check = checkPlacement(input, rules, ctx, week.week, games, lines, new Date());
    }
    if (!check.ok) {
      return check.kind === "moved"
        ? json(req, origins, 409, { error: "line_moved", message: friendlyMessage("line_moved"), lines: check.lines })
        : json(req, origins, 422, { error: "invalid", problems: check.problems });
    }

    const { data: slipId, error } = await db.rpc("place_slip_internal", {
      p_entry: input.entryId,
      p_user: user.id,
      p_type: input.type,
      p_teaser_points: input.type === "teaser" ? input.teaserPoints : null,
      p_stake_cents: input.stakeCents,
      p_quoted_american: check.quote.american,
      p_potential_payout_cents: check.quote.payoutCents,
      p_rule_set_version: week.rule_set_version,
      p_legs: input.legs,
      p_client_ref: input.clientRef,
    });
    if (error) {
      const code = dbErrorCode(error.message);
      return json(req, origins, 409, { error: code, message: friendlyMessage(code) });
    }
    return json(req, origins, 200, { slipId, american: check.quote.american, payoutCents: check.quote.payoutCents });
  } catch (e) {
    console.error("place-slip failed", e);
    return json(req, origins, 500, { error: "error", message: friendlyMessage("error") });
  }
});
