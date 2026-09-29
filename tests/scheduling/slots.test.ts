import { describe, expect, it } from "vitest";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import {
  HORIZON_DAYS,
  addDays,
  clinicNow,
  describeSlotId,
  openSlots,
  slotFromId,
  slotId,
  spokenDay,
  spokenTime,
} from "@/lib/scheduling/slots";

// Monday 14 September 2026, 08:00 in India (02:30 UTC). The clinic opens at 09:00, Monday to Saturday.
const mondayMorning = new Date("2026-09-14T02:30:00Z");
const query = { now: mondayMorning, partOfDay: "any" as const, taken: new Set<string>(), limit: 3 };

describe("clinic time", () => {
  it("reads the clinic's own date and minute, not the server's", () => {
    expect(clinicNow("Asia/Kolkata", mondayMorning)).toEqual({
      date: "2026-09-14",
      minute: 8 * 60,
    });
    expect(clinicNow("America/New_York", mondayMorning)).toEqual({
      date: "2026-09-13",
      minute: 22 * 60 + 30,
    });
  });

  it("adds days across month ends and speaks days and times plainly", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(spokenDay("2026-09-15")).toBe("Tuesday 15 September");
    expect([9 * 60 + 20, 12 * 60, 13 * 60, 17 * 60 + 40, 0].map(spokenTime)).toEqual([
      "9:20 am",
      "12 noon",
      "1 pm",
      "5:40 pm",
      "12 am",
    ]);
  });
});

describe("openSlots", () => {
  it("offers the earliest times after the lead time, across doctors", () => {
    const slots = openSlots(DEMO_CLINIC, query);
    expect(slots.map((slot) => slot.id)).toEqual([
      "dr-kapoor_20260914T0900",
      "dr-iyer_20260914T0900",
      "dr-sen_20260914T0900",
    ]);
    expect(slots[0]?.spoken).toBe("Monday 14 September at 9 am with Dr. Neha Kapoor");
  });

  it("keeps an hour's lead time on the same day", () => {
    const tenFifteen = new Date("2026-09-14T04:45:00Z");
    expect(openSlots(DEMO_CLINIC, { ...query, now: tenFifteen, limit: 1 })[0]?.start).toBe(
      "2026-09-14T11:20",
    );
  });

  it("filters by doctor, part of day and date, and skips taken times", () => {
    const taken = new Set([slotId("dr-sen", "2026-09-15", 17 * 60)]);
    const slots = openSlots(DEMO_CLINIC, {
      ...query,
      doctorId: "dr-sen",
      date: "2026-09-15",
      partOfDay: "evening",
      taken,
    });
    expect(slots.map((slot) => slot.start)).toEqual(["2026-09-15T17:20", "2026-09-15T17:40"]);
    const afternoon = openSlots(DEMO_CLINIC, { ...query, partOfDay: "afternoon", limit: 1 });
    expect(afternoon[0]?.start).toBe("2026-09-14T12:00");
    const morning = openSlots(DEMO_CLINIC, {
      ...query,
      partOfDay: "morning",
      date: "2026-09-15",
      limit: 100,
    });
    expect(morning.every((slot) => slot.start < "2026-09-15T12:00")).toBe(true);
  });

  it("offers nothing on days the clinic is closed, in the past or beyond the horizon", () => {
    expect(openSlots(DEMO_CLINIC, { ...query, date: "2026-09-20" })).toEqual([]);
    expect(openSlots(DEMO_CLINIC, { ...query, date: "2026-09-13" })).toEqual([]);
    expect(
      openSlots(DEMO_CLINIC, { ...query, date: addDays("2026-09-14", HORIZON_DAYS + 1) }),
    ).toEqual([]);
  });

  it("rolls over to the next open day when today is full", () => {
    const lateMonday = new Date("2026-09-14T12:00:00Z");
    expect(openSlots(DEMO_CLINIC, { ...query, now: lateMonday, limit: 1 })[0]?.start).toBe(
      "2026-09-15T09:00",
    );
  });
});

describe("describeSlotId", () => {
  it("refuses a clock time that cannot happen rather than rounding it into one", () => {
    expect(describeSlotId(DEMO_CLINIC, "dr-kapoor_20260915T0960")).toBeNull();
    expect(describeSlotId(DEMO_CLINIC, "dr-kapoor_20260915T9900")).toBeNull();
    // The same id must not become a bookable ten o'clock either.
    expect(slotFromId(DEMO_CLINIC, "dr-kapoor_20260915T0960", mondayMorning)).toBeNull();
    expect(describeSlotId(DEMO_CLINIC, "dr-kapoor_20260915T1000")?.start).toBe("2026-09-15T10:00");
  });
});

describe("slotFromId", () => {
  it("accepts only times the clinic really offers", () => {
    expect(slotFromId(DEMO_CLINIC, "dr-iyer_20260915T0940", mondayMorning)?.spoken).toBe(
      "Tuesday 15 September at 9:40 am with Dr. Rahul Iyer",
    );
    const rejected = [
      "dr-iyer_20260915T0945",
      "dr-iyer_20260920T0940",
      "dr-nobody_20260915T0940",
      "dr-iyer_20260914T0800",
      "tomorrow at ten",
    ];
    for (const id of rejected) expect(slotFromId(DEMO_CLINIC, id, mondayMorning), id).toBeNull();
  });
});
