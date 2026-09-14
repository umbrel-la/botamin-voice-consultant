import { createHash, timingSafeEqual } from "crypto";

export function hashSessionSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function sessionHashMatches(secret: string, storedHash: string) {
  const actual = Buffer.from(hashSessionSecret(secret), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseLeadCookie(raw: string | undefined | null) {
  if (!raw) return null;
  const value = decodeURIComponent(raw.trim());
  const separator = value.indexOf(".");
  if (separator < 1) return null;
  return { leadId: value.slice(0, separator), secret: value.slice(separator + 1) };
}
