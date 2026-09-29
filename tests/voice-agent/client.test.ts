import { describe, expect, it, vi } from "vitest";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import { agentBody } from "@/lib/voice-agent/agent";
import {
  AGENTS_BASE_URL,
  PHONE_BASE_URL,
  VoiceAgentApiError,
  createVoiceAgentClient,
  type FetchLike,
} from "@/lib/voice-agent/client";

const KEY = "test-key-not-real";

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn<FetchLike>(async (url, init = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  });
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createVoiceAgentClient", () => {
  it("refuses to start without a key", () => {
    expect(() => createVoiceAgentClient("")).toThrow(/ASSEMBLYAI_API_KEY/);
  });

  it("mints a token with bearer auth, clamping the durations into the allowed ranges", async () => {
    const { impl, calls } = fakeFetch(() => json({ token: "tok", expires_in_seconds: 60 }));
    const client = createVoiceAgentClient(KEY, impl);
    expect(await client.mintToken({ expiresInSeconds: 9999, maxSessionSeconds: 5 })).toBe("tok");
    const call = calls[0];
    expect(call?.url).toBe(
      `${AGENTS_BASE_URL}/v1/token?expires_in_seconds=600&max_session_duration_seconds=60`,
    );
    expect((call?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("creates and updates stored agents", async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ id: "agent-1", name: "twiceheard-sunrise-family" }),
    );
    const client = createVoiceAgentClient(KEY, impl);
    const body = agentBody(DEMO_CLINIC, {
      baseUrl: "https://twiceheard.example",
      toolKey: "secret",
    });
    expect(await client.createAgent(body)).toEqual({
      id: "agent-1",
      name: "twiceheard-sunrise-family",
    });
    await client.updateAgent("agent/1", { greeting: "Hi" });
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body)).tools).toHaveLength(7);
    expect(calls[1]?.url).toBe(`${PHONE_BASE_URL}/v1/agents/agent%2F1`);
    // Both live on the regional host. An agent created elsewhere cannot be bound to a number.
    expect(calls[0]?.url).toBe(`${PHONE_BASE_URL}/v1/agents`);
    expect(calls[1]?.init.method).toBe("PUT");
  });

  it("reads a session with its artifacts", async () => {
    const { impl } = fakeFetch(() =>
      json({
        id: "sess_1",
        agent_id: null,
        status: "completed",
        duration_seconds: 63.1,
        artifacts: [
          { type: "audio", url: "https://files.example/a.ogg", content_type: "audio/ogg" },
        ],
      }),
    );
    const session = await createVoiceAgentClient(KEY, impl).getSession("sess_1");
    expect(session.artifacts[0]?.type).toBe("audio");
  });

  it("imports and binds a phone number on the phone host, with an idempotency key", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createVoiceAgentClient(KEY, impl);
    await client.importPhoneNumber("+14155550123", "twiceheard.pstn.twilio.com", "idem-1");
    await client.bindPhoneNumber("+14155550123", "agent-1");
    expect(calls[0]?.url).toBe(`${PHONE_BASE_URL}/v1/phone-numbers/import`);
    expect((calls[0]?.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      phone_number: "+14155550123",
      termination_uri: "twiceheard.pstn.twilio.com",
    });
    expect(calls[1]?.url).toBe(`${PHONE_BASE_URL}/v1/phone-numbers/%2B14155550123/agent`);
  });

  it("raises the status and the platform's code, never the key or the body", async () => {
    const cases: Array<[Response, string]> = [
      [
        json({ code: "invalid_config", message: "tools[0].http.url must be https" }, 422),
        "invalid_config",
      ],
      [json({ error: "Unauthorized" }, 401), "Unauthorized"],
      [new Response("<html>bad gateway</html>", { status: 502 }), "error"],
      [json({ unexpected: true }, 500), "error"],
    ];
    for (const [response, code] of cases) {
      const { impl } = fakeFetch(() => response);
      const error = await createVoiceAgentClient(KEY, impl)
        .mintToken({ expiresInSeconds: 60, maxSessionSeconds: 300 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VoiceAgentApiError);
      expect((error as VoiceAgentApiError).code).toBe(code);
      expect(String(error)).not.toContain(KEY);
    }
  });

  it("rejects a success response that does not match the expected shape", async () => {
    const { impl } = fakeFetch(() => json({ nope: true }));
    await expect(
      createVoiceAgentClient(KEY, impl).mintToken({ expiresInSeconds: 60, maxSessionSeconds: 300 }),
    ).rejects.toThrow();
  });
});
