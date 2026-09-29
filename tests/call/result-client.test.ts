import { afterEach, describe, expect, it, vi } from "vitest";
import { claimSession, fetchResult } from "@/lib/call/result-client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe("result client", () => {
  it("claims the session as soon as the call has one", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await claimSession("sess_1");
    expect(fetchMock).toHaveBeenCalledWith("/api/call/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "sess_1" }),
    });
  });

  it("passes on what the server says about the chart", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: "pending" }) });
    expect(await fetchResult("sess_1")).toEqual({ status: "pending" });
  });

  it("treats a refusal as the chart being unavailable rather than throwing at the page", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "rate_limited" }) });
    expect(await fetchResult("sess_1")).toEqual({ status: "unavailable" });
  });
});
