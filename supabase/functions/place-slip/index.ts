// Places a bet slip for the signed-in member.
//
// 1. Refreshes the lines first if the last good pull is more than 2 minutes old.
// 2. Checks the slip with the shared rules code and against the current lines.
//    If a number moved, answers 409 with the new numbers for the member to accept.
// 3. Hands it to place_slip_internal, which re-checks the invariants and records it.
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

function parse(body: unknown): PlacementInput | null {
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
  return { entryId: b.entryId, type: b.type as BetType, teaserPoints, stakeCents: b.stakeCents as number, legs };
}

Deno.serve(async (req) => {
  const origins = siteOrigins();
  const pre = preflight(req, origins);
  if (pre) return pre;
  if (req.method !== "POST") return json(req, origins, 405, { error: "method_not_allowed" });

  const user = await currentUser(req);
  if (!user) return json(req, origins, 401, { error: "sign_in_required", message: "Please sign in again." });
  const input = parse(await req.json().catch(() => null));
  if (!input) return json(req, origins, 400, { error: "bad_request", message: "That slip couldn't be read." });

  const db = serviceClient();
  const store = new SupabaseStore(db);
  try {
    const settings = await store.settings();
    if (isStale(await store.lastGoodLinesPull(), new Date(), settings.refreshOnBetSeconds)) {
      await pullLines(store, env("ODDS_API_KEY"), fetch, "bet");
    }

    const week = (await db.from("weeks").select("week, rule_set_version").eq("status", "open").maybeSingle()).data;
    if (!week) return json(req, origins, 409, { error: "no_open_week", message: friendlyMessage("no_open_week") });
    const rules = (await db.from("rule_sets").select("document").eq("version", week.rule_set_version).single()).data?.document as RuleSet;

    const bal = (await db.rpc("entry_balance_internal", { p_entry: input.entryId, p_user: user.id })).data?.[0];
    if (!bal?.manages || !bal.active) return json(req, origins, 403, { error: "not_manager", message: friendlyMessage("not_manager") });

    const gameIds = [...new Set(input.legs.map((l) => l.gameId))];
    const gameRows = (await db.from("games").select("id, kickoff_at, status, week").in("id", gameIds)).data ?? [];
    const games = new Map<string, GameInfo>(
      gameRows.map((g: any) => [g.id, { id: g.id, kickoffAt: new Date(g.kickoff_at), status: g.status, week: g.week }]),
    );
    const lineRows = (await db.from("current_lines").select("game_id, market, side, point, price, source").in("game_id", gameIds)).data ?? [];
    const lines: CurrentLine[] = lineRows.map((l: any) => ({
      gameId: l.game_id, market: l.market, side: l.side, point: l.point === null ? null : Number(l.point), price: l.price, source: l.source,
    }));

    const check = checkPlacement(
      input, rules, { availableCents: Number(bal.available_cents), bankCents: Number(bal.bank_cents) }, week.week, games, lines, new Date(),
    );
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
