// Adds a league member by email (sign-ups are closed, so this is the only way in),
// optionally making them a manager of an entry. Admins only. The audit row never
// includes the email, because every member can read the audit log.
import { currentUser, isAdmin, serviceClient, siteOrigins, userClient } from "../_shared/env.ts";
import { dbErrorCode, json, preflight } from "../_shared/http.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  const origins = siteOrigins();
  const pre = preflight(req, origins);
  if (pre) return pre;
  if (req.method !== "POST") return json(req, origins, 405, { error: "method_not_allowed" });

  const admin = await currentUser(req);
  if (!admin || !(await isAdmin(admin.id))) return json(req, origins, 403, { error: "admin_only" });
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim().slice(0, 40) : "";
  const entryId = typeof body?.entryId === "string" ? body.entryId : null;
  if (!EMAIL.test(email)) return json(req, origins, 400, { error: "bad_email" });

  const db = serviceClient();
  let userId = (await db.rpc("user_id_by_email_internal", { p_email: email })).data as string | null;
  let created = false;
  if (!userId) {
    // Display names are public, so a new member needs one; the email is never shown.
    if (!displayName) return json(req, origins, 400, { error: "name_required", message: "Give the new member a display name." });
    const { data, error } = await db.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (error || !data.user) return json(req, origins, 409, { error: "create_failed", message: error?.message });
    userId = data.user.id;
    created = true;
    await db.from("audit_log").insert({
      actor: admin.id,
      action: "member_added",
      target_type: "profile",
      target_id: userId,
      after: { displayName },
    });
  }
  if (entryId) {
    const { error } = await userClient(req).rpc("admin_set_manager", { p_entry: entryId, p_user: userId, p_add: true });
    if (error) return json(req, origins, 409, { error: dbErrorCode(error.message) });
  }
  return json(req, origins, 200, { userId, created });
});
