// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clinic } from "@/lib/clinic/config";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import { setServerDeps } from "@/lib/server/deps";
import { callRecord } from "@/tests/fixtures/record";
import { testDeps } from "@/tests/api/helpers";

const signedIn = vi.hoisted(() => ({ clinic: null as Clinic | null }));
vi.mock("@/lib/desk/session", () => ({
  signedInClinic: async () => signedIn.clinic,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: navigation.notFound, redirect: vi.fn() }));

const DeskPage = (await import("@/app/desk/page")).default;
const CallPage = (await import("@/app/desk/calls/[sessionId]/page")).default;

const record = (overrides = {}) =>
  callRecord({ full_name: { value: "Arjun Mehta", status: "confirmed" } }, {}, overrides);

afterEach(() => {
  signedIn.clinic = null;
  setServerDeps(null);
  vi.clearAllMocks();
});

const openDesk = async (page = 0) =>
  render(await DeskPage({ searchParams: Promise.resolve({ page: String(page) }) }));

describe("the desk before anyone signs in", () => {
  it("asks for the clinic code and shows no calls at all", async () => {
    setServerDeps(testDeps());
    const { container } = await openDesk();
    expect(screen.getByLabelText("Clinic code")).toBeInTheDocument();
    expect(screen.queryByText(/Finished calls/)).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("the desk once a clinic is signed in", () => {
  it("lists that clinic's calls, newest first, with the counts that decide a call back", async () => {
    signedIn.clinic = DEMO_CLINIC;
    const deps = testDeps();
    await deps.calls.save(record({ sessionId: "sess_old", processedAt: 1 }));
    await deps.calls.save(
      record({
        sessionId: "sess_new",
        processedAt: 2,
        booking: { slotId: "s1", spoken: "Tuesday at 10:30" },
      }),
    );
    setServerDeps(deps);
    const { container } = await openDesk();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("Arjun Mehta")).toBeInTheDocument();
    expect(items[0]?.textContent).toContain("booked");
    expect(items[0]?.querySelector("a")).toHaveAttribute("href", "/desk/calls/sess_new");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(DEMO_CLINIC.name);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says so plainly when the clinic has had no calls yet, with no page asked for", async () => {
    signedIn.clinic = DEMO_CLINIC;
    setServerDeps(testDeps());
    render(await DeskPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/No calls yet/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Older calls" })).not.toBeInTheDocument();
  });

  it("treats a nonsense page in the address as the first page", async () => {
    signedIn.clinic = DEMO_CLINIC;
    const deps = testDeps();
    await deps.calls.save(record({ sessionId: "sess_1" }));
    setServerDeps(deps);
    render(await DeskPage({ searchParams: Promise.resolve({ page: "banana" }) }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("writes each call's outcome in words, including the ones that did not go well", async () => {
    signedIn.clinic = DEMO_CLINIC;
    const deps = testDeps();
    await deps.calls.save(
      callRecord(
        {},
        {},
        {
          sessionId: "sess_bad",
          hearing: "unavailable",
          escalation: { reason: "chest pain", urgent: true },
        },
      ),
    );
    setServerDeps(deps);
    await openDesk();
    const line = screen.getByRole("listitem");
    expect(line).toHaveTextContent("Name not captured");
    expect(line).toHaveTextContent("handed to a person");
    expect(line).toHaveTextContent("heard once only");
    // Nothing was verified on that call, so no verified count is printed at all.
    expect(line).not.toHaveTextContent("verified");
  });

  it("offers older calls only when there are more than one page of them", async () => {
    signedIn.clinic = DEMO_CLINIC;
    const deps = testDeps();
    for (let i = 0; i < 26; i += 1) {
      await deps.calls.save(record({ sessionId: `sess_${i}`, processedAt: i }));
    }
    setServerDeps(deps);
    const first = await openDesk();
    expect(screen.getAllByRole("listitem")).toHaveLength(25);
    expect(screen.getByRole("link", { name: "Older calls" })).toHaveAttribute(
      "href",
      "/desk?page=1",
    );
    expect(screen.queryByRole("link", { name: "Newer calls" })).not.toBeInTheDocument();
    first.unmount();

    await openDesk(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Newer calls" })).toHaveAttribute(
      "href",
      "/desk?page=0",
    );
  });
});

describe("one call at the desk", () => {
  const open = (sessionId: string) => CallPage({ params: Promise.resolve({ sessionId }) });

  it("shows the graded chart and how the call went", async () => {
    signedIn.clinic = DEMO_CLINIC;
    const deps = testDeps();
    await deps.calls.save(record({ sessionId: "sess_1" }));
    setServerDeps(deps);
    const { container } = render(await open("sess_1"));
    expect(screen.getByRole("region", { name: "Your chart" })).toBeInTheDocument();
    expect(screen.getByText("Arjun Mehta")).toBeInTheDocument();
    expect(screen.getByText("sess_1")).toBeInTheDocument();
    expect(screen.getByText(/needs a person before the visit/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says when a call needs nobody, and when the platform reported no timings", async () => {
    signedIn.clinic = DEMO_CLINIC;
    const deps = testDeps();
    const complete = callRecord(
      {
        full_name: { value: "Arjun Mehta", status: "confirmed" },
        date_of_birth: { value: "1990-03-12", status: "confirmed" },
        phone: { value: "+919812345678", status: "confirmed" },
        reason_for_visit: { value: "fever", status: "heard" },
        medications: { value: [], status: "confirmed" },
        allergies: { value: [], status: "confirmed" },
        preferred_time: { value: "morning", status: "heard" },
      },
      {},
      {
        sessionId: "sess_ok",
        durationSeconds: null,
        latency: { firstAudioMs: [], p50: null, p95: null },
      },
    );
    await deps.calls.save(complete);
    setServerDeps(deps);
    render(await open("sess_ok"));
    expect(screen.getByText(/Every critical field is verified/)).toBeInTheDocument();
    expect(screen.getByText(/Length not recorded/)).toBeInTheDocument();
    expect(screen.getAllByText("not measured")).toHaveLength(2);
  });

  it("will not show a call to a desk that is not signed in", async () => {
    setServerDeps(testDeps());
    await expect(open("sess_1")).rejects.toThrow("NOT_FOUND");
  });

  it("will not show one clinic's call to another clinic, or a call that does not exist", async () => {
    signedIn.clinic = DEMO_CLINIC;
    const deps = testDeps();
    await deps.calls.save(record({ sessionId: "sess_1", clinicId: "harbour-road" }));
    setServerDeps(deps);
    await expect(open("sess_1")).rejects.toThrow("NOT_FOUND");
    await expect(open("sess_missing")).rejects.toThrow("NOT_FOUND");
  });
});
