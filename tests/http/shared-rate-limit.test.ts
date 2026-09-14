import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import { SharedRateLimiter, createSharedRateLimiter } from "@/lib/http/shared-rate-limit";

afterEach(() => vi.restoreAllMocks());

describe("SharedRateLimiter", () => {
  it("reports the shared verdict for the key", async () => {
    const limit = vi.fn(async (key: string) => ({ success: key === "ok" }));
    const limiter = new SharedRateLimiter({ limit });
    expect(await limiter.allow("ok")).toBe(true);
    expect(await limiter.allow("blocked")).toBe(false);
    expect(limit).toHaveBeenCalledWith("ok");
    limiter.reset();
  });

  it("lets the request through when the store cannot be reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const limiter = new SharedRateLimiter({
      limit: async () => Promise.reject(new Error("offline")),
    });
    expect(await limiter.allow("anyone")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("builds a sliding-window limiter over a Redis client", () => {
    const limiter = createSharedRateLimiter({} as unknown as Redis, 10, 60_000);
    expect(limiter).toBeInstanceOf(SharedRateLimiter);
  });
});
