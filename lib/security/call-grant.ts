import { createHmac } from "node:crypto";
import { sameSecret } from "@/lib/security/keys";

/**
 * Permission to relay one browser call's tool calls.
 *
 * On the phone, AssemblyAI calls the tool endpoint itself and proves who it
 * is with the clinic's key. A browser cannot hold that key, so a call started
 * from this site gets a short-lived signed grant instead, kept in an
 * httpOnly cookie. It names the clinic, expires quickly, and is checked on
 * every relayed tool call alongside the same-origin check.
 */

export const CALL_GRANT_COOKIE = "twiceheard_call";
/** A browser intake runs well inside this; after it, the caller starts again. */
export const CALL_GRANT_TTL_MS = 20 * 60 * 1000;

export function issueCallGrant(clinicId: string, secret: string, now: Date): string {
  const expiresAt = now.getTime() + CALL_GRANT_TTL_MS;
  const payload = `${clinicId}.${expiresAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** The clinic the grant is for, or null if it is missing, altered or expired. */
export function readCallGrant(grant: string | undefined, secret: string, now: Date): string | null {
  const parts = grant?.split(".");
  if (!parts || parts.length !== 3) return null;
  const [clinicId, expiresAt, signature] = parts as [string, string, string];
  if (!sameSecret(signature, sign(`${clinicId}.${expiresAt}`, secret))) return null;
  return Number(expiresAt) > now.getTime() ? clinicId : null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`call-grant:${payload}`).digest("hex");
}
