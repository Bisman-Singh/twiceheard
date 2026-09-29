import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import { demoRegistry, staticRegistry } from "@/lib/clinic/registry";
import { RateLimiter } from "@/lib/http/rate-limit";
import { SharedRateLimiter } from "@/lib/http/shared-rate-limit";
import { ArtifactsNotReady } from "@/lib/postcall/process";
import {
  MAX_ARTIFACT_BYTES,
  RETRY_DELAYS_MS,
  fetchArtifact,
  postCallDeps,
  processWithRetry,
} from "@/lib/postcall/run";
import { buildDeps, serverDeps, setServerDeps } from "@/lib/server/deps";
import { EnvError, readEnv } from "@/lib/server/env";
import { testDeps } from "@/tests/api/helpers";

const base = {
  ASSEMBLYAI_API_KEY: "key",
  TWICEHEARD_SECRET: "s".repeat(32),
  TWICEHEARD_WEBHOOK_SECRET: "w".repeat(32),
};

afterEach(() => {
  setServerDeps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readEnv", () => {
  it("reads the required secrets and treats Redis as optional under either naming", () => {
    expect(readEnv(base)).toEqual({
      assemblyAiKey: "key",
      secret: "s".repeat(32),
      webhookSecret: "w".repeat(32),
      agentId: undefined,
      redis: null,
    });
    const vercel = readEnv({
      ...base,
      KV_REST_API_URL: "https://kv.example.upstash.io",
      KV_REST_API_TOKEN: "t",
    });
    expect(vercel.redis).toEqual({ url: "https://kv.example.upstash.io", token: "t" });
    const upstash = readEnv({
      ...base,
      UPSTASH_REDIS_REST_URL: "https://u.example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "u",
      TWICEHEARD_AGENT_ID: "agent-1",
    });
    expect(upstash).toMatchObject({
      redis: { url: "https://u.example.upstash.io", token: "u" },
      agentId: "agent-1",
    });
    expect(
      readEnv({
        ...base,
        KV_REST_API_URL: "https://kv.example.upstash.io",
        TWICEHEARD_AGENT_ID: "",
      }).redis,
    ).toBeNull();
  });

  it("names the variable that is missing or too short, never its value", () => {
    expect(() => readEnv({ ...base, TWICEHEARD_SECRET: "short" })).toThrow(EnvError);
    expect(() => readEnv({ ...base, TWICEHEARD_SECRET: "short" })).toThrow(/TWICEHEARD_SECRET/);
    expect(() => readEnv({ TWICEHEARD_SECRET: "s".repeat(32) })).toThrow(/ASSEMBLYAI_API_KEY/);
    expect(() => readEnv({ ...base, KV_REST_API_URL: "not a url" })).toThrow(/KV_REST_API_URL/);
  });
});

describe("registries", () => {
  it("finds a clinic by id and by its agent, and nothing else", () => {
    const registry = demoRegistry("agent-sunrise");
    expect(registry.byId("sunrise-family")).toBe(DEMO_CLINIC);
    expect(registry.byId("other")).toBeNull();
    expect(registry.forAgent("agent-sunrise")).toBe(DEMO_CLINIC);
    expect(registry.forAgent("agent-other")).toBeNull();
    expect(registry.forAgent(null)).toBeNull();
    expect(registry.agentFor("sunrise-family")).toBe("agent-sunrise");
    expect(registry.agentFor("other")).toBeNull();
    const noAgent = staticRegistry([{ clinic: DEMO_CLINIC, agentId: null }]);
    expect(noAgent.agentFor("sunrise-family")).toBeNull();
    expect(noAgent.forAgent("anything")).toBeNull();
  });
});

describe("server deps", () => {
  it("builds memory stores without Redis and shared ones with it", () => {
    const local = buildDeps(readEnv(base));
    expect(local.callStarts).toBeInstanceOf(RateLimiter);
    expect(local.now()).toBeInstanceOf(Date);
    const shared = buildDeps(
      readEnv({
        ...base,
        KV_REST_API_URL: "https://kv.example.upstash.io",
        KV_REST_API_TOKEN: "t",
      }),
    );
    expect(shared.callStarts).toBeInstanceOf(SharedRateLimiter);
  });

  it("builds once from the process environment and can be replaced for tests", () => {
    for (const [name, value] of Object.entries(base)) vi.stubEnv(name, value);
    const first = serverDeps();
    expect(serverDeps()).toBe(first);
    const replaced = testDeps();
    setServerDeps(replaced);
    expect(serverDeps()).toBe(replaced);
  });
});

describe("processWithRetry", () => {
  const deps = () => postCallDeps(testDeps());

  it("waits and retries while the recording is not attached, then gives up quietly", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => void delays.push(ms));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = {
      ...deps(),
      getSession: vi.fn(async () => ({
        id: "s",
        agent_id: "agent-sunrise",
        status: "completed",
        artifacts: [],
      })),
    };
    expect(await processWithRetry("s", d, sleep)).toBeNull();
    expect(delays).toEqual([...RETRY_DELAYS_MS]);
    expect(d.getSession).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith("post-call processing failed", {
      sessionId: "s",
      attempt: 3,
      kind: "ArtifactsNotReady",
    });
  });

  it("returns the record once it can be processed, and does not retry other failures", async () => {
    const sleep = vi.fn(async () => undefined);
    const ignored = {
      ...deps(),
      clinicForAgent: () => null,
      getSession: vi.fn(async () => ({
        id: "s",
        agent_id: null,
        status: "completed",
        artifacts: [],
      })),
    };
    expect(await processWithRetry("s", ignored, sleep)).toBeNull();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = {
      ...deps(),
      getSession: vi.fn(async () => Promise.reject("not an error object")),
    };
    expect(await processWithRetry("s", broken, sleep)).toBeNull();
    expect(broken.getSession).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ kind: "unknown" });
    expect(sleep).not.toHaveBeenCalled();
    expect(new ArtifactsNotReady().name).toBe("ArtifactsNotReady");
  });

  it("uses the real timer by default", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const d = {
        ...deps(),
        clinicForAgent: () => null,
        getSession: vi.fn(async () => {
          calls += 1;
          return { id: "s", agent_id: null, status: "completed", artifacts: [] };
        }),
      };
      d.getSession.mockImplementationOnce(async () => {
        calls += 1;
        throw new ArtifactsNotReady();
      });
      const pending = processWithRetry("s", d);
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
      expect(await pending).toBeNull();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("postCallDeps and fetchArtifact", () => {
  it("wires the shared dependencies and fetches artifacts with a deadline and a size cap", async () => {
    const shared = testDeps();
    vi.mocked(shared.voice.getSession).mockResolvedValue({
      id: "s",
      agent_id: "agent-sunrise",
      status: "completed",
      artifacts: [],
    });
    const fetchImpl = vi.fn(async () => new Response('{"ok":1}')) as unknown as typeof fetch;
    const wired = postCallDeps(shared, fetchImpl);
    expect((await wired.getSession("s")).id).toBe("s");
    expect(wired.clinicForAgent("agent-sunrise")).toBe(DEMO_CLINIC);
    expect(await wired.fetchJson("https://recordings.example/t.json")).toEqual({ ok: 1 });
    expect(wired.calls).toBe(shared.calls);
    expect(wired.now()).toEqual(shared.now());

    const failing = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchArtifact("https://x.example", failing)).rejects.toMatchObject({
      code: "artifact_unavailable",
    });
    const huge = vi.fn(
      async () => new Response("x".repeat(MAX_ARTIFACT_BYTES + 1)),
    ) as unknown as typeof fetch;
    await expect(fetchArtifact("https://x.example", huge)).rejects.toMatchObject({
      code: "artifact_too_large",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]")),
    );
    expect(await postCallDeps(shared).fetchJson("https://x.example")).toEqual([]);
    expect(await fetchArtifact("https://x.example")).toEqual([]);
    vi.unstubAllGlobals();
  });
});
