import {
  FIELDS,
  FIELD_IDS,
  isFieldId,
  normalise,
  sameValue,
  type FieldContext,
  type FieldId,
  type FieldValue,
} from "@/lib/intake/fields";
import { readback } from "@/lib/intake/readback";

/**
 * The chart for one call, and the only way it changes.
 *
 * The agent reports what it heard through `save_field`; this reducer decides
 * what that means. The guarantee the product rests on lives here: a field is
 * confirmed only when the caller said yes to the exact value that was read
 * back. A "confirmed" report for a value that was never read back, or that
 * differs from it, is not accepted, and the agent is told to read back first.
 * "Confirmed" always means the caller said yes; nothing is confirmed by default.
 */

export type FieldStatus = "missing" | "heard" | "confirmed" | "unresolved";

export interface FieldEvent {
  at: number;
  status: FieldStatus;
  value: FieldValue | null;
}

export interface FieldRecord {
  id: FieldId;
  value: FieldValue | null;
  status: FieldStatus;
  /** Distinct values heard for this field, including ones that failed validation. */
  attempts: number;
  history: readonly FieldEvent[];
}

export type Chart = Readonly<Record<FieldId, FieldRecord>>;

/** What goes back to the model: `say` is spoken verbatim, `note` steers the next step. */
export interface ToolReply {
  ok: boolean;
  say?: string;
  note?: string;
}

export interface SaveFieldInput {
  field: string;
  value: string;
  status: "heard" | "confirmed" | "unresolved";
}

type Outcome = { chart: Chart; reply: ToolReply };

/** A value that still is not right after this many tries is left for the front desk. */
export const MAX_ATTEMPTS = 3;

const LEAVE_IT: ToolReply = {
  ok: true,
  note: "Leave this detail for the clinic to check. Tell the caller someone will confirm it, then move on.",
};
const SAVED: ToolReply = { ok: true, note: "Saved. No readback needed; continue." };
const ALREADY: ToolReply = { ok: true, note: "Already confirmed. Move to the next field." };

export function emptyChart(): Chart {
  const entries = FIELD_IDS.map((id): [FieldId, FieldRecord] => [
    id,
    { id, value: null, status: "missing", attempts: 0, history: [] },
  ]);
  return Object.fromEntries(entries) as Record<FieldId, FieldRecord>;
}

export function saveField(chart: Chart, input: SaveFieldInput, context: FieldContext): Outcome {
  if (!isFieldId(input.field)) {
    const note = `Unknown field "${input.field}". Fields: ${FIELD_IDS.join(", ")}.`;
    return { chart, reply: { ok: false, note } };
  }
  const record = chart[input.field];
  if (record.status === "unresolved") return { chart, reply: LEAVE_IT };
  if (input.status === "unresolved") return giveUp(chart, record, context.now);

  const parsed = normalise(FIELDS[input.field], input.value, context);
  if (!parsed.ok) return rejectValue(chart, record, parsed.problem, context.now);
  if (input.status === "confirmed") return confirm(chart, record, parsed.value, context.now);
  return hear(chart, record, parsed.value, context.now);
}

function hear(chart: Chart, record: FieldRecord, value: FieldValue, now: Date): Outcome {
  const spec = FIELDS[record.id];
  if (record.status !== "missing" && sameValue(record.value, value)) {
    return { chart, reply: repeatReply(record, value) };
  }
  const attempts = record.attempts + 1;
  if (attempts > MAX_ATTEMPTS) return giveUp(chart, { ...record, value, attempts }, now);
  const next = update(chart, record, { value, status: "heard", attempts }, now);
  return { chart: next, reply: spec.critical ? { ok: true, say: readback(spec, value) } : SAVED };
}

/** The same value again: read it back again if it still needs a yes, otherwise just carry on. */
function repeatReply(record: FieldRecord, value: FieldValue): ToolReply {
  if (record.status === "confirmed") return ALREADY;
  const spec = FIELDS[record.id];
  return spec.critical ? { ok: true, say: readback(spec, value) } : SAVED;
}

function confirm(chart: Chart, record: FieldRecord, value: FieldValue, now: Date): Outcome {
  if (record.status === "confirmed" && sameValue(record.value, value)) {
    return { chart, reply: ALREADY };
  }
  if (record.status === "missing") {
    const note =
      "Nothing has been read back for this field yet. Call save_field with status heard first.";
    return { chart, reply: { ok: false, note } };
  }
  if (!sameValue(record.value, value)) {
    const heard = hear(chart, record, value, now);
    const note = heard.reply.say
      ? "The value changed. Read it back and wait for a yes."
      : heard.reply.note;
    return { chart: heard.chart, reply: { ...heard.reply, note } };
  }
  // The caller said yes to what was read to them, so that spelling is what is kept.
  const change = { value: record.value, status: "confirmed" as const, attempts: record.attempts };
  const next = update(chart, record, change, now);
  return { chart: next, reply: { ok: true, note: "Confirmed. Move to the next field." } };
}

function rejectValue(chart: Chart, record: FieldRecord, problem: string, now: Date): Outcome {
  const attempts = record.attempts + 1;
  if (attempts > MAX_ATTEMPTS) return giveUp(chart, { ...record, attempts }, now);
  const next = update(chart, record, { value: record.value, status: record.status, attempts }, now);
  return { chart: next, reply: { ok: false, note: problem } };
}

function giveUp(chart: Chart, record: FieldRecord, now: Date): Outcome {
  const change = { value: record.value, status: "unresolved" as const, attempts: record.attempts };
  return { chart: update(chart, record, change, now), reply: LEAVE_IT };
}

function update(
  chart: Chart,
  record: FieldRecord,
  change: Pick<FieldRecord, "value" | "status" | "attempts">,
  now: Date,
): Chart {
  const event: FieldEvent = { at: now.getTime(), status: change.status, value: change.value };
  const next: FieldRecord = { ...record, ...change, history: [...record.history, event] };
  return { ...chart, [record.id]: next };
}
