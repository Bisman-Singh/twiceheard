import { describe, expect, it, vi } from "vitest";
import { DEMO_CLINIC, type Clinic } from "@/lib/clinic/config";
import { memoryIntakeStore, type IntakeStore } from "@/lib/intake/store";
import type { MedicationLookup } from "@/lib/medication/rxnorm";
import { recordingMessenger, type Messenger } from "@/lib/notify/sms";
import { openingHours, runTool, type ToolDeps } from "@/lib/tools/handlers";

// Monday 14 September 2026, 08:00 in India.
const NOW = new Date("2026-09-14T02:30:00Z");

function deps(
  overrides: Partial<ToolDeps> = {},
): ToolDeps & { sms: ReturnType<typeof recordingMessenger> } {
  const ids = ["K7F2Q9", "M3N4P5", "R6S7T8"];
  return {
    clinic: DEMO_CLINIC,
    store: memoryIntakeStore(() => NOW.getTime()),
    medications: { lookup: async (name) => ({ kind: "none", name }) },
    sms: recordingMessenger(),
    now: () => NOW,
    newId: () => ids.shift() ?? "ZZZZZZ",
    ...overrides,
  } as ToolDeps & { sms: ReturnType<typeof recordingMessenger> };
}

async function started(d: ToolDeps): Promise<string> {
  const result = await runTool("start_intake", {}, d);
  return String(result.intake_id);
}

async function confirm(d: ToolDeps, id: string, field: string, value: string) {
  await runTool("save_field", { intake_id: id, field, value, status: "heard" }, d);
  return runTool("save_field", { intake_id: id, field, value, status: "confirmed" }, d);
}

describe("start_intake", () => {
  it("opens an intake and grounds the agent in today's date, hours and doctors", async () => {
    const d = deps();
    const result = await runTool("start_intake", undefined, d);
    expect(result).toMatchObject({
      ok: true,
      intake_id: "K7F2Q9",
      today: "Monday 14 September 2026",
      time_now: "8 am",
      hours: "Monday to Saturday, 9 am to 6 pm",
    });
    expect(result.doctors).toHaveLength(3);
    expect(await d.store.get("K7F2Q9")).not.toBeNull();
  });

  it("mints a random id when none is injected", async () => {
    const d = deps();
    delete d.newId;
    const result = await runTool("start_intake", {}, d);
    expect(String(result.intake_id)).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("retries on an id collision and gives up politely if the store keeps refusing", async () => {
    const d = deps({
      newId: vi
        .fn()
        .mockReturnValueOnce("K7F2Q9")
        .mockReturnValueOnce("K7F2Q9")
        .mockReturnValue("M3N4P5"),
    });
    await runTool("start_intake", {}, d);
    expect((await runTool("start_intake", {}, d)).intake_id).toBe("M3N4P5");
    const full: IntakeStore = { ...memoryIntakeStore(), create: async () => false };
    expect(await runTool("start_intake", {}, deps({ store: full }))).toMatchObject({ ok: false });
  });
});

describe("calls inside an intake", () => {
  it("records fields through the verified-field reducer", async () => {
    const d = deps();
    const id = await started(d);
    const heard = await runTool(
      "save_field",
      { intake_id: id, field: "full_name", value: "Arjun Mehta", status: "heard" },
      d,
    );
    expect(heard).toEqual({ ok: true, say: "I have your name as Arjun Mehta. Is that right?" });
    const refused = await runTool(
      "save_field",
      { intake_id: id, field: "phone", value: "98765 43210", status: "confirmed" },
      d,
    );
    expect(refused.ok).toBe(false);
    expect((await d.store.get(id))?.chart.full_name.status).toBe("heard");
  });

  it("accepts the intake id however the model repeats it", async () => {
    const d = deps();
    await started(d);
    const result = await runTool(
      "save_field",
      { intake_id: " k7f-2q9", field: "reason_for_visit", value: "cough", status: "heard" },
      d,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses unknown ids, another clinic's intake, and malformed arguments", async () => {
    const d = deps();
    const id = await started(d);
    expect(await runTool("finish_intake", { intake_id: "NOPE00" }, d)).toMatchObject({
      ok: false,
      note: expect.stringMatching(/not recognised/),
    });
    expect(await runTool("finish_intake", { intake_id: "!!" }, d)).toMatchObject({ ok: false });
    const other: Clinic = { ...DEMO_CLINIC, id: "another-clinic" };
    expect((await runTool("finish_intake", { intake_id: id }, { ...d, clinic: other })).ok).toBe(
      false,
    );
    expect(await runTool("save_field", { intake_id: id, field: "phone" }, d)).toEqual({
      ok: false,
      note: "The status for save_field is missing or not valid. Try again.",
    });
    expect((await runTool("escalate", null, d)).note).toMatch(/intake_id for escalate/);
    expect((await runTool("finish_intake", "not an object", d)).note).toBe(
      "The arguments for finish_intake is missing or not valid. Try again.",
    );
  });
});

describe("check_medication", () => {
  it("passes an exact name, asks about a close one, and keeps an unknown one as said", async () => {
    const lookup: MedicationLookup["lookup"] = async (name) =>
      name === "metformin"
        ? { kind: "exact", name: "metformin", rxcui: "6809" }
        : name === "metphormin"
          ? { kind: "suggestion", name: "metformin", rxcui: "6809", heard: "metphormin" }
          : { kind: "none", name };
    const d = deps({ medications: { lookup } });
    const id = await started(d);
    expect(await runTool("check_medication", { intake_id: id, name: "metformin" }, d)).toEqual({
      ok: true,
      name: "metformin",
      note: "Use this spelling.",
    });
    expect((await runTool("check_medication", { intake_id: id, name: "metphormin" }, d)).say).toBe(
      "Just to check, is that metformin?",
    );
    expect(
      (await runTool("check_medication", { intake_id: id, name: "Glycomet" }, d)).note,
    ).toMatch(/exactly as the caller said/);
    expect((await d.store.get(id))?.medicationChecks).toHaveLength(3);
  });
});

describe("find_slots", () => {
  it("offers three times in words with ids the agent must not read out", async () => {
    const d = deps();
    const id = await started(d);
    const result = await runTool(
      "find_slots",
      { intake_id: id, part_of_day: "afternoon", doctor_id: "dr-iyer" },
      d,
    );
    expect(result.slots).toEqual([
      {
        slot_id: "dr-iyer_20260914T1200",
        time: "Monday 14 September at 12 noon with Dr. Rahul Iyer",
      },
      {
        slot_id: "dr-iyer_20260914T1220",
        time: "Monday 14 September at 12:20 pm with Dr. Rahul Iyer",
      },
      {
        slot_id: "dr-iyer_20260914T1240",
        time: "Monday 14 September at 12:40 pm with Dr. Rahul Iyer",
      },
    ]);
  });

  it("explains bad dates and doctors, treats an odd part of day as any, and says when nothing is open", async () => {
    const d = deps();
    const id = await started(d);
    expect(
      (await runTool("find_slots", { intake_id: id, part_of_day: "any", date: "next tuesday" }, d))
        .note,
    ).toMatch(/YYYY-MM-DD/);
    expect(
      (await runTool("find_slots", { intake_id: id, part_of_day: "any", doctor_id: "dr-who" }, d))
        .note,
    ).toMatch(/dr-kapoor, dr-iyer, dr-sen/);
    expect(
      (
        (await runTool("find_slots", { intake_id: id, part_of_day: "midnight" }, d))
          .slots as unknown[]
      ).length,
    ).toBe(3);
    const sunday = await runTool(
      "find_slots",
      { intake_id: id, part_of_day: "any", date: "2026-09-20" },
      d,
    );
    expect(sunday).toMatchObject({
      ok: true,
      slots: [],
      note: expect.stringMatching(/another day/),
    });
  });
});

describe("book_appointment", () => {
  async function readyToBook(d: ToolDeps) {
    const id = await started(d);
    await confirm(d, id, "full_name", "Arjun Mehta");
    await confirm(d, id, "date_of_birth", "1990-03-12");
    await confirm(d, id, "phone", "98765 43210");
    return id;
  }

  it("will not book until name, date of birth and phone are confirmed", async () => {
    const d = deps();
    const id = await started(d);
    await confirm(d, id, "full_name", "Arjun Mehta");
    const result = await runTool(
      "book_appointment",
      { intake_id: id, slot_id: "dr-iyer_20260915T0940" },
      d,
    );
    expect(result).toEqual({
      ok: false,
      note: "Confirm the date of birth, phone number with the caller before booking.",
    });
  });

  it("books a real slot once, texts the confirmed number, and repeats itself if asked again", async () => {
    const d = deps();
    const id = await readyToBook(d);
    const result = await runTool(
      "book_appointment",
      { intake_id: id, slot_id: "dr-iyer_20260915T0940" },
      d,
    );
    expect(result).toEqual({
      ok: true,
      say: "You're booked for Tuesday 15 September at 9:40 am with Dr. Rahul Iyer. A text message is on its way.",
    });
    expect(d.sms.sent).toEqual([
      {
        to: "+919876543210",
        body: "Sunrise Family Clinic: you are booked for Tuesday 15 September at 9:40 am with Dr. Rahul Iyer. Please arrive 10 minutes early. Call the clinic if you need to change it.",
      },
    ]);
    const again = await runTool(
      "book_appointment",
      { intake_id: id, slot_id: "dr-iyer_20260915T0940 " },
      d,
    );
    expect(again.say).toBe(
      "You're booked for Tuesday 15 September at 9:40 am with Dr. Rahul Iyer.",
    );
    expect(
      (await runTool("book_appointment", { intake_id: id, slot_id: "dr-sen_20260915T1000" }, d))
        .note,
    ).toMatch(/Already booked/);
    expect(d.sms.sent).toHaveLength(1);
    const offered = await runTool(
      "find_slots",
      { intake_id: id, part_of_day: "morning", date: "2026-09-15", doctor_id: "dr-iyer" },
      d,
    );
    expect((offered.slots as Array<{ slot_id: string }>).map((slot) => slot.slot_id)).not.toContain(
      "dr-iyer_20260915T0940",
    );
  });

  it("refuses times the clinic does not offer and times another caller just took", async () => {
    const d = deps();
    const first = await readyToBook(d);
    const second = await readyToBook(d);
    expect(
      (await runTool("book_appointment", { intake_id: first, slot_id: "dr-iyer_20260915T0945" }, d))
        .note,
    ).toMatch(/not available/);
    await runTool("book_appointment", { intake_id: first, slot_id: "dr-kapoor_20260916T1100" }, d);
    const clash = await runTool(
      "book_appointment",
      { intake_id: second, slot_id: "dr-kapoor_20260916T1100" },
      d,
    );
    expect(clash).toEqual({
      ok: false,
      note: "Someone has just taken that time. Call find_slots again.",
    });
  });

  it("still books when the text fails, and says the front desk will confirm", async () => {
    const failing: Messenger = { send: async () => ({ ok: false }) };
    const throwing: Messenger = { send: async () => Promise.reject(new Error("carrier down")) };
    for (const sms of [failing, throwing]) {
      const d = deps({ sms: sms as ReturnType<typeof recordingMessenger> });
      const id = await readyToBook(d);
      const result = await runTool(
        "book_appointment",
        { intake_id: id, slot_id: "dr-sen_20260915T1000" },
        d,
      );
      expect(result).toMatchObject({
        ok: true,
        note: expect.stringMatching(/front desk will confirm/),
      });
      expect((await d.store.get(id))?.booking?.smsSent).toBe(false);
    }
  });
});

describe("escalate and finish_intake", () => {
  it("sends an emergency caller to the emergency number and a routine one to a callback", async () => {
    const d = deps();
    const id = await started(d);
    const urgent = await runTool(
      "escalate",
      { intake_id: id, reason: "Chest pain", urgent: "true" },
      d,
    );
    expect(urgent.say).toBe("Please call one one two now. I have told the clinic as well.");
    expect((await d.store.get(id))?.escalation).toMatchObject({
      reason: "Chest pain",
      urgent: true,
    });
    const routine = await runTool(
      "escalate",
      { intake_id: id, reason: "Wants a person", urgent: false },
      d,
    );
    expect(routine.note).toMatch(/call them back soon/);
  });

  it("lists critical details still open, ignoring ones already handed to the clinic", async () => {
    const d = deps();
    const id = await started(d);
    await confirm(d, id, "full_name", "Arjun Mehta");
    await runTool(
      "save_field",
      { intake_id: id, field: "allergies", value: "", status: "unresolved" },
      d,
    );
    const open = await runTool("finish_intake", { intake_id: id }, d);
    expect(open.unconfirmed).toEqual(["date_of_birth", "phone", "medications"]);
    expect(open.note).toBe(
      "Still unconfirmed: date of birth, phone number, current medications. Ask for these once, then say goodbye.",
    );
    expect((await d.store.get(id))?.finishedAt).toBe(NOW.getTime());
    await confirm(d, id, "date_of_birth", "1990-03-12");
    await confirm(d, id, "phone", "98765 43210");
    await confirm(d, id, "medications", "none");
    expect((await runTool("finish_intake", { intake_id: id }, d)).note).toMatch(/Say goodbye/);
  });
});

describe("openingHours", () => {
  it("speaks consecutive days as ranges and lone days on their own", () => {
    const hours = (days: number[]) =>
      openingHours({ ...DEMO_CLINIC, hours: { ...DEMO_CLINIC.hours, days } });
    expect(hours([1, 2, 3, 5, 6])).toBe("Monday to Wednesday and Friday to Saturday, 9 am to 6 pm");
    expect(hours([0])).toBe("Sunday, 9 am to 6 pm");
    expect(hours([6, 1, 1, 3])).toBe("Monday and Wednesday and Saturday, 9 am to 6 pm");
  });
});
