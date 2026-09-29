import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import { newIntake } from "@/lib/intake/intake";
import { processSession } from "@/lib/postcall/process";
import { memoryCallStore, type CallRecord, type CallStore } from "@/lib/postcall/record";
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
import { callRecord } from "@/tests/fixtures/record";

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
    async del(key) {
      values.delete(key);
      return 1;
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
    async zrem(key, member) {
      zsets.get(key)?.delete(member);
      return 1;
    },
    async zrange(key, start, stop) {
      const sorted = [...(zsets.get(key) ?? new Map()).entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([member]) => member);
      return sorted.slice(start, stop + 1);
    },
  };
  return { redis, values, zsets };
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

describe("forgetting a call", () => {
  const record = callRecord({ full_name: { value: "Arjun Mehta", status: "confirmed" } });
  const cases: Array<[string, () => CallStore]> = [
    ["over Redis", () => redisCallStore(fakeRedis({ now: 0 }).redis)],
    ["in memory", () => memoryCallStore()],
  ];

  for (const [where, build] of cases) {
    it(`erases the holding clinic's own record and nobody else's, ${where}`, async () => {
      const store = build();
      await store.save({ ...record, sessionId: "mine", processedAt: 3 });
      await store.save({ ...record, sessionId: "kept-newer", processedAt: 2 });
      await store.save({ ...record, sessionId: "kept-older", processedAt: 1 });
      await store.save({ ...record, sessionId: "theirs", clinicId: "other-clinic" });

      expect(await store.remove("sunrise-family", "theirs")).toBe(false);
      expect(await store.get("theirs")).not.toBeNull();
      // A call that was never recorded is nothing to erase, not a failure.
      expect(await store.remove("sunrise-family", "never-happened")).toBe(false);

      expect(await store.remove("sunrise-family", "mine")).toBe(true);
      expect(await store.get("mine")).toBeNull();
      // Asked twice, the second ask finds nothing left and says so without complaint.
      expect(await store.remove("sunrise-family", "mine")).toBe(false);
      // Every other call the clinic holds is untouched, and still in order.
      expect((await store.list("sunrise-family", 10)).map((call) => call.sessionId)).toEqual([
        "kept-newer",
        "kept-older",
      ]);
    });
  }

  it("takes the id out of the clinic's index too, so the desk's pages do not repeat a row", async () => {
    const { redis, zsets } = fakeRedis({ now: 0 });
    const store = redisCallStore(redis);
    await store.save({ ...record, sessionId: "older", processedAt: 1 });
    await store.save({ ...record, sessionId: "newer", processedAt: 2 });

    expect(await store.remove("sunrise-family", "newer")).toBe(true);
    expect([...(zsets.get("twiceheard:calls:sunrise-family") ?? []).keys()]).toEqual(["older"]);
    // One call is left, so page one holds it and page two is empty. An index entry
    // with no record behind it would push the older call onto both pages.
    expect((await store.list("sunrise-family", 1)).map((call) => call.sessionId)).toEqual([
      "older",
    ]);
    expect(await store.list("sunrise-family", 1, 1)).toEqual([]);
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
