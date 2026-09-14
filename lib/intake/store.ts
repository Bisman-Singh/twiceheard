import type { Intake } from "@/lib/intake/intake";

/**
 * Where live intakes and taken appointment times are kept during a call.
 *
 * Two implementations share this shape: the in-memory one for tests, demo
 * mode and local runs, and a shared one for production so every serverless
 * instance sees the same call. Claiming a slot is atomic in both, which is
 * what stops two callers booking the same time.
 */
export interface IntakeStore {
  /** Store a new intake; false if the id is already in use. */
  create(intake: Intake): Promise<boolean>;
  get(id: string): Promise<Intake | null>;
  save(intake: Intake): Promise<void>;
  /** Take a slot for an intake; false if someone else already has it. */
  claimSlot(clinicId: string, slotId: string, intakeId: string): Promise<boolean>;
  takenSlots(clinicId: string): Promise<Set<string>>;
}

/** Live intakes are for the duration of a call and a little after; the chart is rebuilt later. */
export const INTAKE_TTL_MS = 6 * 60 * 60 * 1000;

export function memoryIntakeStore(now: () => number = Date.now): IntakeStore {
  const intakes = new Map<string, { intake: Intake; expiresAt: number }>();
  const slots = new Map<string, string>();

  const live = (id: string) => {
    const entry = intakes.get(id);
    if (entry && entry.expiresAt > now()) return entry.intake;
    intakes.delete(id);
    return null;
  };

  return {
    async create(intake) {
      if (live(intake.id)) return false;
      intakes.set(intake.id, { intake, expiresAt: now() + INTAKE_TTL_MS });
      return true;
    },
    async get(id) {
      return live(id);
    },
    async save(intake) {
      intakes.set(intake.id, { intake, expiresAt: now() + INTAKE_TTL_MS });
    },
    async claimSlot(clinicId, slotId, intakeId) {
      const key = `${clinicId}/${slotId}`;
      const holder = slots.get(key);
      if (holder && holder !== intakeId) return false;
      slots.set(key, intakeId);
      return true;
    },
    async takenSlots(clinicId) {
      const prefix = `${clinicId}/`;
      return new Set(
        [...slots.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length)),
      );
    },
  };
}
