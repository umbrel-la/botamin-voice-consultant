import { describe, expect, it } from "vitest";
import { hashSessionSecret, parseLeadCookie, sessionHashMatches } from "./session-secret";

describe("session secret", () => {
  it("stores a SHA-256 hash instead of the raw cookie secret", () => {
    const secret = "raw-session-secret";
    const hash = hashSessionSecret(secret);
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(secret);
    expect(sessionHashMatches(secret, hash)).toBe(true);
    expect(sessionHashMatches("other", hash)).toBe(false);
  });

  it("parses the HttpOnly lead cookie", () => {
    expect(parseLeadCookie("lead-id.secret-value")).toEqual({
      leadId: "lead-id",
      secret: "secret-value",
    });
    expect(parseLeadCookie(undefined)).toBeNull();
  });
});
