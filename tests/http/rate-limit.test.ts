import { describe, expect, it } from "vitest";
import { CALL_START_LIMIT, RateLimiter } from "@/lib/http/rate-limit";

describe("RateLimiter", () => {
  it("allows up to the limit inside the window, then refuses", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
    now = 1001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("prunes idle keys on a schedule rather than on every hit", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 10, () => now);
    for (let i = 0; i < 50; i += 1) limiter.allow(`old${i}`);
    now = 100;
    for (let i = 0; i < 49; i += 1) limiter.allow(`new${i}`);
    expect(limiter.size).toBe(99);
    expect(limiter.allow("hundredth")).toBe(true);
    expect(limiter.size).toBe(50);
    expect(limiter.allow("old1")).toBe(true);
  });

  it("caps the number of tracked addresses, evicting idle keys first and then the oldest", () => {
    let now = 0;
    const limiter = new RateLimiter(5, 10, () => now, 3);
    limiter.allow("a");
    limiter.allow("b");
    limiter.allow("c");
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.size).toBe(3);
    // All three are live, so the oldest, "a", makes room for "d".
    expect(limiter.allow("d")).toBe(true);
    expect(limiter.size).toBe(3);
    expect([...Array(5)].map(() => limiter.allow("a"))).toEqual([true, true, true, true, true]);
    // Once the window has passed, the sweep frees space without touching live keys.
    now = 100;
    limiter.allow("e");
    expect(limiter.allow("f")).toBe(true);
    expect(limiter.size).toBe(2);
  });

  it("exposes the browser call-start limit", () => {
    expect(CALL_START_LIMIT).toEqual({ limit: 5, windowMs: 600_000 });
  });
});

describe("RateLimiter.reset", () => {
  it("forgets every hit so a blocked caller is allowed again", () => {
    const limiter = new RateLimiter(1, 60_000, () => 1_000);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    limiter.reset();
    expect(limiter.allow("a")).toBe(true);
  });
});
