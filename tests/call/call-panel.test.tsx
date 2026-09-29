// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import CallPage, { metadata } from "@/app/call/page";
import { CallPanel } from "@/components/call/call-panel";
import type { CallHandle, CallHandlers } from "@/lib/call/session-client";

const startCall = vi.hoisted(() => vi.fn());
vi.mock("@/lib/call/session-client", () => ({ startCall }));

beforeAll(() => {
  // jsdom has no layout, so an element cannot scroll itself.
  Object.defineProperty(Element.prototype, "scrollTo", { value: vi.fn(), writable: true });
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
    });
    expect(slip().getAllByText("read back, waiting")).toHaveLength(2);
    expect(slip().getByText("left for the desk")).toBeInTheDocument();
    // A field the clinic added and the panel has no label for keeps its own name.
    expect(slip().getByText("insurer")).toBeInTheDocument();

    await call.say((h) => {
      h.onField({ field: "full_name", value: "Arjun Mehta", status: "confirmed" });
      h.onBooking("You are booked for Tuesday at 10:30 in the morning.");
    });
    expect(slip().getAllByText("read back, waiting")).toHaveLength(1);
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
