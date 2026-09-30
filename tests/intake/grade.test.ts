import { describe, expect, it } from "vitest";
import { emptyChart, saveField, type Chart } from "@/lib/intake/chart";
import type { FieldContext } from "@/lib/intake/fields";
import { gradeChart, gradeField } from "@/lib/intake/grade";

const context: FieldContext = { country: "IN", now: new Date("2026-09-14T12:00:00Z") };

function confirmed(chart: Chart, field: string, value: string): Chart {
  const heard = saveField(chart, { field, value, status: "heard" }, context).chart;
  return saveField(heard, { field, value, status: "confirmed" }, context).chart;
}

function fullyConfirmed(): Chart {
  let chart = emptyChart();
  chart = confirmed(chart, "full_name", "Arjun Mehta");
  chart = confirmed(chart, "date_of_birth", "1990-03-12");
  chart = confirmed(chart, "phone", "9876543210");
  chart = confirmed(chart, "medications", "none");
  chart = confirmed(chart, "allergies", "penicillin");
  return chart;
}

describe("gradeField", () => {
  it("grades the live conversation alone before the recording is checked", () => {
    const chart = saveField(
      emptyChart(),
      { field: "phone", value: "9876543210", status: "heard" },
      context,
    ).chart;
    expect(gradeField(chart.full_name)).toEqual({
      id: "full_name",
      grade: "red",
      reasons: ["Not captured."],
    });
    expect(gradeField(chart.reason_for_visit).grade).toBe("amber");
    expect(gradeField(chart.phone)).toEqual({
      id: "phone",
      grade: "amber",
      reasons: ["Heard but not confirmed by the caller."],
    });
  });

  it("accepts an optional field that was heard, since it never needs a yes", () => {
    const chart = saveField(
      emptyChart(),
      { field: "preferred_time", value: "Tuesday morning", status: "heard" },
      context,
    ).chart;
    expect(gradeField(chart.preferred_time)).toEqual({
      id: "preferred_time",
      grade: "green",
      reasons: [],
    });
  });

  it("keeps a confirmed field green only when the second hearing agrees with confidence", () => {
    const record = fullyConfirmed().full_name;
    expect(gradeField(record, { hearing: "agrees", minConfidence: 0.97 }).grade).toBe("green");
    expect(gradeField(record, { hearing: "agrees", minConfidence: 0.7 })).toEqual({
      id: "full_name",
      grade: "amber",
      reasons: ["Partly unclear in the recording (70% confidence)."],
    });
    expect(gradeField(record, { hearing: "agrees", minConfidence: 0.31 })).toEqual({
      id: "full_name",
      grade: "red",
      reasons: ["The recording is unclear here (31% confidence)."],
    });
  });

  it("flags a yes that the recording does not support", () => {
    const record = fullyConfirmed().phone;
    expect(gradeField(record, { hearing: "differs", minConfidence: 0.95 }).reasons).toEqual([
      "The recording suggests a different value.",
    ]);
    expect(gradeField(record, { hearing: "absent", minConfidence: null }).grade).toBe("amber");
    expect(gradeField(record, { hearing: "agrees", minConfidence: null }).grade).toBe("amber");
  });

  // "The recording suggests a different value" would be false here: the drug was heard,
  // it is the number beside it that nobody can hear said. The clinic is told which.
  it("says when it is the dose that is missing, not the drug", () => {
    const record = fullyConfirmed().medications;
    expect(
      gradeField(record, { hearing: "differs", minConfidence: 0.9, doseUnheard: true }),
    ).toMatchObject({
      grade: "amber",
      reasons: ["The drug was heard, but not the dose written beside it."],
    });
  });

  it("never lets verification improve a field that failed live", () => {
    let chart = emptyChart();
    for (const value of ["9876543210", "9876543211", "9876543212", "9876543213"]) {
      chart = saveField(chart, { field: "phone", value, status: "heard" }, context).chart;
    }
    const graded = gradeField(chart.phone, { hearing: "agrees", minConfidence: 0.99 });
    expect(graded.grade).toBe("red");
    expect(graded.reasons[0]).toMatch(/after 4 tries/);
  });

  it("ignores verification for a field with no value", () => {
    expect(gradeField(emptyChart().allergies, { hearing: "agrees", minConfidence: 1 }).grade).toBe(
      "red",
    );
  });
});

describe("gradeChart", () => {
  it("is ready when every critical field is green, whatever the optional ones are", () => {
    const graded = gradeChart(fullyConfirmed());
    expect(graded.ready).toBe(true);
    expect(graded.counts).toEqual({ green: 5, amber: 2, red: 0 });
  });

  it("is not ready when one critical field is downgraded by the recording", () => {
    const graded = gradeChart(fullyConfirmed(), {
      allergies: { hearing: "differs", minConfidence: 0.9 },
    });
    expect(graded.ready).toBe(false);
    expect(graded.fields.find((field) => field.id === "allergies")?.grade).toBe("amber");
  });
});
