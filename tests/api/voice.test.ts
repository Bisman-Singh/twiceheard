import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as startSession } from "@/app/api/voice/session/route";
import { POST as relayTool } from "@/app/api/voice/tool/route";
import { demoRegistry } from "@/lib/clinic/registry";
import { RateLimiter } from "@/lib/http/rate-limit";
import { CALL_GRANT_COOKIE, issueCallGrant } from "@/lib/security/call-grant";
import { setServerDeps } from "@/lib/server/deps";
import { VoiceAgentApiError } from "@/lib/voice-agent/client";
import { NOW, SECRET, sameOriginPost, testDeps } from "@/tests/api/helpers";

afterEach(() => {
  setServerDeps(null);
  vi.restoreAllMocks();
});

const begin = (
  body: unknown = { clinicId: "sunrise-family" },
  headers: Record<string, string> = {},
) => startSession(sameOriginPost("/api/voice/session", body, headers));

const grantCookie = (clinicId = "sunrise-family") => ({
  cookie: `${CALL_GRANT_COOKIE}=${issueCallGrant(clinicId, SECRET, NOW)}`,
});

const relay = (body: unknown, headers: Record<string, string> = grantCookie()) =>
  relayTool(sameOriginPost("/api/voice/tool", body, headers));

describe("POST /api/voice/session", () => {
  it("hands a browser the clinic's stored agent when one can reach us", async () => {
    const deps = testDeps();
    setServerDeps(deps);
    const response = await begin();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      token: "browser-token",
      mode: "agent",
      agentId: "agent-sunrise",
    });
    expect(deps.voice.mintToken).toHaveBeenCalledWith({
      expiresInSeconds: 60,
      maxSessionSeconds: 900,
    });
  });

  it("falls back to the same agent inline when no stored agent is configured", async () => {
    setServerDeps(testDeps({ clinics: demoRegistry(undefined) }));
    const body = (await (await begin()).json()) as { mode: string; session: { tools: unknown[] } };
    expect(body.mode).toBe("relay");
    expect(body.session.tools).toHaveLength(7);
  });

  it("issues a grant cookie that a browser cannot read or send elsewhere", async () => {
    setServerDeps(testDeps());
    const cookie = (await begin()).headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${CALL_GRANT_COOKIE}=sunrise-family.`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=1200");
    // Localhost is a secure context without https, so Secure is added only in production.
    expect(cookie).not.toContain("Secure");
    vi.stubEnv("NODE_ENV", "production");
    expect((await begin()).headers.get("set-cookie")).toContain("Secure");
    vi.unstubAllEnvs();
  });

  it("refuses other sites, unknown clinics and unexpected fields", async () => {
    setServerDeps(testDeps());
    expect((await begin(undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await begin({ clinicId: "another-clinic" })).status).toBe(404);
    expect((await begin({ clinicId: "sunrise-family", debug: true })).status).toBe(400);
  });

  it("counts every attempt against the limit, including ones that turn out to be invalid", async () => {
    setServerDeps(testDeps({ callStarts: new RateLimiter(2, 600_000, () => NOW.getTime()) }));
    expect((await begin({ clinicId: "another-clinic" })).status).toBe(404);
    expect((await begin()).status).toBe(200);
    const limited = await begin();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
  });

  it("hides the platform's own error behind a generic failure", async () => {
    const deps = testDeps();
    vi.mocked(deps.voice.mintToken).mockRejectedValue(new VoiceAgentApiError(401, "Unauthorized"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setServerDeps(deps);
    const response = await begin();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal_error",
      message: "Something went wrong.",
    });
  });
});

describe("POST /api/voice/tool", () => {
  it("runs the same handlers the phone runs, for the clinic named in the grant", async () => {
    const deps = testDeps();
    setServerDeps(deps);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = await relay({ tool: "start_intake", arguments: {} });
    expect(started.status).toBe(200);
    const { intake_id: intakeId } = (await started.json()) as { intake_id: string };
    const saved = await relay({
      tool: "save_field",
      arguments: { intake_id: intakeId, field: "full_name", value: "Arjun Mehta", status: "heard" },
    });
    expect(await saved.json()).toEqual({
      ok: true,
      say: "I have your name as Arjun Mehta. Is that right?",
    });
    expect((await deps.intakes.get(intakeId))?.chart.full_name.status).toBe("heard");
  });

  it("logs the tool and the outcome, never the caller's words", async () => {
    setServerDeps(testDeps());
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { intake_id: intakeId } = (await (await relay({ tool: "start_intake" })).json()) as {
      intake_id: string;
    };
    await relay({
      tool: "save_field",
      arguments: { intake_id: intakeId, field: "full_name", value: "Arjun Mehta", status: "heard" },
    });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("save_field");
    expect(logged).not.toContain("Arjun");
  });

  it("refuses a call with no grant, an expired one, another site's request or an unknown tool", async () => {
    setServerDeps(testDeps());
    expect((await relay({ tool: "start_intake" }, {})).status).toBe(401);
    const stale = { cookie: `${CALL_GRANT_COOKIE}=sunrise-family.1.deadbeef` };
    expect((await relay({ tool: "start_intake" }, stale)).status).toBe(401);
    const foreign = {
      cookie: `${CALL_GRANT_COOKIE}=${issueCallGrant("another-clinic", SECRET, NOW)}`,
    };
    expect((await relay({ tool: "start_intake" }, foreign)).status).toBe(401);
    expect(
      (await relay({ tool: "start_intake" }, { ...grantCookie(), "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(403);
    expect((await relay({ tool: "drop_everything" })).status).toBe(404);
    expect((await relay({ tool: "start_intake", extra: 1 })).status).toBe(400);
    expect(
      (await relay({ tool: "start_intake", arguments: { pad: "x".repeat(20_000) } })).status,
    ).toBe(413);
  });

  it("stops one grant from driving the clinic's whole diary", async () => {
    setServerDeps(testDeps({ toolCalls: new RateLimiter(2, 600_000, () => NOW.getTime()) }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await relay({ tool: "start_intake" })).status).toBe(200);
    expect((await relay({ tool: "start_intake" })).status).toBe(200);
    const limited = await relay({ tool: "start_intake" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
  });

  it("will not let one browser drive an intake another browser started", async () => {
    const deps = testDeps();
    setServerDeps(deps);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { intake_id: intakeId } = (await (await relay({ tool: "start_intake" })).json()) as {
      intake_id: string;
    };
    const stranger = {
      cookie: `${CALL_GRANT_COOKIE}=${issueCallGrant("sunrise-family", SECRET, new Date(NOW.getTime() + 1000))}`,
    };
    const stolen = await relay(
      {
        tool: "save_field",
        arguments: {
          intake_id: intakeId,
          field: "full_name",
          value: "Someone Else",
          status: "heard",
        },
      },
      stranger,
    );
    expect(await stolen.json()).toMatchObject({ ok: false });
    expect((await deps.intakes.get(intakeId))?.chart.full_name.value).toBeNull();
  });

  it("finds the grant among other cookies", async () => {
    setServerDeps(testDeps());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const headers = { cookie: `theme=dark; ${grantCookie().cookie}; other=1` };
    expect((await relay({ tool: "start_intake" }, headers)).status).toBe(200);
  });
});
