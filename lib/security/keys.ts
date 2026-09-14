import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Secrets that prove a request came from the voice platform.
 *
 * Tool calls carry a per-clinic key in a header. Rather than store a key per
 * clinic, each one is derived from a single server secret, so rotating that
 * secret rotates every clinic at once and a leaked clinic key cannot be used
 * to work out another's. Webhook deliveries are signed with HMAC-SHA256 over
 * the raw body. Every comparison takes the same time whatever the input.
 */

const MIN_SECRET_LENGTH = 32;

export function assertSecret(secret: string | undefined, name: string): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be set to at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

/** The key a clinic's tool calls must carry. */
export function toolKeyFor(clinicId: string, secret: string): string {
  return createHmac("sha256", secret).update(`tool-key:${clinicId}`).digest("hex");
}

export function sameSecret(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `X-AAI-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. */
export function validWebhookSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return sameSecret(header, expected);
}
