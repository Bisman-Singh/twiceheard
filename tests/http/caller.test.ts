import { describe, expect, it } from "vitest";
import { LIVE_CLAIM_WINDOW_MS, claimIsLive } from "@/lib/http/caller";

const START = Date.parse("2026-09-14T12:01:05Z");
const MINE = { owner: "browser-a", at: START + 20_000 };

describe("claimIsLive", () => {
  it("accepts the claim the browser made while its own call was running", () => {
    expect(claimIsLive(MINE, "browser-a", START)).toBe(true);
    // A claim a moment ahead of the call's own start is still that call's: two
    // machines, two clocks.
    expect(claimIsLive({ owner: "browser-a", at: START - 20_000 }, "browser-a", START)).toBe(true);
  });

  it("refuses a claim made long after the call it names", () => {
    // This is the whole point: a session id is not a secret, so a stranger who
    // learns one must not be able to claim the call and read the chart.
    expect(
      claimIsLive({ owner: "browser-b", at: START + LIVE_CLAIM_WINDOW_MS + 1 }, "browser-b", START),
    ).toBe(false);
    expect(claimIsLive({ owner: "browser-a", at: START - 60_000 }, "browser-a", START)).toBe(false);
  });

  it("refuses when nobody claimed it, when someone else did, and when the call has no start", () => {
    expect(claimIsLive(null, "browser-a", START)).toBe(false);
    expect(claimIsLive(MINE, "browser-b", START)).toBe(false);
    // A call the platform never dated cannot be checked against its own lifetime.
    expect(claimIsLive(MINE, "browser-a", null)).toBe(false);
  });
});
