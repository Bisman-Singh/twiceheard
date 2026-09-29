// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import CallPage, { metadata } from "@/app/call/page";
import { callRecord } from "@/tests/fixtures/record";
import { CallPanel } from "@/components/call/call-panel";
import type { CallResult } from "@/lib/call/result-client";
import type { CallHandle, CallHandlers } from "@/lib/call/session-client";

const startCall = vi.hoisted(() => vi.fn());
vi.mock("@/lib/call/session-client", () => ({ startCall }));
const { claimSession, fetchResult } = vi.hoisted(() => ({
  claimSession: vi.fn<() => Promise<void>>(),
  fetchResult: vi.fn<() => Promise<CallResult>>(),
}));
vi.mock("@/lib/call/result-client", () => ({ claimSession, fetchResult }));

beforeAll(() => {
  // jsdom has no layout, so an element cannot scroll itself.
  Object.defineProperty(Element.prototype, "scrollTo", { value: vi.fn(), writable: true });
});

beforeEach(() => {
  claimSession.mockResolvedValue(undefined);
  fetchResult.mockResolvedValue({ status: "pending" });
});

afterEach(() => {
  vi.resetAllMocks();
});

/** Answers the call and hands back the handlers the panel passed in. */
function connected(end = vi.fn()) {
  let handlers: CallHandlers | undefined;
  startCall.mockImplementation((_clinicId: string, given: CallHandlers) => {
    handlers = given;
    return Promise.resolve({ end });
  });
  return {
    end,
    async say(run: (handlers: CallHandlers) => void) {
      await act(async () => run(handlers as CallHandlers));
    },
  };
}

const panel = () => render(<CallPanel clinicId="sunrise-family" clinicName="Sunrise Family" />);
const button = () => screen.getByRole("button");
const status = () => screen.getByRole("status").textContent ?? "";
const slip = () => within(screen.getByRole("region", { name: "Intake slip" }));

describe("call panel", () => {
  it("starts idle, with the empty call and the empty slip said in words", async () => {
    const { container } = panel();
    expect(status()).toContain("Not connected.");
    expect(button()).toHaveTextContent("Call the clinic");
    expect(button()).toBeEnabled();
    expect(screen.getByText("Nothing said yet.")).toBeInTheDocument();
    expect(slip().getByText("Nothing captured yet.")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows the conversation as it happens, with a partial line replaced by the final one", async () => {
    const call = connected();
    panel();
    await userEvent.click(button());
    expect(startCall).toHaveBeenCalledWith("sunrise-family", expect.any(Object));
    expect(screen.getByText("Waiting for the first words.")).toBeInTheDocument();

    await call.say((h) => h.onPhase("live"));
    expect(status()).toContain("Connected. Speak normally.");
    expect(button()).toHaveTextContent("End the call");

    const said = () => screen.getAllByRole("listitem").map((line) => line.textContent);
    await call.say((h) => {
      h.onLine({ id: "a1", who: "agent", text: "Who am I speaking to?", partial: false });
      h.onLine({ id: "partial", who: "caller", text: "Arjun", partial: true });
    });
    expect(said()).toEqual(["ClinicWho am I speaking to?", "CallerArjun"]);
    // A word still being heard is set apart from one the caller has finished saying.
    expect(screen.getByText("Arjun")).toHaveClass("italic");

    await call.say((h) =>
      h.onLine({ id: "t1", who: "caller", text: "Arjun Mehta", partial: false }),
    );
    expect(said()).toEqual(["ClinicWho am I speaking to?", "CallerArjun Mehta"]);
    expect(screen.getByText("Arjun Mehta")).not.toHaveClass("italic");

    // A line the platform later empties is dropped rather than left blank on screen.
    await call.say((h) => h.onLine({ id: "t1", who: "caller", text: "   ", partial: false }));
    expect(said()).toEqual(["ClinicWho am I speaking to?"]);
  });

  it("writes each field into the slip, and replaces a value when it is confirmed", async () => {
    const call = connected();
    panel();
    await userEvent.click(button());
    await call.say((h) => {
      h.onField({ field: "full_name", value: "Arjun Mehta", status: "heard" });
      h.onField({ field: "allergies", value: "", status: "unresolved" });
      h.onField({ field: "insurer", value: "Star Health", status: "heard" });
      h.onField({ field: "date_of_birth", value: "1990-03-12", status: "heard" });
    });
    expect(slip().getAllByText("read back, waiting")).toHaveLength(3);
    expect(slip().getByText("left for the desk")).toBeInTheDocument();
    // A field the clinic added and the panel has no label for keeps its own name.
    expect(slip().getByText("insurer")).toBeInTheDocument();
    // A date reads as it was spoken, not as it is stored.
    expect(slip().getByText("12 March 1990")).toBeInTheDocument();

    await call.say((h) => {
      h.onField({ field: "full_name", value: "Arjun Mehta", status: "confirmed" });
      h.onBooking("You are booked for Tuesday at 10:30 in the morning.");
    });
    expect(slip().getAllByText("read back, waiting")).toHaveLength(2);
    expect(slip().getByText("confirmed")).toBeInTheDocument();
    expect(slip().getByText(/booked for Tuesday/)).toBeInTheDocument();
  });

  it("hangs up when asked, and offers the call again", async () => {
    const call = connected();
    panel();
    await userEvent.click(button());
    await call.say((h) => h.onPhase("live"));
    await userEvent.click(button());
    expect(call.end).toHaveBeenCalledTimes(1);

    await call.say((h) => h.onPhase("ending"));
    expect(button()).toBeDisabled();
    await call.say((h) => h.onPhase("ended"));
    expect(status()).toContain("Call ended.");
    expect(button()).toHaveTextContent("Call again");
  });

  it("hangs up on its own if the page is left in the middle of a call", async () => {
    const call = connected();
    const view = panel();
    await userEvent.click(button());
    view.unmount();
    expect(call.end).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing to hang up when no call was ever made", () => {
    panel().unmount();
    expect(startCall).not.toHaveBeenCalled();
  });

  it("keeps the button out of reach while the line is still being opened", async () => {
    let answer: (handle: CallHandle) => void = () => undefined;
    startCall.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    panel();
    await userEvent.click(button());
    expect(button()).toBeDisabled();
    expect(status()).toContain("Allow the microphone when your browser asks.");
    await act(async () => answer({ end: vi.fn() }));
  });

  it("says why the call stopped, whichever side gave up", async () => {
    startCall.mockRejectedValueOnce(new Error("The clinic line is not available right now."));
    const view = panel();
    await userEvent.click(button());
    expect(status()).toContain("The clinic line is not available right now.");
    expect(button()).toHaveTextContent("Call the clinic");
    view.unmount();

    startCall.mockRejectedValueOnce("socket gone");
    panel();
    await userEvent.click(button());
    expect(status()).toContain("The call could not start.");
  });

  it("repeats the reason the call itself gives for failing, and clears it on the next try", async () => {
    const call = connected();
    panel();
    await userEvent.click(button());
    await call.say((h) => h.onPhase("failed", "Your browser did not allow the microphone."));
    expect(status()).toContain("Your browser did not allow the microphone.");
    await userEvent.click(button());
    expect(status()).toContain("Connecting.");
  });
});

describe("call page", () => {
  it("tells a visitor what the agent will ask before they start", async () => {
    const { container } = render(<CallPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Call the demo clinic");
    expect(screen.getByText(/read back to you before it is recorded/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("intake line");
    expect(metadata.title).toBe("Call the demo clinic");
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("the chart after the call", () => {
  it("claims the call's session so only this browser can read its chart back", async () => {
    const call = connected();
    panel();
    await userEvent.click(button());
    await call.say((h) => h.onSession("sess_live"));
    expect(claimSession).toHaveBeenCalledWith("sess_live");
  });

  it("says it is listening again while the recording is being checked", async () => {
    const call = connected();
    panel();
    await userEvent.click(button());
    await call.say((h) => h.onSession("sess_live"));
    await call.say((h) => h.onPhase("ended"));
    expect(screen.getByText(/Listening to the recording a second time/)).toBeInTheDocument();
  });

  it("shows what the clinic receives once the chart is ready", async () => {
    fetchResult.mockResolvedValue({
      status: "ready",
      record: callRecord({ full_name: { value: "Arjun Mehta", status: "confirmed" } }),
    });
    const call = connected();
    panel();
    await userEvent.click(button());
    await call.say((h) => h.onSession("sess_live"));
    await call.say((h) => h.onPhase("ended"));
    const chart = await screen.findByRole("region", { name: "Your chart" });
    expect(within(chart).getByText("Arjun Mehta")).toBeInTheDocument();
  });

  it("says plainly when the chart could not be worked out", async () => {
    fetchResult.mockResolvedValue({ status: "unavailable" });
    const call = connected();
    panel();
    await userEvent.click(button());
    await call.say((h) => h.onSession("sess_live"));
    await call.say((h) => h.onPhase("ended"));
    await waitFor(() => expect(screen.getByText(/The chart is not ready yet/)).toBeInTheDocument());
  });
});

describe("deleting the call from the caller's own page", () => {
  const forgetFetch = vi.fn<() => Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal("fetch", forgetFetch);
    forgetFetch.mockResolvedValue({ ok: true } as Response);
    fetchResult.mockResolvedValue({
      status: "ready",
      record: callRecord(
        { full_name: { value: "Arjun Mehta", status: "confirmed" } },
        {},
        { sessionId: "sess_live" },
      ),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const press = (name: string) => userEvent.click(screen.getByRole("button", { name }));
  const chart = () => screen.queryByRole("region", { name: "Your chart" });

  /** Runs a call through to the point where the caller is looking at their chart. */
  async function afterTheChart() {
    const call = connected();
    const view = panel();
    await userEvent.click(button());
    await call.say((h) => h.onSession("sess_live"));
    await call.say((h) => h.onPhase("ended"));
    await screen.findByRole("region", { name: "Your chart" });
    return view;
  }

  it("offers deletion under the chart and says it cannot be undone", async () => {
    const { container } = await afterTheChart();
    expect(screen.getByText(/the clinic desk never sees it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete this call" })).toBeEnabled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("asks the question first, and deletes nothing until it is answered", async () => {
    const { container } = await afterTheChart();
    await press("Delete this call");
    expect(screen.getByText("Delete the chart from this call?")).toBeInTheDocument();
    expect(forgetFetch).not.toHaveBeenCalled();
    expect(chart()).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("puts the offer back, and keeps the chart, when the caller says no", async () => {
    await afterTheChart();
    await press("Delete this call");
    await press("Keep it");
    expect(screen.queryByText("Delete the chart from this call?")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete this call" })).toBeInTheDocument();
    expect(forgetFetch).not.toHaveBeenCalled();
    expect(chart()).toBeInTheDocument();
  });

  it("deletes the call when the caller says yes, and says plainly that it is gone", async () => {
    const { container } = await afterTheChart();
    await press("Delete this call");
    await press("Yes, delete it");
    expect(forgetFetch).toHaveBeenCalledWith("/api/call/forget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "sess_live" }),
    });
    expect(screen.getByText("This call has been deleted")).toBeInTheDocument();
    expect(screen.getByText(/gone from Twiceheard/)).toBeInTheDocument();
    // The chart the caller just deleted is not left on screen behind the message.
    expect(chart()).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("holds both answers out of reach while the deletion is in flight", async () => {
    let finish: (response: Response) => void = () => undefined;
    forgetFetch.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await afterTheChart();
    await press("Delete this call");
    await press("Yes, delete it");
    expect(screen.getByText("Deleting.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes, delete it" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeDisabled();
    await act(async () => finish({ ok: true } as Response));
    expect(screen.getByText("This call has been deleted")).toBeInTheDocument();
  });

  it("says nothing was deleted when the server refuses or the request never lands", async () => {
    forgetFetch.mockResolvedValueOnce({ ok: false } as Response);
    await afterTheChart();
    await press("Delete this call");
    await press("Yes, delete it");
    expect(screen.getByText(/Nothing was deleted/)).toBeInTheDocument();
    expect(chart()).toBeInTheDocument();

    forgetFetch.mockRejectedValueOnce(new Error("offline"));
    await press("Yes, delete it");
    expect(screen.getByText(/Nothing was deleted/)).toBeInTheDocument();
    expect(chart()).toBeInTheDocument();
  });
});
