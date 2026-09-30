import { describe, expect, it } from "vitest";
import { INTAKE_ID_ALPHABET, canonicalIntakeId, newIntake, newIntakeId } from "@/lib/intake/intake";
import { INTAKE_TTL_MS, memoryIntakeStore } from "@/lib/intake/store";
import { bookingMessage, recordingMessenger } from "@/lib/notify/sms";

describe("intake ids", () => {
  it("draws six characters from an alphabet with no look-alikes", () => {
    expect(INTAKE_ID_ALPHABET).not.toMatch(/[ILOU01]/);
    const id = newIntakeId();
    expect(id).toMatch(new RegExp(`^[${INTAKE_ID_ALPHABET}]{6}$`));
    // 240 and above are skipped for uniformity; a short supply is topped up with another draw.
    const draws = [
      new Uint8Array([0, 1, 2, 29, 30, 255]),
      new Uint8Array([240, 45, 250, 59, 7, 7]),
    ];
    expect(newIntakeId(() => draws.shift() as Uint8Array)).toBe("ABC9AS");
  });

  it("matches an id regardless of case, spaces or dashes, and rejects what cannot be one", () => {
    expect(canonicalIntakeId(" k7f-2q9 ")).toBe("K7F2Q9");
    expect(canonicalIntakeId("K7F 2Q9")).toBe("K7F2Q9");
    for (const bad of ["K7F2Q", "K7F2Q9X", "K7F2Q0", "ILOU23", ""]) {
      expect(canonicalIntakeId(bad), bad).toBeNull();
    }
  });
});

describe("memoryIntakeStore", () => {
  it("creates once per id, reads back, and forgets after the time to live", async () => {
    let now = 0;
    const store = memoryIntakeStore(() => now);
    const intake = newIntake("K7F2Q9", "sunrise-family", new Date(0));
    expect(await store.create(intake)).toBe(true);
    expect(await store.create(intake)).toBe(false);
    await store.save({ ...intake, finishedAt: 5 });
    expect((await store.get("K7F2Q9"))?.finishedAt).toBe(5);
    now = INTAKE_TTL_MS + 1;
    expect(await store.get("K7F2Q9")).toBeNull();
    expect(await store.create(intake)).toBe(true);
  });

  it("lets one intake hold a slot, idempotently, and keeps clinics apart", async () => {
    const store = memoryIntakeStore();
    expect(await store.claimSlot("a", "slot-1", "K7F2Q9")).toBe(true);
    expect(await store.claimSlot("a", "slot-1", "K7F2Q9")).toBe(true);
    expect(await store.claimSlot("a", "slot-1", "M3N4P5")).toBe(false);
    expect(await store.claimSlot("b", "slot-1", "M3N4P5")).toBe(true);
    expect(await store.takenSlots("a")).toEqual(new Set(["slot-1"]));
    expect(await store.takenSlots("c")).toEqual(new Set());
  });
});

describe("sms", () => {
  it("records what would have been sent and writes a short confirmation", async () => {
    const messenger = recordingMessenger();
    expect(await messenger.send("+919876543210", "hi")).toEqual({ ok: true });
    expect(messenger.sent).toEqual([{ to: "+919876543210", body: "hi" }]);
    expect(
      bookingMessage("Sunrise Family Clinic", "Tuesday 15 September at 9:40 in the morning"),
    ).toMatch(/^Sunrise Family Clinic: you are booked for Tuesday/);
  });
});
