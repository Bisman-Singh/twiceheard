import { describe, expect, it, vi } from "vitest";
import {
  DESK_COOKIE,
  DESK_SESSION_TTL_MS,
  clinicForCode,
  deskCode,
  issueDeskSession,
  readDeskSession,
} from "@/lib/security/desk-session";

const SECRET = "s".repeat(40);
const OTHER = "t".repeat(40);
const NOW = new Date("2026-09-29T06:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const CLINICS = ["sunrise-family", "harbour-road"];

describe("desk codes", () => {
  it("gives each clinic its own readable code, derived from the server secret", () => {
    const code = deskCode("sunrise-family", SECRET);
    expect(code).toHaveLength(10);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    expect(deskCode("sunrise-family", SECRET)).toBe(code);
    expect(deskCode("harbour-road", SECRET)).not.toBe(code);
    // Rotating the secret rotates every clinic's code.
    expect(deskCode("sunrise-family", OTHER)).not.toBe(code);
  });

  it("finds the clinic a typed code belongs to, whatever case or spacing it is typed in", () => {
    const code = deskCode("harbour-road", SECRET);
    expect(clinicForCode(code, CLINICS, SECRET)).toBe("harbour-road");
    expect(clinicForCode(`  ${code.toLowerCase()} `, CLINICS, SECRET)).toBe("harbour-road");
  });

  it("refuses a code that is wrong, empty, or right for a clinic this deployment does not serve", () => {
    expect(clinicForCode("", CLINICS, SECRET)).toBeNull();
    expect(clinicForCode("AAAAAAAAAA", CLINICS, SECRET)).toBeNull();
    expect(clinicForCode(deskCode("sunrise-family", OTHER), CLINICS, SECRET)).toBeNull();
    expect(clinicForCode(deskCode("harbour-road", SECRET), ["sunrise-family"], SECRET)).toBeNull();
  });
});

describe("desk sessions", () => {
  it("names the clinic for a shift, then expires", () => {
    const session = issueDeskSession("sunrise-family", SECRET, NOW);
    expect(readDeskSession(session, SECRET, NOW)).toBe("sunrise-family");
    expect(readDeskSession(session, SECRET, later(DESK_SESSION_TTL_MS - 1000))).toBe(
      "sunrise-family",
    );
    expect(readDeskSession(session, SECRET, later(DESK_SESSION_TTL_MS + 1000))).toBeNull();
  });

  it("refuses a missing, malformed, altered or foreign session", () => {
    const session = issueDeskSession("sunrise-family", SECRET, NOW);
    const [clinicId, expiresAt, signature] = session.split(".") as [string, string, string];
    expect(readDeskSession(undefined, SECRET, NOW)).toBeNull();
    expect(readDeskSession("two.parts", SECRET, NOW)).toBeNull();
    expect(readDeskSession(session, OTHER, NOW)).toBeNull();
    expect(readDeskSession(`harbour-road.${expiresAt}.${signature}`, SECRET, NOW)).toBeNull();
    expect(
      readDeskSession(`${clinicId}.${Number(expiresAt) + 60_000}.${signature}`, SECRET, NOW),
    ).toBeNull();
  });

  it("keeps the cookie name in one place, and locks it to this host in production", async () => {
    expect(DESK_COOKIE).toBe("twiceheard_desk");
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const fresh = await import("@/lib/security/desk-session");
    expect(fresh.DESK_COOKIE).toBe("__Host-twiceheard_desk");
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
