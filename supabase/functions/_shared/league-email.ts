// An admin's email to the whole league (the email-league function): what it takes and
// the message it sends. Pure code, so the tests can check it without sending anything.

export const MAX_SUBJECT = 150;
export const MAX_MESSAGE = 10_000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Daily limits on league emails, counted in recipients over the last 24 hours. Every
 * league sends through the site's one Gmail, which also sends password reset codes and
 * takes about 500 recipients a day, so one busy league can't use it up and the site's
 * total leaves room for the codes.
 */
export const LEAGUE_DAILY_RECIPIENTS = 100;
export const SITE_DAILY_RECIPIENTS = 300;

/** The error code that refuses a send of `recipients` given what's gone out in the last 24 hours, or null. */
export function overDailyLimit(recipients: number, leagueSent: number, siteSent: number): "league_daily_limit" | "site_daily_limit" | null {
  if (leagueSent + recipients > LEAGUE_DAILY_RECIPIENTS) return "league_daily_limit";
  if (siteSent + recipients > SITE_DAILY_RECIPIENTS) return "site_daily_limit";
  return null;
}

export interface LeagueEmailRequest {
  subject: string;
  message: string;
  /** Send only to the admin who's sending, to see how it looks. */
  testOnly: boolean;
}

/** The request, or the error code that refuses it. */
export function readLeagueEmail(body: unknown): LeagueEmailRequest | { error: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const subject = typeof b.subject === "string" ? b.subject.replace(/[\r\n]+/g, " ").trim() : "";
  const message = typeof b.message === "string" ? b.message.replace(/\r\n/g, "\n").trim() : "";
  if (!subject) return { error: "subject_required" };
  if (subject.length > MAX_SUBJECT) return { error: "subject_too_long" };
  if (!message) return { error: "message_required" };
  if (message.length > MAX_MESSAGE) return { error: "message_too_long" };
  return { subject, message, testOnly: b.testOnly === true };
}

export interface LeagueEmail {
  from: string;
  to: string;
  bcc: string[];
  replyTo: string | undefined;
  subject: string;
  text: string;
}

/**
 * The email: from the league's address to itself, with every member in Bcc so nobody
 * sees anyone else's address, and replies going to the admin who sent it. A test goes
 * to the sender alone.
 */
export function composeLeagueEmail(
  req: LeagueEmailRequest,
  o: { leagueName: string; leagueAddress: string; senderName: string; senderEmail: string | null; members: string[]; siteUrl: string },
): LeagueEmail {
  const sender = o.senderEmail && EMAIL.test(o.senderEmail) ? o.senderEmail.toLowerCase() : null;
  const members = [...new Set(o.members.map((m) => m.trim().toLowerCase()).filter((m) => EMAIL.test(m)))];
  const bcc = req.testOnly ? (sender ? [sender] : []) : members;
  const footer = ["", "--", `Sent by ${o.senderName} from the ${o.leagueName} site${o.siteUrl ? `: ${o.siteUrl}` : ""}.`];
  if (sender) footer.push(`Reply to this email to reach ${o.senderName}.`);
  return {
    from: `"${o.leagueName.replace(/"/g, "")}" <${o.leagueAddress}>`,
    to: o.leagueAddress,
    bcc,
    replyTo: sender ?? undefined,
    subject: req.testOnly ? `[Test] ${req.subject}` : req.subject,
    text: `${req.message}\n${footer.join("\n")}\n`,
  };
}
