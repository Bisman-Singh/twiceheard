// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { describe, expect, it } from "vitest";
import { VerifiedChart } from "@/components/call/verified-chart";
import { callRecord } from "@/tests/fixtures/record";

const sure = { hearing: "agrees", minConfidence: 0.95 } as const;

/** The ruled row for one field, found by its label. */
const row = (label: string) => within(screen.getByText(label).closest("div") as HTMLElement);

describe("the chart a caller is shown", () => {
  it("grades each answer and gives the reason for anything short of verified", async () => {
    const { container } = render(
      <VerifiedChart
        record={callRecord(
          {
            full_name: { value: "Arjun Mehta", status: "confirmed" },
            date_of_birth: { value: "1990-03-12", status: "confirmed" },
            phone: { value: "+919812345678", status: "heard" },
            allergies: { value: [], status: "confirmed" },
            medications: { value: ["Metformin", "Amlodipine"], status: "confirmed" },
          },
          {
            full_name: sure,
            allergies: sure,
            medications: { hearing: "differs", minConfidence: 0.9 },
          },
        )}
      />,
    );

    expect(row("Full name").getByText("Arjun Mehta")).toBeInTheDocument();
    expect(row("Full name").getByText("verified")).toBeInTheDocument();
    // An empty list is the caller saying none, which is an answer and not a blank.
    expect(row("Allergies").getByText("none")).toBeInTheDocument();
    expect(row("Current medications").getByText("Metformin, Amlodipine")).toBeInTheDocument();
    expect(
      row("Current medications").getByText(/recording suggests a different value/),
    ).toBeInTheDocument();
    expect(row("Phone number").getByText("check")).toBeInTheDocument();
    expect(row("Phone number").getByText(/not confirmed by the caller/)).toBeInTheDocument();
    // A date is shown as it was read back, not as it is stored.
    expect(row("Date of birth").getByText("12 March 1990")).toBeInTheDocument();
    expect(row("Preferred time").getByText("not captured")).toBeInTheDocument();
    expect(row("Preferred time").getByText("check")).toBeInTheDocument();
    expect(screen.getByText(/Graded on the conversation and on the recording/)).toBeInTheDocument();
    expect(screen.getByText("No appointment was booked on this call.")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("names what the call itself got wrong, not only what the recording said", () => {
    render(
      <VerifiedChart
        record={callRecord(
          { full_name: { value: "Arjun Mehta", status: "confirmed" } },
          { full_name: sure },
          {
            issues: [
              { field: "full_name", issue: "readback_not_spoken" },
              { field: "phone", issue: "caller_did_not_agree", callerSaid: "no that is wrong" },
            ],
          },
        )}
      />,
    );
    expect(row("Full name").getByText(/recorded this without reading it back/)).toBeInTheDocument();
    expect(row("Phone number").getByText(/did not agree to the value/)).toBeInTheDocument();
  });

  it("says when the grades rest on the conversation alone, and shows what was booked or escalated", () => {
    render(
      <VerifiedChart
        record={callRecord(
          {},
          {},
          {
            hearing: "unavailable",
            booking: { slotId: "2026-10-01T10:30", spoken: "Thursday at 10:30 in the morning" },
            escalation: { reason: "chest pain", urgent: true },
          },
        )}
      />,
    );
    expect(screen.getByText(/second hearing was not available/)).toBeInTheDocument();
    expect(screen.getByText(/Booked: Thursday at 10:30 in the morning/)).toBeInTheDocument();
    expect(screen.getByText(/Handed to a person: chest pain/)).toBeInTheDocument();
  });
});
