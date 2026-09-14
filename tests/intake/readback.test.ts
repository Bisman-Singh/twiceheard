import { describe, expect, it } from "vitest";
import { FIELDS } from "@/lib/intake/fields";
import { readback, spokenDate, spokenPhone } from "@/lib/intake/readback";

describe("readback", () => {
  it("reads dates day first, in words the caller expects", () => {
    expect(spokenDate("1990-03-12")).toBe("12 March 1990");
    expect(readback(FIELDS.date_of_birth, "2001-12-01")).toBe(
      "I have your date of birth as 1 December 2001. Is that right?",
    );
  });

  it("reads phone numbers digit by digit in the local grouping", () => {
    expect(spokenPhone("+919876543210")).toBe("nine eight seven six five, four three two one zero");
    expect(spokenPhone("+14155552671")).toBe("four one five, five five five, two six seven one");
    expect(readback(FIELDS.phone, "+919876543210")).toMatch(/^I have your number as nine/);
  });

  it("reads names and free text back as given", () => {
    expect(readback(FIELDS.full_name, "Arjun Mehta")).toBe(
      "I have your name as Arjun Mehta. Is that right?",
    );
    expect(readback(FIELDS.reason_for_visit, "a cough")).toBe(
      "I have noted: a cough. Is that right?",
    );
  });

  it("reads a whole list, and says none out loud", () => {
    expect(readback(FIELDS.medications, ["metformin"])).toBe(
      "I have your medications as metformin. Is that the complete list?",
    );
    expect(readback(FIELDS.allergies, ["penicillin", "peanuts", "latex"])).toBe(
      "I have your allergies as penicillin, peanuts and latex. Is that the complete list?",
    );
    expect(readback(FIELDS.allergies, [])).toBe(
      "I have that you have no known allergies. Is that right?",
    );
    expect(readback(FIELDS.medications, [])).toBe(
      "I have that you are not taking any regular medications. Is that right?",
    );
  });
});
