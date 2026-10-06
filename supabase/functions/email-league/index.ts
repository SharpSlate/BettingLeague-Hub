// Sends a commissioner's message to every member of their league from the site's email
// address (the Gmail account that sends sign-in codes), under the league's name, with
// everyone in Bcc and replies going to the commissioner. The league's commissioners only.
// A test goes to the sender alone. Each send, tests included, is recorded in the league's
// admin log (its subject and how many it went to; never the addresses), which its members
// can read, and counts toward the daily limits in league-email.ts.
import nodemailer from "npm:nodemailer@6.9.16";
import { composeLeagueEmail, LEAGUE_DAILY_RECIPIENTS, overDailyLimit, readLeagueEmail } from "../_shared/league-email.ts";
import { currentUser, isCommissioner, serviceClient, siteOrigins, userClient } from "../_shared/env.ts";
import { json, preflight } from "../_shared/http.ts";

const MESSAGES: Record<string, string> = {
  subject_required: "Give the email a subject.",
  subject_too_long: "Keep the subject under 150 characters.",
  message_required: "Write a message.",
  message_too_long: "Keep the message under 10,000 characters.",
  smtp_not_set: "The site's email account isn't set up yet (SMTP_USER and SMTP_PASS in GitHub Secrets).",
  no_recipients: "There's nobody to send it to.",
  duplicate: "That email was just sent. Check your inbox before sending it again.",
  league_daily_limit: `A league can email at most ${LEAGUE_DAILY_RECIPIENTS} recipients a day, counting tests. Try again tomorrow, or use "Open in my own email app".`,
  site_daily_limit: `The site has sent all the league email it can today (its account also sends password reset codes). Try again tomorrow, or use "Open in my own email app".`,
};

Deno.serve(async (req) => {
  const origins = siteOrigins();
  const pre = preflight(req, origins);
  if (pre) return pre;
  if (req.method !== "POST") return json(req, origins, 405, { error: "method_not_allowed" });

  const admin = await currentUser(req);
  const body = await req.json().catch(() => null);
  const leagueId = typeof body?.leagueId === "string" ? body.leagueId : "";
  if (!admin || !leagueId || !(await isCommissioner(admin.id, leagueId))) {
    return json(req, origins, 403, { error: "commissioner_only", message: "Only the league's commissioners can do that." });
  }
  const read = readLeagueEmail(body);
  if ("error" in read) return json(req, origins, 400, { error: read.error, message: MESSAGES[read.error] });

  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  if (!user || !pass) return json(req, origins, 503, { error: "smtp_not_set", message: MESSAGES.smtp_not_set });

  // The member list as the commissioner sees it on the Admin page.
  const { data: members, error } = await userClient(req).rpc("admin_list_users", { p_league: leagueId });
  if (error) return json(req, origins, 500, { error: "error", message: "The member list couldn't be read." });
  const rows = (members ?? []) as { user_id: string; email: string | null; display_name: string }[];
  const me = rows.find((r) => r.user_id === admin.id);

  const db = serviceClient();
  const league = await db.from("leagues").select("name").eq("id", leagueId).single();
  if (league.error || !league.data) return json(req, origins, 500, { error: "error", message: "The league couldn't be read." });
  if (!read.testOnly) {
    // A double click, or a second tab, shouldn't send it twice.
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const recent = await db.from("audit_log").select("after").eq("actor", admin.id).eq("league_id", leagueId).eq("action", "league_emailed").gte("created_at", since);
    if ((recent.data ?? []).some((r: { after: { subject?: string; test?: boolean } | null }) => !r.after?.test && r.after?.subject === read.subject)) {
      return json(req, origins, 409, { error: "duplicate", message: MESSAGES.duplicate });
    }
  }

  const mail = composeLeagueEmail(read, {
    leagueName: (league.data as { name: string }).name,
    leagueAddress: user,
    senderName: me?.display_name ?? "The commissioner",
    senderEmail: me?.email ?? null,
    members: rows.map((r) => r.email ?? ""),
    siteUrl: Deno.env.get("SITE_URL") ?? Deno.env.get("SITE_ORIGIN") ?? "",
  });
  if (!mail.bcc.length) return json(req, origins, 400, { error: "no_recipients", message: MESSAGES.no_recipients });

  // The daily limits, from the log of sends (tests included) in the last 24 hours.
  const day = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const sent = await db.from("audit_log").select("league_id, after").eq("action", "league_emailed").gte("created_at", day);
  if (sent.error) return json(req, origins, 500, { error: "error", message: "The site couldn't check today's email count." });
  const rows24 = (sent.data ?? []) as { league_id: string | null; after: { recipients?: number } | null }[];
  const count = (rs: typeof rows24) => rs.reduce((n, r) => n + (Number(r.after?.recipients) || 0), 0);
  const limit = overDailyLimit(mail.bcc.length, count(rows24.filter((r) => r.league_id === leagueId)), count(rows24));
  if (limit) return json(req, origins, 429, { error: limit, message: MESSAGES[limit] });

  try {
    // Port 465 (TLS from the start): Supabase's functions can't use 25 or 587.
    const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
    await transport.sendMail(mail);
  } catch (e) {
    console.error("league email failed", e);
    const why = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
    return json(req, origins, 502, { error: "send_failed", message: `The email didn't go out (${why}). Try "Open in my email app" instead.` });
  }
  // Tests are logged too, so they count toward the daily limits.
  await db.from("audit_log").insert({
    actor: admin.id, league_id: leagueId, action: "league_emailed", target_type: "league", target_id: leagueId,
    after: { subject: read.subject, recipients: mail.bcc.length, ...(read.testOnly ? { test: true } : {}) },
  });
  return json(req, origins, 200, { sent: mail.bcc.length });
});
