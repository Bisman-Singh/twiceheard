import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, emptyChart, saveField, type Chart } from "@/lib/intake/chart";
import type { FieldContext } from "@/lib/intake/fields";

const context: FieldContext = { country: "IN", now: new Date("2026-09-14T12:00:00Z") };

function run(
  chart: Chart,
  ...steps: Array<[string, string, "heard" | "confirmed" | "unresolved"]>
) {
  let current = chart;
  const replies = [];
  for (const [field, value, status] of steps) {
    const outcome = saveField(current, { field, value, status }, context);
    current = outcome.chart;
    replies.push(outcome.reply);
  }
  return { chart: current, replies };
}

describe("saveField", () => {
  it("starts with every field missing", () => {
    const chart = emptyChart();
    expect(Object.values(chart).every((record) => record.status === "missing")).toBe(true);
  });

  it("reads a critical field back, then confirms it on a yes to the same value", () => {
    const { chart, replies } = run(
      emptyChart(),
      ["full_name", "Arjun Mehta", "heard"],
      ["full_name", "arjun  mehta", "confirmed"],
    );
    expect(replies[0]).toEqual({
      ok: true,
      say: "I have your name as Arjun Mehta. Is that right?",
    });
    expect(replies[1]).toEqual({ ok: true, note: "Confirmed. Move to the next field." });
    expect(chart.full_name).toMatchObject({
      status: "confirmed",
      value: "Arjun Mehta",
      attempts: 1,
    });
    expect(chart.full_name.history.map((event) => event.status)).toEqual(["heard", "confirmed"]);
  });

  it("refuses to confirm a value that was never read back", () => {
    const { chart, replies } = run(emptyChart(), ["phone", "9876543210", "confirmed"]);
    expect(replies[0]).toMatchObject({ ok: false });
    expect(replies[0]?.note).toMatch(/status heard first/);
    expect(chart.phone.status).toBe("missing");
  });

  it("treats a confirmation of a different value as a new value that needs its own readback", () => {
    const { chart, replies } = run(
      emptyChart(),
      ["phone", "9876543210", "heard"],
      ["phone", "9876543211", "confirmed"],
    );
    expect(replies[1]).toMatchObject({
      ok: true,
      note: "The value changed. Read it back and wait for a yes.",
    });
    expect(replies[1]?.say).toMatch(/one$|one\. Is that right\?$/);
    expect(chart.phone).toMatchObject({ status: "heard", value: "+919876543211", attempts: 2 });
  });

  it("reopens a confirmed field when the caller changes their answer", () => {
    const { chart } = run(
      emptyChart(),
      ["date_of_birth", "1990-03-12", "heard"],
      ["date_of_birth", "1990-03-12", "confirmed"],
      ["date_of_birth", "1990-03-21", "heard"],
    );
    expect(chart.date_of_birth).toMatchObject({ status: "heard", value: "1990-03-21" });
  });

  it("repeats the readback for the same value, and says so once confirmed", () => {
    const { replies } = run(
      emptyChart(),
      ["full_name", "Arjun Mehta", "heard"],
      ["full_name", "Arjun Mehta", "heard"],
      ["full_name", "Arjun Mehta", "confirmed"],
      ["full_name", "Arjun Mehta", "heard"],
      ["full_name", "Arjun Mehta", "confirmed"],
    );
    expect(replies[1]?.say).toMatch(/Arjun Mehta/);
    expect(replies[3]?.note).toMatch(/Already confirmed/);
    expect(replies[4]?.note).toMatch(/Already confirmed/);
  });

  it("saves non-critical fields without a readback and never marks them confirmed by itself", () => {
    const { chart, replies } = run(
      emptyChart(),
      ["reason_for_visit", "cough for a week", "heard"],
      ["reason_for_visit", "cough for a week", "heard"],
    );
    expect(replies[0]).toEqual({ ok: true, note: "Saved. No readback needed; continue." });
    expect(replies[1]).toEqual(replies[0]);
    expect(chart.reason_for_visit.status).toBe("heard");
  });

  it("saves a changed non-critical answer offered as a confirmation without asking for a readback", () => {
    const { chart, replies } = run(
      emptyChart(),
      ["reason_for_visit", "cough", "heard"],
      ["reason_for_visit", "fever", "confirmed"],
    );
    expect(replies[1]).toEqual({ ok: true, note: "Saved. No readback needed; continue." });
    expect(chart.reason_for_visit).toMatchObject({ status: "heard", value: "fever" });
  });

  it("explains invalid values and counts them as attempts", () => {
    const { chart, replies } = run(emptyChart(), ["date_of_birth", "2030-01-01", "heard"]);
    expect(replies[0]).toMatchObject({ ok: false });
    expect(replies[0]?.note).toMatch(/future/);
    expect(chart.date_of_birth).toMatchObject({ status: "missing", attempts: 1 });
  });

  it(`gives up after ${MAX_ATTEMPTS} different values and keeps the last one for the clinic`, () => {
    const { chart, replies } = run(
      emptyChart(),
      ["phone", "9876543210", "heard"],
      ["phone", "9876543211", "heard"],
      ["phone", "9876543212", "heard"],
      ["phone", "9876543213", "heard"],
      ["phone", "9876543213", "confirmed"],
    );
    expect(replies[3]?.note).toMatch(/Leave this detail/);
    expect(replies[4]?.note).toMatch(/Leave this detail/);
    expect(chart.phone).toMatchObject({
      status: "unresolved",
      value: "+919876543213",
      attempts: 4,
    });
  });

  it("gives up after too many invalid values as well", () => {
    const { chart } = run(
      emptyChart(),
      ["date_of_birth", "nonsense", "heard"],
      ["date_of_birth", "still nonsense", "heard"],
      ["date_of_birth", "1990-02-30", "heard"],
      ["date_of_birth", "1990-13-01", "heard"],
    );
    expect(chart.date_of_birth.status).toBe("unresolved");
  });

  it("lets the agent mark a field unresolved when the caller cannot give it", () => {
    const { chart, replies } = run(emptyChart(), ["allergies", "", "unresolved"]);
    expect(replies[0]?.note).toMatch(/Leave this detail/);
    expect(chart.allergies.status).toBe("unresolved");
  });

  it("rejects unknown fields without touching the chart", () => {
    const start = emptyChart();
    const { chart, replies } = run(start, ["password", "hunter2", "heard"]);
    expect(replies[0]?.ok).toBe(false);
    expect(replies[0]?.note).toMatch(/Unknown field "password"/);
    expect(chart).toBe(start);
  });
});
