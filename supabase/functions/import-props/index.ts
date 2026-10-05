// Takes player props from the site owner's own scheduled prop pulls (his "SharpSlate NFL
// Props" task sends them here after each pull), so props spend none of this site's Odds
// API credits. The sender presents a key in x-props-key; the database keeps only its
// SHA-256 and checks it (ingest_props_internal).
//
// Body: {pulledAt, source, quotes: [{eventId, market, player, side, point, price, book}]},
// with the Odds API's event ids and market keys. Only games still open for betting take
// new lines.
import { serviceClient } from "../_shared/env.ts";
import { dbErrorCode } from "../_shared/http.ts";

const MAX_BYTES = 8_000_000;
const MAX_QUOTES = 50_000;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  const key = req.headers.get("x-props-key") ?? "";
  if (!key) return reply(401, { error: "bad_key" });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return reply(413, { error: "too_large" });
  const text = await req.text();
  if (text.length > MAX_BYTES) return reply(413, { error: "too_large" });
  let body: { pulledAt?: unknown; source?: unknown; quotes?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: "bad_request" });
  }
  const pulledAt = typeof body?.pulledAt === "string" && Number.isFinite(Date.parse(body.pulledAt)) ? body.pulledAt : null;
  if (!pulledAt || !Array.isArray(body.quotes) || body.quotes.length > MAX_QUOTES) return reply(400, { error: "bad_request" });
  const source = typeof body.source === "string" ? body.source.slice(0, 80) : "";

  const db = serviceClient();
  const { data, error } = await db.rpc("ingest_props_internal", { p_key: key, p_pulled_at: pulledAt, p_source: source, p_quotes: body.quotes });
  if (error) {
    const code = dbErrorCode(error.message);
    if (code === "bad_key") return reply(401, { error: code });
    // A resend of an older pull isn't a problem worth showing the admins.
    if (code !== "older_than_latest") {
      await db.rpc("record_prop_import_failure_internal", { p_pulled_at: pulledAt, p_source: source, p_error: code === "error" ? error.message : code });
    }
    return reply(code === "error" ? 500 : 409, { error: code });
  }
  return reply(200, data);
});
