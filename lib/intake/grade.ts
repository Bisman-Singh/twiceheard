import { FIELDS, FIELD_IDS, type FieldId } from "@/lib/intake/fields";
import type { Chart, FieldRecord } from "@/lib/intake/chart";

/**
 * Green, amber or red for every field, with the reasons a person can read.
 *
 * Two signals feed it, from the same vendor over the same audio, so they are
 * not independent. The live one is the conversation: did the
 * caller say yes to the value read back? The second arrives after the call,
 * when the recording is transcribed again on its own and each word carries a
 * confidence: does the patient's side of the recording actually contain the
 * value, and how sure was that second hearing? A field is green only when
 * both agree.
 */

export type Grade = "green" | "amber" | "red";

/** What the post-call hearing found for one field. */
export interface Verification {
  /** "agrees": the value is in the patient's audio; "differs": something else was said; "absent": not found. */
  hearing: "agrees" | "differs" | "absent";
  /** Lowest confidence among the words that carried the value; null when nothing matched. */
  minConfidence: number | null;
  /**
   * Set when every drug on the line was heard but a dose written on it was not. The
   * drug name matching is not the dangerous half: a dose nobody can hear said is.
   */
  doseUnheard?: boolean;
}

export interface FieldGrade {
  id: FieldId;
  grade: Grade;
  reasons: string[];
}

/** Below this, the second hearing is not sure the words were said at all. */
export const CONFIDENCE_FLOOR = 0.5;
/** At or above this, the second hearing is sure enough to stand behind a yes. */
export const CONFIDENCE_GOOD = 0.8;

const RANK: Record<Grade, number> = { green: 0, amber: 1, red: 2 };

function worst(a: Grade, b: Grade): Grade {
  return RANK[a] >= RANK[b] ? a : b;
}

export function gradeField(record: FieldRecord, verification?: Verification): FieldGrade {
  const live = liveGrade(record);
  if (!verification || record.value === null) return { id: record.id, ...live };
  const heard = hearingGrade(verification);
  return {
    id: record.id,
    grade: worst(live.grade, heard.grade),
    reasons: [...live.reasons, ...heard.reasons],
  };
}

function liveGrade(record: FieldRecord): { grade: Grade; reasons: string[] } {
  const critical = FIELDS[record.id].critical;
  switch (record.status) {
    case "missing":
      return critical
        ? { grade: "red", reasons: ["Not captured."] }
        : { grade: "amber", reasons: ["Not captured."] };
    case "unresolved":
      return { grade: "red", reasons: [`Could not be confirmed after ${record.attempts} tries.`] };
    case "heard":
      return critical
        ? { grade: "amber", reasons: ["Heard but not confirmed by the caller."] }
        : { grade: "green", reasons: [] };
    case "confirmed":
      return { grade: "green", reasons: [] };
  }
}

function hearingGrade(verification: Verification): { grade: Grade; reasons: string[] } {
  if (verification.hearing === "differs") {
    return {
      grade: "amber",
      reasons: [
        verification.doseUnheard
          ? "The drug was heard, but not the dose written beside it."
          : "The recording suggests a different value.",
      ],
    };
  }
  if (verification.hearing === "absent" || verification.minConfidence === null) {
    return { grade: "amber", reasons: ["The value could not be found in the recording."] };
  }
  const percent = Math.round(verification.minConfidence * 100);
  if (verification.minConfidence < CONFIDENCE_FLOOR) {
    return { grade: "red", reasons: [`The recording is unclear here (${percent}% confidence).`] };
  }
  if (verification.minConfidence < CONFIDENCE_GOOD) {
    return {
      grade: "amber",
      reasons: [`Partly unclear in the recording (${percent}% confidence).`],
    };
  }
  return { grade: "green", reasons: [] };
}

export interface ChartGrade {
  fields: FieldGrade[];
  counts: Record<Grade, number>;
  /** Every critical field is green: the clinic can act without calling back. */
  ready: boolean;
}

export function gradeChart(
  chart: Chart,
  verifications: Partial<Record<FieldId, Verification>> = {},
): ChartGrade {
  const fields = FIELD_IDS.map((id) => gradeField(chart[id], verifications[id]));
  const counts: Record<Grade, number> = { green: 0, amber: 0, red: 0 };
  for (const field of fields) counts[field.grade] += 1;
  const ready = fields.every((field) => !FIELDS[field.id].critical || field.grade === "green");
  return { fields, counts, ready };
}
