import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import { newIntake } from "@/lib/intake/intake";
import { processSession } from "@/lib/postcall/process";
import { memoryCallStore, type CallRecord } from "@/lib/postcall/record";
import {
  memoryFirstDelivery,
  memorySessionOwner,
  redisCallStore,
  redisFirstDelivery,
  redisIntakeStore,
  redisSessionOwner,
  type ClaimSession,
  type RedisLike,
} from "@/lib/store/redis";

/** An in-memory stand-in that behaves like Redis for the commands the stores use, including NX and expiry. */
function fakeRedis(clock: { now: number }) {
  const values = new Map<string, { value: string; expiresAt: number | null }>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const alive = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= clock.now) values.delete(key);
    return values.get(key);
  };
  const redis: RedisLike = {
    async get<T>(key: string) {
      const entry = alive(key);
      return entry ? (JSON.parse(entry.value) as T) : null;
    },
    async set(key, value, options = {}) {
      if (options.nx && alive(key)) return null;
      values.set(key, {
        value: JSON.stringify(value),
        expiresAt: options.px ? clock.now + options.px : null,
      });
      return "OK";
    },
    async sadd(key, member) {
      const set = sets.get(key) ?? new Set();
      set.add(member);
      sets.set(key, set);
      return 1;
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async zadd(key, { score, member }) {
      const zset = zsets.get(key) ?? new Map();
      zset.set(member, score);
      zsets.set(key, zset);
      return 1;
    },
    async zrange(key, start, stop) {
      const sorted = [...(zsets.get(key) ?? new Map()).entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([member]) => member);
      return sorted.slice(start, stop + 1);
    },
  };
  return { redis, values };
}

describe("redisIntakeStore", () => {
  it("creates an intake once, saves changes and lets it expire", async () => {
    const clock = { now: 0 };
    const { redis } = fakeRedis(clock);
    const store = redisIntakeStore(redis);
    const intake = newIntake("K7F2Q9", "sunrise-family", new Date(0));
    expect(await store.create(intake)).toBe(true);
    expect(await store.create(intake)).toBe(false);
    await store.save({ ...intake, finishedAt: 42 });
    expect((await store.get("K7F2Q9"))?.finishedAt).toBe(42);
    clock.now = 6 * 60 * 60 * 1000 + 1;
    expect(await store.get("K7F2Q9")).toBeNull();
  });

  it("claims a slot atomically, lets the holder claim again, and lists taken times per clinic", async () => {
    const { redis } = fakeRedis({ now: 0 });
    const store = redisIntakeStore(redis);
    expect(await store.claimSlot("sunrise-family", "dr-iyer_20260915T0940", "K7F2Q9")).toBe(true);
    expect(await store.claimSlot("sunrise-family", "dr-iyer_20260915T0940", "K7F2Q9")).toBe(true);
    expect(await store.claimSlot("sunrise-family", "dr-iyer_20260915T0940", "M3N4P5")).toBe(false);
    expect(await store.takenSlots("sunrise-family")).toEqual(new Set(["dr-iyer_20260915T0940"]));
    expect(await store.takenSlots("another-clinic")).toEqual(new Set());
  });
});

describe("redisCallStore", () => {
  it("stores records and lists a clinic's newest first, skipping any that have gone", async () => {
    const timeline = JSON.parse(readFileSync("tests/fixtures/timeline.json", "utf8"));
    const base = (await processSession("sess_fixture", {
      getSession: async () => ({
        id: "sess_fixture",
        agent_id: "a",
        status: "completed",
        artifacts: [{ type: "timeline", url: "https://x.example/t" }],
      }),
      clinicForAgent: () => DEMO_CLINIC,
      fetchJson: async () => timeline,
      hearing: { transcribe: async () => ({ caller: [], agent: [] }) },
      calls: memoryCallStore(),
      now: () => new Date(0),
    })) as CallRecord;
    const { redis, values } = fakeRedis({ now: 0 });
    const store = redisCallStore(redis);
    await store.save({ ...base, sessionId: "old", processedAt: 1 });
    await store.save({ ...base, sessionId: "new", processedAt: 2 });
    await store.save({ ...base, sessionId: "gone", processedAt: 3 });
    await store.save({ ...base, sessionId: "elsewhere", clinicId: "other", processedAt: 4 });
    values.delete("twiceheard:call:gone");
    expect((await store.list("sunrise-family", 10)).map((record) => record.sessionId)).toEqual([
      "new",
      "old",
    ]);
    expect((await store.list("sunrise-family", 1)).map((record) => record.sessionId)).toEqual([
      "new",
    ]);
    expect((await store.list("sunrise-family", 2)).map((record) => record.sessionId)).toEqual([
      "new",
      "old",
    ]);
    expect(await store.list("sunrise-family", 0)).toEqual([]);
    expect((await store.get("new"))?.processedAt).toBe(2);
    expect(await store.get("missing")).toBeNull();
  });
});

describe("first delivery", () => {
  it("accepts a webhook delivery once and every retry after is a duplicate, in Redis and in memory", async () => {
    const { redis } = fakeRedis({ now: 0 });
    for (const firstDelivery of [redisFirstDelivery(redis), memoryFirstDelivery()]) {
      expect(await firstDelivery("evt_1")).toBe(true);
      expect(await firstDelivery("evt_1")).toBe(false);
      expect(await firstDelivery("evt_2")).toBe(true);
    }
  });
});

describe("who owns a call", () => {
  const cases: Array<[string, (clock: { now: number }) => ClaimSession]> = [
    ["over Redis", (clock) => redisSessionOwner(fakeRedis(clock).redis)],
    ["in memory", () => memorySessionOwner()],
  ];

  for (const [where, build] of cases) {
    it(`gives the call to the first browser that claims it, ${where}`, async () => {
      const clock = { now: Date.parse("2026-09-29T06:00:00Z") };
      const claim = build(clock);
      expect(await claim("sess_1", "browser-a")).toBe(true);
      // The same browser may claim again, which is what makes polling for the chart safe.
      expect(await claim("sess_1", "browser-a")).toBe(true);
      expect(await claim("sess_1", "browser-b")).toBe(false);
      expect(await claim("sess_2", "browser-b")).toBe(true);
    });
  }

  it("lets go of a call an hour after it was claimed", async () => {
    const clock = { now: Date.parse("2026-09-29T06:00:00Z") };
    const claim = redisSessionOwner(fakeRedis(clock).redis);
    expect(await claim("sess_1", "browser-a")).toBe(true);
    clock.now += 61 * 60 * 1000;
    expect(await claim("sess_1", "browser-b")).toBe(true);
  });
});
