// Publishes a new version of a league's rules, effective from a future week.
// The league's commissioners only. The document is checked with the same rules code the site uses.
import { currentUser, isCommissioner, serviceClient, siteOrigins } from "../_shared/env.ts";
import { dbErrorCode, json, preflight } from "../_shared/http.ts";
import { validateRuleSet } from "../_shared/rules/ruleset.ts";
import type { RuleSet } from "../_shared/rules/types.ts";

Deno.serve(async (req) => {
  const origins = siteOrigins();
  const pre = preflight(req, origins);
  if (pre) return pre;
  if (req.method !== "POST") return json(req, origins, 405, { error: "method_not_allowed" });

  const user = await currentUser(req);
  const body = await req.json().catch(() => null);
  const leagueId = typeof body?.leagueId === "string" ? body.leagueId : "";
  if (!user || !leagueId || !(await isCommissioner(user.id, leagueId))) return json(req, origins, 403, { error: "commissioner_only" });
  const document = body?.document as RuleSet | undefined;
  const effectiveWeek = body?.effectiveWeek;
  if (!document || typeof document !== "object" || !Number.isInteger(effectiveWeek)) {
    return json(req, origins, 400, { error: "bad_request" });
  }
  let problems;
  try {
    problems = validateRuleSet(document);
  } catch {
    return json(req, origins, 422, { error: "invalid", problems: [{ code: "malformed", message: "The rules document is incomplete." }] });
  }
  if (problems.length) return json(req, origins, 422, { error: "invalid", problems });

  const { data, error } = await serviceClient().rpc("publish_rule_set_internal", {
    p_actor: user.id,
    p_league: leagueId,
    p_document: document,
    p_effective_week: effectiveWeek,
    p_note: typeof body.note === "string" ? body.note.slice(0, 500) : "",
  });
  if (error) return json(req, origins, 409, { error: dbErrorCode(error.message) });
  return json(req, origins, 200, { version: data });
});
