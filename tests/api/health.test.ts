import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";
import { setServerDeps } from "@/lib/server/deps";
import { NOW, SECRET, testDeps } from "@/tests/api/helpers";

/** Deliberately recognisable, so a leak into the response would be obvious. */
const REDIS = { url: "https://kv.example.upstash.io", token: "redis-token-abcdef" };

/** Everything the deployment holds that must never reach an anonymous reader. */
const NEVER_ON_THE_WIRE = [
  REDIS.url,
  REDIS.token,
  SECRET,
  "test-key",
  "agent-sunrise",
  "upstash",
  "ASSEMBLYAI",
  "TWICEHEARD",
];

afterEach(() => {
  setServerDeps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("reports a ready instance that keeps its stores in its own memory", async () => {
    setServerDeps(testDeps());
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      environment: "loaded",
      stores: "in-process",
      time: NOW.toISOString(),
    });
    // The four fields are the whole answer; anything else would be a new decision.
    expect(Object.keys(body).sort()).toEqual(["environment", "status", "stores", "time"]);
  });

  it("says the stores are shared when Redis is configured, and names nothing about it", async () => {
    const deps = testDeps();
    setServerDeps({ ...deps, env: { ...deps.env, redis: REDIS } });
    const response = GET();
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(JSON.parse(raw)).toMatchObject({ status: "ok", stores: "shared" });
    for (const value of NEVER_ON_THE_WIRE) expect(raw).not.toContain(value);
  });

  it("answers rather than crashing when the environment cannot be read", async () => {
    setServerDeps(null);
    for (const name of ["ASSEMBLYAI_API_KEY", "TWICEHEARD_SECRET", "TWICEHEARD_WEBHOOK_SECRET"]) {
      vi.stubEnv(name, "");
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const raw = await response.text();
    const body = JSON.parse(raw);
    expect(body).toMatchObject({
      status: "degraded",
      environment: "unreadable",
      stores: "unknown",
    });
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
    // The environment error lists the variables it is unhappy about. None of
    // that reaches the reader, and none of it reaches the log line either.
    for (const value of NEVER_ON_THE_WIRE) expect(raw).not.toContain(value);
    expect(logged.mock.calls).toEqual([["health check could not read the environment"]]);
  });
});
