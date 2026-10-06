// Takes box scores from the site owner's PC: ESPN's game summaries for final games, read
// by the PC (ESPN has refused the site's own requests). Player props are graded from
// them. The sender presents the same key as for props (x-props-key); the database keeps
// only its SHA-256.
//
// Body: {source, summaries: [ESPN's summary of a game (site.api.espn.com/.../nfl/summary?event=),
// at least its header and boxscore]}. Only a game with props riding that's final here and
// on ESPN, and has no box score yet, takes one; anything else is skipped.
import { matchFeedBoxes } from "../_shared/box-feed.ts";
import { serviceClient } from "../_shared/env.ts";

const MAX_BYTES = 8_000_000;
const MAX_SUMMARIES = 40;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  const key = req.headers.get("x-props-key") ?? "";
  if (!key) return reply(401, { error: "bad_key" });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return reply(413, { error: "too_large" });
  const text = await req.text();
  if (text.length > MAX_BYTES) return reply(413, { error: "too_large" });
  let body: { summaries?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: "bad_request" });
  }
  if (!Array.isArray(body?.summaries) || body.summaries.length > MAX_SUMMARIES) return reply(400, { error: "bad_request" });

  const db = serviceClient();
  const ok = await db.rpc("prop_key_ok_internal", { p_key: key });
  if (ok.error) return reply(500, { error: "error" });
  if (ok.data !== true) return reply(401, { error: "bad_key" });

  const need = await db.rpc("games_needing_boxes_internal");
  if (need.error) return reply(500, { error: "error" });
  const waiting = ((need.data ?? []) as { game_id: string; kickoff_at: string; home_name: string; away_name: string }[])
    .map((r) => ({ gameId: r.game_id, kickoffAt: String(r.kickoff_at), homeName: r.home_name, awayName: r.away_name }));
  let stored = 0;
  const failed: string[] = [];
  for (const b of matchFeedBoxes(body.summaries, waiting)) {
    const r = await db.rpc("ingest_box_internal", { p_game: b.gameId, p_espn_id: b.espnId, p_players: b.players, p_source: "feed" });
    if (r.error) failed.push(b.espnId);
    else if (Number(r.data) > 0) stored++;
  }
  return reply(failed.length ? 500 : 200, { stored, waiting: waiting.length - stored, ...(failed.length ? { failed } : {}) });
});
