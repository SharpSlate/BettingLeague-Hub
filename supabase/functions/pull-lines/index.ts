// Pulls lines from The Odds API. Called by pg_cron every 30 minutes (with the cron
// secret; skipped outside 8am-1am Eastern) or by an admin from the site.
import { currentUser, env, isAdmin, serviceClient, siteOrigins } from "../_shared/env.ts";
import { json, preflight, safeEqual } from "../_shared/http.ts";
import { pullLines } from "../_shared/jobs.ts";
import { SupabaseStore } from "../_shared/supabase-store.ts";

Deno.serve(async (req) => {
  const origins = siteOrigins();
  const pre = preflight(req, origins);
  if (pre) return pre;

  const fromCron = safeEqual(req.headers.get("x-cron-secret") ?? "", env("CRON_SECRET"));
  if (!fromCron) {
    const user = await currentUser(req);
    if (!user || !(await isAdmin(user.id))) return json(req, origins, 403, { error: "admin_only" });
  }
  try {
    const result = await pullLines(new SupabaseStore(serviceClient()), env("ODDS_API_KEY"), fetch, fromCron ? "schedule" : "admin");
    return json(req, origins, 200, result);
  } catch (e) {
    console.error("pull-lines failed", e);
    return json(req, origins, 500, { error: "pull_failed" });
  }
});
