import { describe, expect, it } from "vitest";
import { FIELDS, isFieldId, normalise, sameValue, type FieldContext } from "@/lib/intake/fields";

const india: FieldContext = { country: "IN", now: new Date("2026-09-14T12:00:00Z") };
const us: FieldContext = { country: "US", now: india.now };

describe("normalise", () => {
  it("rejects an empty answer for any field", () => {
    expect(normalise(FIELDS.full_name, "   ", india)).toEqual({
      ok: false,
      problem: "No full name was given.",
    });
  });

  it("keeps names, including Devanagari, and collapses spacing", () => {
    expect(normalise(FIELDS.full_name, "  Arjun   Mehta ", india)).toEqual({
      ok: true,
      value: "Arjun Mehta",
    });
    expect(normalise(FIELDS.full_name, "अर्जुन मेहता", india)).toMatchObject({ ok: true });
    expect(normalise(FIELDS.full_name, "42", india)).toMatchObject({ ok: false });
    expect(normalise(FIELDS.full_name, "A", india)).toMatchObject({ ok: false });
    expect(normalise(FIELDS.full_name, "x".repeat(101), india)).toMatchObject({ ok: false });
  });

  it("accepts only real, past, plausible dates in ISO form", () => {
    expect(normalise(FIELDS.date_of_birth, "1990-03-12", india)).toEqual({
      ok: true,
      value: "1990-03-12",
    });
    const cases: Array<[string, RegExp]> = [
      ["12 March 1990", /YYYY-MM-DD/],
      ["1990-02-30", /not a real calendar date/],
      ["2027-01-01", /future/],
      ["1890-01-01", /over 120/],
    ];
    for (const [raw, problem] of cases) {
      const result = normalise(FIELDS.date_of_birth, raw, india);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toMatch(problem);
    }
  });

  it("stores Indian mobile numbers in E.164 from the ways people say them", () => {
    for (const raw of ["98765 43210", "+91 98765 43210", "09876543210", "919876543210"]) {
      expect(normalise(FIELDS.phone, raw, india)).toEqual({ ok: true, value: "+919876543210" });
    }
    expect(normalise(FIELDS.phone, "12345 67890", india)).toMatchObject({ ok: false });
    expect(normalise(FIELDS.phone, "98765", india)).toMatchObject({ ok: false });
  });

  it("stores US numbers in E.164", () => {
    expect(normalise(FIELDS.phone, "(415) 555-2671", us)).toEqual({
      ok: true,
      value: "+14155552671",
    });
    expect(normalise(FIELDS.phone, "1 415 555 2671", us)).toEqual({
      ok: true,
      value: "+14155552671",
    });
    expect(normalise(FIELDS.phone, "015 555 2671", us)).toMatchObject({ ok: false });
  });

  it("splits lists on semicolons and treats none as an answer", () => {
    expect(
      normalise(FIELDS.medications, "Metformin 500 mg twice daily; atorvastatin", india),
    ).toEqual({
      ok: true,
      value: ["Metformin 500 mg twice daily", "atorvastatin"],
    });
    for (const none of ["none", "No known allergies.", "nothing", "कोई नहीं"]) {
      expect(normalise(FIELDS.allergies, none, india)).toEqual({ ok: true, value: [] });
    }
    expect(normalise(FIELDS.allergies, " ; ; ", india)).toMatchObject({ ok: false });
    const long = Array.from({ length: 21 }, (_, i) => `drug ${i}`).join(";");
    expect(normalise(FIELDS.medications, long, india)).toMatchObject({ ok: false });
  });

  it("reads a negative the caller phrased their own way as an empty list", () => {
    const denied = [
      "no known drug allergies",
      "No known drug allergies.",
      "nothing at the moment",
      "nahi hai",
      "koi nahi",
    ];
    for (const raw of denied) {
      expect(normalise(FIELDS.allergies, raw, india), raw).toEqual({ ok: true, value: [] });
    }
    const notTaking = ["not taking anything", "no regular medications", "कुछ नहीं"];
    for (const raw of notTaking) {
      expect(normalise(FIELDS.medications, raw, india), raw).toEqual({ ok: true, value: [] });
    }
  });

  it("refuses to store a list item that opens with a no", () => {
    const denial = normalise(FIELDS.allergies, "no penicillin", india);
    expect(denial.ok).toBe(false);
    if (!denial.ok) expect(denial.problem).toMatch(/sounds like a no/);
    expect(normalise(FIELDS.medications, "metformin, no others", india)).toMatchObject({
      ok: false,
    });
  });

  it("splits a list on commas and on and, so every item is read back", () => {
    expect(normalise(FIELDS.allergies, "penicillin, sulfa drugs", india)).toEqual({
      ok: true,
      value: ["penicillin", "sulfa drugs"],
    });
    expect(normalise(FIELDS.medications, "metformin and atorvastatin", india)).toEqual({
      ok: true,
      value: ["metformin", "atorvastatin"],
    });
    expect(
      normalise(FIELDS.medications, "aspirin; metformin, vitamin D3 and calcium", india),
    ).toEqual({ ok: true, value: ["aspirin", "metformin", "vitamin D3", "calcium"] });
  });

  it("judges the future against the clinic's calendar, not a UTC instant", () => {
    // 30 September has begun in India while UTC is still on the 29th.
    const indiaMidnight: FieldContext = { country: "IN", now: new Date("2026-09-29T18:30:00Z") };
    expect(normalise(FIELDS.date_of_birth, "2026-09-30", indiaMidnight)).toEqual({
      ok: true,
      value: "2026-09-30",
    });
    expect(normalise(FIELDS.date_of_birth, "2026-10-01", indiaMidnight)).toMatchObject({
      ok: false,
    });
    // A clinic that names its own zone is judged by that one: New York is still on the 29th.
    const newYork: FieldContext = { ...indiaMidnight, timezone: "America/New_York" };
    const result = normalise(FIELDS.date_of_birth, "2026-09-30", newYork);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/future/);
  });

  it("measures the age ceiling in years lived, not in year numbers", () => {
    // Still 120 until the birthday comes round, 121 on the day itself.
    expect(normalise(FIELDS.date_of_birth, "1905-09-15", india)).toEqual({
      ok: true,
      value: "1905-09-15",
    });
    expect(normalise(FIELDS.date_of_birth, "1905-09-14", india)).toMatchObject({ ok: false });
  });

  it("keeps free text, trimmed to a sane length", () => {
    const result = normalise(FIELDS.reason_for_visit, "Fever ".repeat(80), india);
    expect(result.ok).toBe(true);
    if (result.ok) expect(String(result.value).length).toBeLessThanOrEqual(300);
  });
});

describe("sameValue", () => {
  it("ignores case for scalars and case and order for lists", () => {
    expect(sameValue("Arjun Mehta", "arjun mehta")).toBe(true);
    expect(sameValue(["B", "a"], ["A", "b"])).toBe(true);
    expect(sameValue(["a"], ["a", "b"])).toBe(false);
    expect(sameValue("a", ["a"])).toBe(false);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, "a")).toBe(false);
  });
});

describe("isFieldId", () => {
  it("knows the intake fields and nothing else", () => {
    expect(isFieldId("allergies")).toBe(true);
    expect(isFieldId("password")).toBe(false);
  });
});
