import { describe, expect, it } from "vitest";
import { DEMO_CLINIC, clinicSchema } from "@/lib/clinic/config";

describe("clinicSchema", () => {
  it("accepts the demo clinic", () => {
    expect(clinicSchema.safeParse(DEMO_CLINIC).success).toBe(true);
  });

  it("rejects unknown fields, bad ids, unknown voices and zones, and inverted hours", () => {
    const cases: Array<[string, unknown]> = [
      ["unknown field", { ...DEMO_CLINIC, billing: true }],
      ["bad id", { ...DEMO_CLINIC, id: "Sunrise Clinic" }],
      ["hindi voice", { ...DEMO_CLINIC, voice: "lekha" }],
      ["time zone", { ...DEMO_CLINIC, timezone: "Mars/Olympus" }],
      ["hours", { ...DEMO_CLINIC, hours: { ...DEMO_CLINIC.hours, open: "18:00", close: "09:00" } }],
      ["no doctors", { ...DEMO_CLINIC, doctors: [] }],
      ["slot size", { ...DEMO_CLINIC, hours: { ...DEMO_CLINIC.hours, slotMinutes: 25 } }],
    ];
    for (const [label, clinic] of cases) {
      expect(clinicSchema.safeParse(clinic).success, label).toBe(false);
    }
  });
});
