import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as claim } from "@/app/api/call/claim/route";
import { POST as result } from "@/app/api/call/result/route";
import { RateLimiter } from "@/lib/http/rate-limit";
import { CALL_GRANT_COOKIE, issueCallGrant } from "@/lib/security/call-grant";
import { setServerDeps, type ServerDeps } from "@/lib/server/deps";
import type { CallRecord } from "@/lib/postcall/record";
import { VoiceAgentApiError } from "@/lib/voice-agent/client";
import type { Utterance } from "@/lib/verify/hearing";
import type { SessionDetail } from "@/lib/voice-agent/client";
import { NOW, SECRET, sameOriginPost, testDeps } from "@/tests/api/helpers";

const timeline = JSON.parse(readFileSync("tests/fixtures/timeline.json", "utf8")) as unknown;
const hearingFixture = JSON.parse(readFileSync("tests/fixtures/second-hearing.json", "utf8")) as {
  utterances: Array<{ channel: string; words: Utterance }>;
};
const heard = (channel: string) =>
  hearingFixture.utterances.filter((u) => u.channel === channel).map((u) => u.words);

const SESSION = "sess_fixture";
const relayed: SessionDetail = {
  id: SESSION,
  agent_id: null,
  status: "completed",
  duration_seconds: 63.1,
  artifacts: [
    { type: "audio", url: "https://cdn.assemblyai.com/a.ogg" },
    { type: "timeline", url: "https://cdn.assemblyai.com/t.json" },
  ],
};

function callDeps(session: SessionDetail = relayed, overrides: Partial<ServerDeps> = {}) {
  const deps = testDeps(overrides);
  vi.mocked(deps.voice.getSession).mockResolvedValue(session);
  for (const client of [deps.hearing, deps.quickHearing]) {
    vi.mocked(client.transcribe).mockResolvedValue({ caller: heard("1"), agent: heard("2") });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(timeline)),
  );
  setServerDeps(deps);
  return deps;
}

const cookie = (clinicId = "sunrise-family") => ({
  cookie: `${CALL_GRANT_COOKIE}=${issueCallGrant(clinicId, SECRET, NOW)}`,
});

const post = (
  route: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  headers: Record<string, string> = cookie(),
) => route(sameOriginPost(path, body, headers));

const askResult = (
  body: unknown = { sessionId: SESSION },
  headers: Record<string, string> = cookie(),
) => post(result, "/api/call/result", body, headers);

afterEach(() => {
  setServerDeps(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/call/claim", () => {
  it("binds the session to the browser that started the call", async () => {
    callDeps();
    expect((await post(claim, "/api/call/claim", { sessionId: SESSION })).status).toBe(200);
    // The same browser may claim again; a different one is refused.
    expect((await post(claim, "/api/call/claim", { sessionId: SESSION })).status).toBe(200);
    const other = {
      cookie: `${CALL_GRANT_COOKIE}=${issueCallGrant("sunrise-family", SECRET, new Date(NOW.getTime() + 1000))}`,
    };
    const stranger = await post(claim, "/api/call/claim", { sessionId: SESSION }, other);
    expect(stranger.status).toBe(409);
    expect(await stranger.json()).toMatchObject({ error: "session_claimed" });
  });

  it("refuses another site, a caller with no grant and a malformed body", async () => {
    callDeps();
    expect(
      (
        await post(
          claim,
          "/api/call/claim",
          { sessionId: SESSION },
          { ...cookie(), "sec-fetch-site": "cross-site" },
        )
      ).status,
    ).toBe(403);
    expect((await post(claim, "/api/call/claim", { sessionId: SESSION }, {})).status).toBe(401);
    expect((await post(claim, "/api/call/claim", { sessionId: "short" })).status).toBe(400);
  });
});

describe("POST /api/call/result", () => {
  it("processes a relayed call with no agent id and returns that caller's graded chart", async () => {
    const deps = callDeps();
    await post(claim, "/api/call/claim", { sessionId: SESSION });
    const response = await askResult();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      record: {
        clinicId: string;
        grade: { overall: string };
        chart: Record<string, { value: unknown }>;
      };
    };
    expect(body.status).toBe("ready");
    expect(body.record.clinicId).toBe("sunrise-family");
    expect(body.record.chart.full_name?.value).toBeTruthy();
    expect(await deps.calls.get(SESSION)).not.toBeNull();
  });

  it("hears the recording once, however many times the page asks", async () => {
    const deps = callDeps();
    await post(claim, "/api/call/claim", { sessionId: SESSION });
    await askResult();
    await askResult();
    await askResult();
    expect(deps.quickHearing.transcribe).toHaveBeenCalledTimes(1);
    // The caller's own request never uses the long-running client the webhook uses.
    expect(deps.hearing.transcribe).not.toHaveBeenCalled();
  });

  it("says pending while the platform has not attached the recording yet", async () => {
    callDeps({ ...relayed, artifacts: [] });
    await post(claim, "/api/call/claim", { sessionId: SESSION });
    const response = await askResult();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending" });
  });

  it("will not hand one caller another caller's chart", async () => {
    callDeps();
    await post(claim, "/api/call/claim", { sessionId: SESSION });
    const stranger = {
      cookie: `${CALL_GRANT_COOKIE}=${issueCallGrant("sunrise-family", SECRET, new Date(NOW.getTime() + 1000))}`,
    };
    const refused = await askResult({ sessionId: SESSION }, stranger);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "not_yours" });
  });

  it("will not hand a clinic a record that belongs to another clinic", async () => {
    const deps = callDeps();
    await post(claim, "/api/call/claim", { sessionId: SESSION });
    const { record } = (await (await askResult()).json()) as { record: CallRecord };
    await deps.calls.save({ ...record, clinicId: "another-clinic" });
    expect((await askResult()).status).toBe(404);
  });

  it("asks again for a session the platform has not published yet", async () => {
    const deps = callDeps();
    vi.mocked(deps.voice.getSession).mockRejectedValue(
      new VoiceAgentApiError(404, "session_not_found"),
    );
    await post(claim, "/api/call/claim", { sessionId: SESSION });
    const response = await askResult();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending" });
  });

  it("does not pretend a real failure is a chart that has not arrived yet", async () => {
    const deps = callDeps();
    vi.mocked(deps.voice.getSession).mockRejectedValue(new Error("platform down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await post(claim, "/api/call/claim", { sessionId: SESSION });
    const response = await askResult();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "internal_error" });
  });

  it("refuses another site, no grant, a bad body and too many asks", async () => {
    callDeps(relayed, { resultChecks: new RateLimiter(1, 600_000, () => NOW.getTime()) });
    expect(
      (await askResult({ sessionId: SESSION }, { ...cookie(), "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(403);
    expect((await askResult({ sessionId: SESSION }, {})).status).toBe(401);
    expect((await askResult({ sessionId: SESSION, extra: 1 })).status).toBe(400);
    expect((await askResult()).status).toBe(429);
  });
});
