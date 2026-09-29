import { FIELDS, type FieldValue } from "@/lib/intake/fields";
import type { Grade } from "@/lib/intake/grade";
import type { CallRecord } from "@/lib/postcall/record";

/**
 * The chart the clinic would receive, shown back to the person who just called.
 *
 * Nothing here is a summary of the conversation. Each line is a value the call
 * proved, the grade it earned, and the reason for that grade in words the
 * caller can check against what they remember saying.
 */

const GRADE_WORDS: Record<Grade, string> = {
  green: "verified",
  amber: "check",
  red: "missing",
};

const GRADE_INK: Record<Grade, string> = {
  green: "text-[var(--green-text)]",
  amber: "text-[var(--amber-text)]",
  red: "text-[var(--red-text)]",
};

const ISSUE_WORDS = {
  readback_not_spoken: "The agent recorded this without reading it back.",
  no_answer_after_readback: "The caller never answered when this was read back.",
  caller_did_not_agree: "The caller did not agree to the value that was read back.",
} as const;

export function VerifiedChart({ record }: { record: CallRecord }) {
  const issues = new Map(record.issues.map((issue) => [issue.field, ISSUE_WORDS[issue.issue]]));
  return (
    <section aria-label="Your chart" className="border-t-2 border-[var(--text)] pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold">What the clinic receives</h3>
        <p className="text-sm text-[var(--muted)]">
          {record.grade.counts.green} verified, {record.grade.counts.amber} to check,{" "}
          {record.grade.counts.red} missing
        </p>
      </div>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {record.hearing === "verified"
          ? "Graded on the conversation and on the recording, heard a second time."
          : "Graded on the conversation alone: the second hearing was not available."}
      </p>
      <dl className="mt-4 border-t border-[var(--line)]">
        {record.grade.fields.map((field) => (
          <div
            key={field.id}
            className="grid grid-cols-[9rem_1fr_5rem] gap-x-3 border-b border-[var(--line)] py-2 text-sm max-sm:grid-cols-[1fr_4.5rem]"
          >
            <dt className="font-semibold">{FIELDS[field.id].label}</dt>
            <dd className="max-sm:col-span-2 max-sm:row-start-2">
              {shown(record.chart[field.id].value)}
              {(field.reasons.length > 0 || issues.has(field.id)) && (
                <span className="block text-[var(--muted)]">
                  {[...field.reasons, issues.get(field.id)].filter(Boolean).join(" ")}
                </span>
              )}
            </dd>
            <dd className={`text-right ${GRADE_INK[field.grade]}`}>{GRADE_WORDS[field.grade]}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm">
        {record.booking
          ? `Booked: ${record.booking.spoken}`
          : "No appointment was booked on this call."}
      </p>
      {record.escalation && (
        <p className="mt-2 border-l-2 border-[var(--red-text)] pl-3 text-sm">
          Handed to a person: {record.escalation.reason}
        </p>
      )}
    </section>
  );
}

/** An empty list is the caller saying "none", which is an answer, not a blank. */
function shown(value: FieldValue | null): string {
  if (value === null) return "not captured";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none";
  return String(value);
}
