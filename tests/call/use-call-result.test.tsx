// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIVE_UP_AFTER_MS, POLL_EVERY_MS, useCallResult } from "@/components/call/use-call-result";
import type { CallResult } from "@/lib/call/result-client";
import { callRecord } from "@/tests/fixtures/record";

const fetchResult = vi.hoisted(() => vi.fn());
vi.mock("@/lib/call/result-client", () => ({ fetchResult }));

const record = callRecord({ full_name: { value: "Arjun Mehta", status: "confirmed" } });
const answers = (...results: CallResult[]) => {
  for (const result of results) fetchResult.mockResolvedValueOnce(result);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("waiting for the chart of the call that just ended", () => {
  it("asks for nothing until a call has ended", () => {
    const { result } = renderHook(() => useCallResult("sess_1", "live"));
    expect(result.current.status).toBe("none");
    expect(fetchResult).not.toHaveBeenCalled();
  });

  it("waits while the recording is still being attached, then shows the chart", async () => {
    answers({ status: "pending" }, { status: "ready", record });
    const { result } = renderHook(() => useCallResult("sess_1", "ended"));
    expect(result.current.status).toBe("waiting");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.record?.sessionId).toBe("sess_fixture");
    expect(fetchResult).toHaveBeenCalledTimes(2);
  });

  it("says the chart is unavailable when the server refuses", async () => {
    answers({ status: "unavailable" });
    const { result } = renderHook(() => useCallResult("sess_1", "ended"));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("gives up rather than asking forever", async () => {
    fetchResult.mockResolvedValue({ status: "pending" });
    const { result } = renderHook(() => useCallResult("sess_1", "ended"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + POLL_EVERY_MS);
    });
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("stops asking when the page moves on", async () => {
    fetchResult.mockResolvedValue({ status: "pending" });
    const { unmount } = renderHook(() => useCallResult("sess_1", "ended"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    });
    unmount();
    const asked = fetchResult.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_EVERY_MS * 3);
    });
    expect(fetchResult).toHaveBeenCalledTimes(asked);
  });

  it("drops an answer that arrives after the page has moved on", async () => {
    let answer: (result: CallResult) => void = () => undefined;
    fetchResult.mockReturnValue(new Promise<CallResult>((resolve) => (answer = resolve)));
    const { result, unmount } = renderHook(() => useCallResult("sess_1", "ended"));
    unmount();
    await act(async () => answer({ status: "ready", record }));
    expect(result.current.status).toBe("waiting");
  });

  it("never shows the chart of an earlier call beside a later one", async () => {
    answers({ status: "ready", record });
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useCallResult(id, "ended"),
      { initialProps: { id: "sess_1" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    fetchResult.mockResolvedValue({ status: "pending" });
    rerender({ id: "sess_2" });
    expect(result.current.status).toBe("waiting");
    expect(result.current.record).toBeUndefined();
  });
});
