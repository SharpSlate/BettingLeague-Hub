// What the sign-in pages say when Supabase's sign-in server refuses something.

/** The shortest password the site takes. supabase/config.toml sets the same for the server. */
export const MIN_PASSWORD = 8;

/**
 * A sign-in refusal in plain words. Supabase's sign-in errors carry a code (supabase-js puts
 * it on error.code); one without a code the site knows keeps the server's own message.
 */
export function authErrorText(e: { code?: string; name?: string; message: string }): string {
  if (e.name === "AuthRetryableFetchError") return "Couldn't reach the site. Check your connection and try again.";
  if (e.name === "AuthSessionMissingError") return "You're signed out. Sign in again.";
  switch (e.code) {
    case "invalid_credentials":
      return "That email and password don't match. Check them, or use “Forgot your password?”.";
    case "user_already_exists":
    case "email_exists":
      // Also a member a commissioner added by email, who has no password yet.
      return "That email already has an account. Sign in, or use “Forgot your password?” to set a new password.";
    case "same_password":
      return "That's already your password.";
    case "otp_expired":
      return "That code didn't work. Check it, or send a new one.";
    case "email_address_invalid":
      return "That email address doesn't look right.";
    case "validation_failed":
      return /email/i.test(e.message) ? "That email address doesn't look right." : e.message;
    case "email_address_not_authorized":
      // Supabase's own sender only reaches the project's team, until the site has its own.
      return "The site can't email that address yet, so password resets don't work for now. Ask the site's owner for help.";
    case "over_email_send_rate_limit": {
      const seconds = /(\d+) seconds?/.exec(e.message)?.[1];
      return seconds ? `Wait ${seconds} seconds, then ask for another email.` : "The site has sent all the email it can for now. Try again in an hour.";
    }
    case "over_request_rate_limit":
      return "Too many tries just now. Wait a few minutes, then try again.";
    case "user_banned":
      return "This account is turned off. Ask the site's owner for help.";
    case "signup_disabled":
      return "New accounts are turned off right now.";
    default:
      return e.message;
  }
}
