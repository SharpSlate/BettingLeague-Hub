// Small HTTP helpers shared by the Edge Functions.

/** CORS headers for the site's origin(s). allowed is a comma-separated list; "*" allows any. */
export function corsHeaders(req: Request, allowed: string): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const list = allowed.split(",").map((s) => s.trim()).filter(Boolean);
  const allow = list.includes("*") ? "*" : list.includes(origin) ? origin : list[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function json(req: Request, allowed: string, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req, allowed), "Content-Type": "application/json" },
  });
}

export function preflight(req: Request, allowed: string): Response | null {
  return req.method === "OPTIONS" ? new Response(null, { status: 204, headers: corsHeaders(req, allowed) }) : null;
}

/** Constant-time string comparison, for the cron secret. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Turns a database exception message into the code we raised (e.g. "line_moved"). */
export function dbErrorCode(message: string | undefined): string {
  const m = (message ?? "").trim();
  return /^[a-z_]+$/.test(m) ? m : "error";
}

const FRIENDLY: Record<string, string> = {
  entry_not_active: "That entry isn't active.",
  not_manager: "You don't manage that entry.",
  no_open_week: "Betting isn't open right now.",
  rules_changed: "The rules changed. Reload and try again.",
  bad_type: "Unknown bet type.",
  bad_teaser_points: "Pick one of the teaser point options.",
  type_disabled: "That bet type is turned off.",
  no_legs: "Add a pick to your slip.",
  bad_leg_count: "That's the wrong number of legs for this bet type.",
  stake_out_of_range: "That stake is outside the limits.",
  insufficient_units: "You don't have enough units available.",
  bad_quote: "Something's off with the payout. Reload and try again.",
  week_locked: "This week's betting has closed.",
  bad_market: "That market isn't allowed in this bet type.",
  unknown_game: "That game isn't on the board.",
  game_not_this_week: "That game isn't in this week's slate.",
  game_started: "One of those games has started.",
  line_unavailable: "A line is off the board right now.",
  lines_stale: "The lines couldn't be refreshed. Try again in a minute.",
  line_moved: "A line moved. Check the new number.",
  opposite_side: "You already have a bet on the other side of this game. An entry can't bet both teams in a game, or both the over and the under.",
  not_found: "That bet couldn't be found.",
  not_pending: "That bet isn't pending any more.",
  week_closed: "That bet's week has closed, so it can't be undone.",
  undo_window_passed: "The undo window has passed.",
  undo_line_moved: "A line on that bet has moved since you placed it, so it can't be undone.",
  undo_lines_stale: "The lines couldn't be pulled just now, and undo has to check them. Try again in a minute.",
  undo_refresh_limit: "Undo has to pull fresh lines to check them, and the daily limit on line refreshes has been reached. If the bet was a mistake, ask the commissioner.",
  undo_credit_floor: "Undo has to pull fresh lines to check them, and line pulls are paused because the league's odds-feed credits are nearly used up. If the bet was a mistake, ask the commissioner.",
  client_ref_conflict: "That bet couldn't be matched to your slip. Reload and try again.",
  client_ref_used: "That bet was undone or voided. Place it again as a new bet.",
};

export function friendlyMessage(code: string): string {
  return FRIENDLY[code] ?? "Something went wrong. Try again.";
}
