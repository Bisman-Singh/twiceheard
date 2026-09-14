import { emptyChart, type Chart } from "@/lib/intake/chart";
import type { MedicationMatch } from "@/lib/medication/match";

/**
 * One call's intake: the chart plus what happened around it.
 *
 * The id is what the agent repeats on every tool call, so it is built to
 * survive being spoken and re-typed by a model: six characters from an
 * alphabet with no look-alikes (no I, L, O, U, 0 or 1), matched without
 * regard to case, spaces or dashes.
 */

export interface Booking {
  slotId: string;
  spoken: string;
  bookedAt: number;
  smsSent: boolean;
}

export interface Escalation {
  reason: string;
  urgent: boolean;
  at: number;
}

export interface Intake {
  id: string;
  clinicId: string;
  startedAt: number;
  finishedAt: number | null;
  chart: Chart;
  medicationChecks: ReadonlyArray<{ heard: string; match: MedicationMatch }>;
  booking: Booking | null;
  escalation: Escalation | null;
}

export const INTAKE_ID_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const INTAKE_ID_LENGTH = 6;

/** Bytes at or above this are skipped so every character is equally likely. */
const UNBIASED_LIMIT = 256 - (256 % INTAKE_ID_ALPHABET.length);

export function newIntakeId(randomBytes: (length: number) => Uint8Array = cryptoBytes): string {
  let id = "";
  while (id.length < INTAKE_ID_LENGTH) {
    for (const byte of randomBytes(INTAKE_ID_LENGTH * 2)) {
      if (byte >= UNBIASED_LIMIT || id.length === INTAKE_ID_LENGTH) continue;
      id += INTAKE_ID_ALPHABET[byte % INTAKE_ID_ALPHABET.length];
    }
  }
  return id;
}

function cryptoBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** "k7f-2q9 " and "K7F2Q9" are the same id; anything that could not be one is null. */
export function canonicalIntakeId(raw: string): string | null {
  const id = raw.toUpperCase().replace(/[\s-]/g, "");
  const pattern = new RegExp(`^[${INTAKE_ID_ALPHABET}]{${INTAKE_ID_LENGTH}}$`);
  return pattern.test(id) ? id : null;
}

export function newIntake(id: string, clinicId: string, now: Date): Intake {
  return {
    id,
    clinicId,
    startedAt: now.getTime(),
    finishedAt: null,
    chart: emptyChart(),
    medicationChecks: [],
    booking: null,
    escalation: null,
  };
}
