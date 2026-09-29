import { vi } from "vitest";
import { demoRegistry } from "@/lib/clinic/registry";
import { RateLimiter } from "@/lib/http/rate-limit";
import { memoryIntakeStore } from "@/lib/intake/store";
import { recordingMessenger } from "@/lib/notify/sms";
import { memoryCallStore } from "@/lib/postcall/record";
import type { ServerDeps } from "@/lib/server/deps";
import { memoryFirstDelivery, memorySessionOwner } from "@/lib/store/redis";

export const SECRET = "s".repeat(40);
export const WEBHOOK_SECRET = "w".repeat(40);
export const NOW = new Date("2026-09-14T02:30:00Z");

/** A full set of server dependencies with no network, no Redis and a fixed clock. */
export function testDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    env: {
      assemblyAiKey: "test-key",
      secret: SECRET,
      webhookSecret: WEBHOOK_SECRET,
      agentId: "agent-sunrise",
      redis: null,
    },
    clinics: demoRegistry("agent-sunrise"),
    intakes: memoryIntakeStore(() => NOW.getTime()),
    calls: memoryCallStore(),
    firstDelivery: memoryFirstDelivery(),
    claimSession: memorySessionOwner(),
    medications: { lookup: async (name) => ({ kind: "none", name }) },
    sms: recordingMessenger(),
    voice: {
      mintToken: vi.fn(async () => "browser-token"),
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      getSession: vi.fn(),
      importPhoneNumber: vi.fn(),
      bindPhoneNumber: vi.fn(),
    },
    hearing: { transcribe: vi.fn(async () => ({ caller: [], agent: [] })) },
    callStarts: new RateLimiter(5, 600_000, () => NOW.getTime()),
    resultChecks: new RateLimiter(60, 600_000, () => NOW.getTime()),
    deskSignIns: new RateLimiter(5, 600_000, () => NOW.getTime()),
    now: () => NOW,
    ...overrides,
  };
}

/** A POST as a page on this site would send it. */
export function sameOriginPost(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://twiceheard.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
