// Pulls scores while games are on, grades every bet that can be graded, and opens
// the next week once the current one is done. Called by pg_cron every 10 minutes
// (with the cron secret) or by an admin from the site.
import { currentUser, env, isAdmin, serviceClient, siteOrigins } from "../_shared/env.ts";
import { json, preflight, safeEqual } from "../_shared/http.ts";
import { runScores } from "../_shared/jobs.ts";
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
    const result = await runScores(new SupabaseStore(serviceClient()), env("ODDS_API_KEY"), fetch, fromCron ? "schedule" : "admin");
    return json(req, origins, 200, result);
  } catch (e) {
    console.error("pull-scores failed", e);
    return json(req, origins, 500, { error: "grading_failed" });
  }
});
