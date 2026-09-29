import { createHmac } from "node:crypto";
import { sameSecret } from "@/lib/security/keys";

/**
 * How the front desk gets in.
 *
 * Each clinic has one code, derived from the server secret rather than stored,
 * so rotating the secret rotates every clinic's code and one clinic's code
 * tells you nothing about another's. Signing in exchanges the code for a
 * signed session in an httpOnly cookie that names the clinic and nothing else.
 * Every desk page reads that cookie on the server and shows only that clinic's
 * calls; there is no client-side check to get around.
 */

export const DESK_COOKIE = "twiceheard_desk";
/** A shift, near enough. After it, the desk signs in again. */
export const DESK_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Letters and digits that cannot be misread when a code is read out loud. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;

/** The code the desk types in. Derived, so nothing has to store it. */
export function deskCode(clinicId: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(`desk-code:${clinicId}`).digest();
  return [...digest.subarray(0, CODE_LENGTH)]
    .map((byte) => ALPHABET[byte % ALPHABET.length])
    .join("");
}

/** The clinic a typed code belongs to, compared in constant time against each. */
export function clinicForCode(
  code: string,
  clinicIds: readonly string[],
  secret: string,
): string | null {
  const typed = code.trim().toUpperCase();
  let found: string | null = null;
  for (const clinicId of clinicIds) {
    // Every clinic is checked, so the time taken says nothing about which matched.
    if (sameSecret(typed, deskCode(clinicId, secret))) found = clinicId;
  }
  return found;
}

export function issueDeskSession(clinicId: string, secret: string, now: Date): string {
  const expiresAt = now.getTime() + DESK_SESSION_TTL_MS;
  const payload = `${clinicId}.${expiresAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** The clinic the session is for, or null if it is missing, altered or expired. */
export function readDeskSession(
  session: string | undefined,
  secret: string,
  now: Date,
): string | null {
  const parts = session?.split(".");
  if (!parts || parts.length !== 3) return null;
  const [clinicId, expiresAt, signature] = parts as [string, string, string];
  if (!sameSecret(signature, sign(`${clinicId}.${expiresAt}`, secret))) return null;
  return Number(expiresAt) > now.getTime() ? clinicId : null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`desk-session:${payload}`).digest("hex");
}
