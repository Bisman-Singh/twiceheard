import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/voice/token/route";
import { demoRegistry } from "@/lib/clinic/registry";
import { RateLimiter } from "@/lib/http/rate-limit";
import { setServerDeps } from "@/lib/server/deps";
import { VoiceAgentApiError } from "@/lib/voice-agent/client";
import { NOW, sameOriginPost, testDeps } from "@/tests/api/helpers";

afterEach(() => {
  setServerDeps(null);
  vi.restoreAllMocks();
});

const ask = (
  body: unknown = { clinicId: "sunrise-family" },
  headers: Record<string, string> = {},
) => POST(sameOriginPost("/api/voice/token", body, headers));

describe("POST /api/voice/token", () => {
  it("mints a short, capped token for this clinic's agent", async () => {
    const deps = testDeps();
    setServerDeps(deps);
    const response = await ask();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ token: "browser-token", agentId: "agent-sunrise" });
    expect(deps.voice.mintToken).toHaveBeenCalledWith({
      expiresInSeconds: 60,
      maxSessionSeconds: 900,
    });
  });

  it("refuses other sites, unknown clinics, clinics with no agent and unexpected fields", async () => {
    setServerDeps(testDeps());
    expect((await ask(undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await ask({ clinicId: "another-clinic" })).status).toBe(404);
    expect((await ask({ clinicId: "sunrise-family", debug: true })).status).toBe(400);
    setServerDeps(testDeps({ clinics: demoRegistry(undefined) }));
    expect(await (await ask()).json()).toMatchObject({ error: "no_agent" });
  });

  it("limits how many calls one address can start", async () => {
    setServerDeps(testDeps({ callStarts: new RateLimiter(2, 600_000, () => NOW.getTime()) }));
    const from = { "x-real-ip": "203.0.113.9" };
    expect((await ask(undefined, from)).status).toBe(200);
    expect((await ask(undefined, from)).status).toBe(200);
    const limited = await ask(undefined, from);
    expect(limited.status).toBe(429);
    expect((await ask(undefined, { "x-real-ip": "203.0.113.10" })).status).toBe(200);
  });

  it("hides the platform's error behind a generic failure", async () => {
    const deps = testDeps();
    vi.mocked(deps.voice.mintToken).mockRejectedValue(new VoiceAgentApiError(401, "Unauthorized"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setServerDeps(deps);
    const response = await ask();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal_error",
      message: "Something went wrong.",
    });
  });
});
