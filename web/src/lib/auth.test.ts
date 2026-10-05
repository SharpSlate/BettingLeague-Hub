import { describe, expect, it } from "vitest";
import { authErrorText } from "./auth.ts";

describe("sign-in refusals", () => {
  it("say what to do for the common ones", () => {
    expect(authErrorText({ code: "invalid_credentials", message: "Invalid login credentials" })).toMatch(/don't match.*Forgot your password/);
    expect(authErrorText({ code: "otp_expired", message: "Token has expired or is invalid" })).toMatch(/code didn't work/);
  });
  it("send an existing account, a commissioner's added member included, to sign in or reset", () => {
    for (const code of ["user_already_exists", "email_exists"]) {
      expect(authErrorText({ code, message: "User already registered" })).toMatch(/already has an account.*Forgot your password/);
    }
  });
  it("give the wait from a too-soon email, or the hourly cap", () => {
    expect(authErrorText({ code: "over_email_send_rate_limit", message: "For security purposes, you can only request this after 42 seconds." })).toBe("Wait 42 seconds, then ask for another email.");
    expect(authErrorText({ code: "over_email_send_rate_limit", message: "email rate limit exceeded" })).toMatch(/Try again in an hour/);
  });
  it("say an email address is wrong, but keep other validation messages", () => {
    expect(authErrorText({ code: "validation_failed", message: "Unable to validate email address: invalid format" })).toBe("That email address doesn't look right.");
    expect(authErrorText({ code: "validation_failed", message: "Password is required" })).toBe("Password is required");
  });
  it("cover a dropped connection and an ended session, which have no code", () => {
    expect(authErrorText({ name: "AuthRetryableFetchError", message: "Failed to fetch" })).toMatch(/Couldn't reach the site/);
    expect(authErrorText({ name: "AuthSessionMissingError", message: "Auth session missing!" })).toMatch(/signed out/);
  });
  it("keep the server's words for anything else, such as a too-weak password", () => {
    expect(authErrorText({ code: "weak_password", message: "Password should be at least 8 characters." })).toBe("Password should be at least 8 characters.");
    expect(authErrorText({ message: "Something new" })).toBe("Something new");
  });
});
