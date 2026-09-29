import { describe, expect, it } from "vitest";
import {
  CALL_GRANT_COOKIE,
  CALL_GRANT_TTL_MS,
  issueCallGrant,
  readCallGrant,
} from "@/lib/security/call-grant";

const SECRET = "s".repeat(40);
const OTHER = "t".repeat(40);
const NOW = new Date("2026-09-29T06:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("call grants", () => {
  it("names the clinic the call was started for, until it expires", () => {
    const grant = issueCallGrant("sunrise-family", SECRET, NOW);
    expect(readCallGrant(grant, SECRET, NOW)).toBe("sunrise-family");
    expect(readCallGrant(grant, SECRET, later(CALL_GRANT_TTL_MS - 1000))).toBe("sunrise-family");
    expect(readCallGrant(grant, SECRET, later(CALL_GRANT_TTL_MS + 1000))).toBeNull();
  });

  it("refuses a missing, malformed, altered or foreign grant", () => {
    const grant = issueCallGrant("sunrise-family", SECRET, NOW);
    const [clinicId, expiresAt, signature] = grant.split(".") as [string, string, string];
    expect(readCallGrant(undefined, SECRET, NOW)).toBeNull();
    expect(readCallGrant("", SECRET, NOW)).toBeNull();
    expect(readCallGrant("two.parts", SECRET, NOW)).toBeNull();
    expect(readCallGrant(grant, OTHER, NOW)).toBeNull();
    // A different clinic, a longer life and a tampered signature are all rejected.
    expect(readCallGrant(`another-clinic.${expiresAt}.${signature}`, SECRET, NOW)).toBeNull();
    expect(
      readCallGrant(`${clinicId}.${Number(expiresAt) + 60_000}.${signature}`, SECRET, NOW),
    ).toBeNull();
    expect(
      readCallGrant(`${clinicId}.${expiresAt}.${"0".repeat(signature.length)}`, SECRET, NOW),
    ).toBeNull();
  });

  it("keeps the cookie name in one place", () => {
    expect(CALL_GRANT_COOKIE).toBe("earshot_call");
  });
});
