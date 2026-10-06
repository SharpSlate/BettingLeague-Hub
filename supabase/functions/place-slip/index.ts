// Places a bet slip for the signed-in member.
//
// 1. If this is a retry of a bet already placed (same client ref), returns that bet.
// 2. Checks the slip with the shared rules code, and the entry, week and games (and that
//    it doesn't take the other side of a game from one of the entry's bets), before
//    anything costs credits: a slip that fails here never pulls lines.
// 3. Refreshes the lines if the last good pull is more than 2 minutes old. Bets share
//    one refresh at a time, so they can't run the Odds API credits down.
// 4. Checks each leg against the current lines. If a number moved, answers 409 with
//    the new numbers for the member to accept.
// 5. Hands it to place_slip_internal, which re-checks the invariants and records it.
//
// It also undoes bets ({action: "undo", slipIds}). Undo is refused once one of a bet's
// lines has moved, checked against lines pulled after the undo was asked for: one pull
// covers every bet in the request. Members can't undo through the database directly, so
// they can't undo against lines the site hasn't pulled for them.
import { currentUser, env, serviceClient, siteOrigins } from "../_shared/env.ts";
import { dbErrorCode, friendlyMessage, json, preflight } from "../_shared/http.ts";
import { pullLines, refreshForUndo } from "../_shared/jobs.ts";
import { checkPlacement, type CurrentLine, type GameInfo, type PlacementInput } from "../_shared/placement.ts";
import { isProp, PROP_MARKETS, propsClosed } from "../_shared/rules/props.ts";
import type { BetType, Leg, RuleSet } from "../_shared/rules/types.ts";
import { isStale } from "../_shared/schedule.ts";
import { SupabaseStore } from "../_shared/supabase-store.ts";
import { undoSlips } from "../_shared/undo.ts";

const TYPES: BetType[] = ["straight", "parlay", "teaser"];
const MARKETS: string[] = ["spread", "total", "moneyline", ...PROP_MARKETS];
const SIDES = ["home", "away", "over", "under", "yes"];
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
    // A player prop names its player; the game's own markets don't.
    const prop = isProp(l.market as string);
    if (prop ? !(typeof l.player === "string" && l.player.length >= 1 && l.player.length <= 80) : l.player != null) return null;
    legs.push({
      gameId: l.gameId, market: l.market as Leg["market"], side: l.side as Leg["side"], point: l.point as number | null, price: l.price,
      ...(prop ? { player: l.player as string } : {}),
    });
  }
  const teaserPoints = typeof b.teaserPoints === "number" ? b.teaserPoints : null;
  if (b.clientRef !== undefined && b.clientRef !== null && !(typeof b.clientRef === "string" && UUID.test(b.clientRef))) return null;
  const clientRef = typeof b.clientRef === "string" ? b.clientRef.toLowerCase() : null;
  return { entryId: b.entryId, type: b.type as BetType, teaserPoints, stakeCents: b.stakeCents as number, legs, clientRef };
}

/** Undoes bets after pulling fresh lines, since undo checks their lines haven't moved. */
async function undo(req: Request, origins: string, userId: string, raw: unknown): Promise<Response> {
  const ids = Array.isArray(raw) ? [...new Set(raw.map((x) => (typeof x === "string" ? x.toLowerCase() : "")))] : [];
  // The site sends at most 100 at a time.
  if (!ids.length || ids.length > 100 || !ids.every((id) => UUID.test(id))) {
    return json(req, origins, 400, { error: "bad_request", message: "Those bets couldn't be read." });
  }
  const db = serviceClient();
  try {
    const results = await undoSlips((fn, args) => db.rpc(fn, args), userId, ids,
      (since) => refreshForUndo(new SupabaseStore(db), env("ODDS_API_KEY"), fetch, userId, since));
    return json(req, origins, 200, { results });
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
    return undo(req, origins, user.id, (body as Record<string, unknown>).slipIds);
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
        const priorLegs = (await db.from("slip_legs").select("game_id, market, side, player").eq("slip_id", prior.id)).data ?? [];
        const have = new Set(priorLegs.map((l: any) => `${l.game_id}|${l.market}|${l.side}|${l.player ?? ""}`));
        const want = new Set(input.legs.map((l) => `${l.gameId.toLowerCase()}|${l.market}|${l.side}|${l.player ?? ""}`));
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

    // The open week of the entry's league (each league opens its weeks on its own).
    const week = ((await db.rpc("open_week_for_entry_internal", { p_entry: input.entryId })).data ?? [])[0] as
      { week: number; rule_set_version: number } | undefined;
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
    const hasProps = input.legs.some((l) => isProp(l.market));
    const hasGameLines = input.legs.some((l) => !isProp(l.market));
    const loadLines = async (): Promise<CurrentLine[]> => {
      const out: CurrentLine[] = [];
      if (hasGameLines) {
        const r = await db.from("current_lines").select("game_id, market, side, point, price, source").in("game_id", gameIds);
        if (r.error) throw new Error(`lines: ${r.error.message}`);
        for (const l of r.data ?? []) {
          out.push({ gameId: l.game_id, market: l.market, side: l.side, point: l.point === null ? null : Number(l.point), price: l.price, source: l.source, player: null });
        }
      }
      if (hasProps) {
        const players = [...new Set(input.legs.filter((l) => isProp(l.market)).map((l) => l.player!))];
        const r = await db.from("current_props").select("game_id, market, player, side, point, price, source")
          .in("game_id", gameIds).in("player", players);
        if (r.error) throw new Error(`props: ${r.error.message}`);
        for (const l of r.data ?? []) {
          out.push({ gameId: l.game_id, market: l.market, side: l.side, point: l.point === null ? null : Number(l.point), price: l.price, source: l.source, player: l.player });
        }
      }
      return out;
    };
    const ctx = { availableCents: Number(bal.available_cents), bankCents: Number(bal.bank_cents) };
    // How fresh the props are: when the latest import was pulled at the books.
    let props = { pulledAt: null as Date | null, maxAgeMinutes: 0 };
    if (hasProps) {
      const last = (await db.from("prop_imports").select("pulled_at").eq("ok", true).order("at", { ascending: false }).limit(1).maybeSingle()).data;
      const age = (await db.from("league_settings").select("prop_max_age_minutes").single()).data;
      props = { pulledAt: last ? new Date(last.pulled_at) : null, maxAgeMinutes: Number(age?.prop_max_age_minutes ?? 0) };
    }

    // Within 90 minutes of a game's kickoff its inactive players are out, and its props can
    // only be bet on lines pulled after that (place_slip_internal checks the same).
    if (hasProps) {
      const now = new Date();
      const waiting = input.legs.flatMap((l, i) => {
        const g = games.get(l.gameId.toLowerCase()) ?? games.get(l.gameId);
        return isProp(l.market) && g && propsClosed(g.locksAt, props.pulledAt, now, props.maxAgeMinutes) === "inactives" ? [i] : [];
      });
      if (waiting.length) {
        return json(req, origins, 422, { error: "invalid", problems: waiting.map((leg) => ({ code: "props_inactives", message: friendlyMessage("props_inactives"), leg })) });
      }
    }

    let lines = await loadLines();
    let check = checkPlacement(input, rules, ctx, week.week, games, lines, new Date(), props);
    // A slip that breaks a rule or is on a game that has started fails without a pull.
    if (!check.ok && check.kind === "invalid" && check.problems.some((p) => p.code !== "line_unavailable")) {
      return json(req, origins, 422, { error: "invalid", problems: check.problems });
    }
    // So does one on the other side of a game from one of the entry's bets.
    const acrossCheck = await db.rpc("opposite_side_legs_internal", { p_entry: input.entryId, p_user: user.id, p_legs: input.legs });
    if (acrossCheck.error) throw new Error(`opposite sides: ${acrossCheck.error.message}`);
    const across = acrossCheck.data as number[] | null;
    if (across?.length) {
      return json(req, origins, 422, { error: "invalid", problems: across.map((leg) => ({ code: "opposite_side", message: friendlyMessage("opposite_side"), leg })) });
    }
    const settings = await store.settings();
    const before = await store.lastGoodLinesPull();
    // Props come from the owner's own pulls, so a slip of props alone never pulls lines.
    if (hasGameLines && isStale(before, new Date(), settings.refreshOnBetSeconds)) {
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
      check = checkPlacement(input, rules, ctx, week.week, games, lines, new Date(), props);
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
