import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertSecret, sameSecret, toolKeyFor, validWebhookSignature } from "@/lib/security/keys";

const SECRET = "s".repeat(32);

describe("assertSecret", () => {
  it("refuses missing or short secrets and returns a good one", () => {
    expect(() => assertSecret(undefined, "EARSHOT_SECRET")).toThrow(/EARSHOT_SECRET must be set/);
    expect(() => assertSecret("short", "EARSHOT_SECRET")).toThrow(/32 characters/);
    expect(assertSecret(SECRET, "EARSHOT_SECRET")).toBe(SECRET);
  });
});

describe("tool keys", () => {
  it("derives a stable, different key per clinic and per secret", () => {
    const sunrise = toolKeyFor("sunrise-family", SECRET);
    expect(sunrise).toMatch(/^[0-9a-f]{64}$/);
    expect(toolKeyFor("sunrise-family", SECRET)).toBe(sunrise);
    expect(toolKeyFor("another-clinic", SECRET)).not.toBe(sunrise);
    expect(toolKeyFor("sunrise-family", "t".repeat(32))).not.toBe(sunrise);
  });

  it("compares keys safely, rejecting absent, shorter and different ones", () => {
    const key = toolKeyFor("sunrise-family", SECRET);
    expect(sameSecret(key, key)).toBe(true);
    expect(sameSecret(null, key)).toBe(false);
    expect(sameSecret("", key)).toBe(false);
    expect(sameSecret(key.slice(0, -1), key)).toBe(false);
    expect(sameSecret(toolKeyFor("another-clinic", SECRET), key)).toBe(false);
  });
});

describe("validWebhookSignature", () => {
  it("accepts the signature over the exact raw body and nothing else", () => {
    const body = '{"event":"session.completed","session":{"session_id":"sess_1"}}';
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    expect(validWebhookSignature(body, signature, SECRET)).toBe(true);
    expect(validWebhookSignature(`${body} `, signature, SECRET)).toBe(false);
    expect(validWebhookSignature(body, signature.replace("sha256=", ""), SECRET)).toBe(false);
    expect(validWebhookSignature(body, null, SECRET)).toBe(false);
  });
});
