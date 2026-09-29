import { z } from "zod";
import type { Clinic } from "@/lib/clinic/config";
import { saveField, type Chart, type ToolReply } from "@/lib/intake/chart";
import {
  FIELDS,
  FIELD_IDS,
  isFieldId,
  normalise,
  sameValue,
  type FieldContext,
  type FieldId,
} from "@/lib/intake/fields";
import {
  canonicalIntakeId,
  newIntake,
  newIntakeId,
  type Escalation,
  type Intake,
} from "@/lib/intake/intake";
import { readback } from "@/lib/intake/readback";
import type { IntakeStore } from "@/lib/intake/store";
import type { MedicationLookup } from "@/lib/medication/rxnorm";
import { bookingMessage, type Messenger } from "@/lib/notify/sms";
import {
  HORIZON_DAYS,
  addDays,
  clinicNow,
  openSlots,
  slotFromId,
  spokenDay,
  spokenTime,
  type PartOfDay,
} from "@/lib/scheduling/slots";
import { emergencyNumber } from "@/lib/voice-agent/prompt";
import type { ToolName } from "@/lib/voice-agent/tools";

/**
 * What each tool does when the agent calls it.
 *
 * Handlers take plain arguments and return a small JSON object the platform
 * feeds back to the model. `say` is the sentence the agent is instructed to say
 * exactly, which nothing in the platform enforces and `lib/postcall/replay.ts`
 * checks afterwards; `note` steers the next step; anything else is data for the
 * model to use. They never throw for
 * a bad request from the model; they explain what to do instead, because a
 * thrown error on a live call is a silence the caller has to sit through.
 */

export interface ToolDeps {
  clinic: Clinic;
  /** Set when a browser is relaying the call, so one browser cannot drive another's intake. */
  owner?: string;
  store: IntakeStore;
  medications: MedicationLookup;
  sms: Messenger;
  now: () => Date;
  newId?: () => string;
}

export type ToolResult = { ok: boolean; say?: string; note?: string } & Record<string, unknown>;

/** Details a booking needs confirmed first, so the text goes to the right person. */
export const BOOKING_REQUIRES: readonly FieldId[] = ["full_name", "date_of_birth", "phone"];

const UNKNOWN_INTAKE: ToolResult = {
  ok: false,
  note: "That intake id is not recognised. Call start_intake and use the id it returns.",
};

const intakeId = z.string().max(40);
const flag = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

const schemas = {
  start_intake: z.object({}).passthrough(),
  save_field: z.object({
    intake_id: intakeId,
    field: z.string().max(40),
    value: z.string().max(1_000).default(""),
    status: z.enum(["heard", "confirmed", "unresolved"]),
    /** Set when the caller says the value already on the chart is not theirs any more. */
    replaces_earlier_value: flag.optional(),
  }),
  check_medication: z.object({ intake_id: intakeId, name: z.string().min(1).max(120) }),
  find_slots: z.object({
    intake_id: intakeId,
    doctor_id: z.string().max(40).optional(),
    date: z.string().max(20).optional(),
    part_of_day: z.enum(["morning", "afternoon", "evening", "any"]).catch("any"),
  }),
  book_appointment: z.object({ intake_id: intakeId, slot_id: z.string().max(60) }),
  escalate: z.object({ intake_id: intakeId, reason: z.string().max(300), urgent: flag }),
  finish_intake: z.object({ intake_id: intakeId }),
} satisfies Record<ToolName, z.ZodType>;

export async function runTool(
  name: ToolName,
  rawArgs: unknown,
  deps: ToolDeps,
): Promise<ToolResult> {
  const parsed = schemas[name].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "arguments";
    return { ok: false, note: `The ${where} for ${name} is missing or not valid. Try again.` };
  }
  if (name === "start_intake") return startIntake(deps);
  const args = parsed.data as { intake_id: string };
  const intake = await loadIntake(args.intake_id, deps);
  if (!intake) return UNKNOWN_INTAKE;
  const handler = HANDLERS[name] as (
    intake: Intake,
    args: unknown,
    deps: ToolDeps,
  ) => Promise<ToolResult>;
  return handler(intake, parsed.data, deps);
}

type Args<N extends ToolName> = z.infer<(typeof schemas)[N]>;
type CallTools = Exclude<ToolName, "start_intake">;

/** Every tool that runs inside an intake, with the arguments its schema produced. */
const HANDLERS: {
  [N in CallTools]: (intake: Intake, args: Args<N>, deps: ToolDeps) => Promise<ToolResult>;
} = {
  save_field: (intake, args, deps) => recordField(intake, args, deps),
  check_medication: (intake, args, deps) => checkMedication(intake, args.name, deps),
  find_slots: (_intake, args, deps) => findSlots(args, deps),
  book_appointment: (intake, args, deps) => book(intake, args.slot_id, deps),
  escalate: (intake, args, deps) => escalate(intake, args, deps),
  finish_intake: (intake, _args, deps) => finish(intake, deps),
};

async function loadIntake(raw: string, deps: ToolDeps): Promise<Intake | null> {
  const id = canonicalIntakeId(raw);
  const intake = id ? await deps.store.get(id) : null;
  if (!intake || intake.clinicId !== deps.clinic.id) return null;
  // An intake a browser started is that browser's, and the phone's belong to the phone.
  return intake.owner === deps.owner ? intake : null;
}

async function startIntake(deps: ToolDeps): Promise<ToolResult> {
  const now = deps.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const intake = newIntake((deps.newId ?? newIntakeId)(), deps.clinic.id, now, deps.owner);
    if (!(await deps.store.create(intake))) continue;
    const local = clinicNow(deps.clinic.timezone, now);
    return {
      ok: true,
      intake_id: intake.id,
      today: `${spokenDay(local.date)} ${local.date.slice(0, 4)}`,
      time_now: spokenTime(local.minute),
      hours: openingHours(deps.clinic),
      doctors: deps.clinic.doctors.map((doctor) => ({
        doctor_id: doctor.id,
        name: doctor.name,
        specialty: doctor.specialty,
      })),
      note: "Pass intake_id to every other tool. Do not read it out.",
    };
  }
  return {
    ok: false,
    note: "Could not start the intake. Carry on and try start_intake again shortly.",
  };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "09:00" as minutes after midnight. */
const hhmmMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** "Monday to Saturday, 9 am to 6 pm". */
export function openingHours(clinic: Clinic): string {
  const days = [...new Set(clinic.hours.days)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = days[0] as number;
  for (let index = 1; index <= days.length; index += 1) {
    const day = days[index];
    if (day === (days[index - 1] as number) + 1) continue;
    const end = days[index - 1] as number;
    ranges.push(
      start === end ? (DAY_NAMES[start] as string) : `${DAY_NAMES[start]} to ${DAY_NAMES[end]}`,
    );
    start = day as number;
  }
  return `${ranges.join(" and ")}, ${spokenTime(hhmmMinute(clinic.hours.open))} to ${spokenTime(hhmmMinute(clinic.hours.close))}`;
}

type SaveArgs = z.infer<typeof schemas.save_field>;

/** The caller asked to replace a value, and whether the chart still shows the old one. */
interface Disowned {
  field: FieldId;
  kept: boolean;
}

async function recordField(intake: Intake, args: SaveArgs, deps: ToolDeps): Promise<ToolResult> {
  const context = { country: deps.clinic.country, now: deps.now() };
  const outcome = saveField(
    intake.chart,
    { field: args.field, value: args.value, status: args.status },
    context,
  );
  const disowned = disownment(intake.chart, outcome.chart, args);
  const escalation =
    disowned?.kept === true
      ? (intake.escalation ?? disownedEscalation(disowned.field, deps))
      : intake.escalation;
  if (outcome.chart !== intake.chart || escalation !== intake.escalation) {
    await deps.store.save({ ...intake, chart: outcome.chart, escalation });
  }
  const again = repeatedReadback(outcome.chart, args, outcome.reply, context);
  const reply: ToolResult = { ...outcome.reply, ...(again === undefined ? {} : { say: again }) };
  return disowned === null ? reply : { ...reply, note: replacementNote(reply.note, disowned) };
}

/** Nothing to disown unless the field already held a value the caller has now taken back. */
function disownment(before: Chart, after: Chart, args: SaveArgs): Disowned | null {
  if (args.replaces_earlier_value !== true || !isFieldId(args.field)) return null;
  const earlier = before[args.field].value;
  if (earlier === null) return null;
  return { field: args.field, kept: sameValue(earlier, after[args.field].value) };
}

/**
 * A caller who says "that number is my old one" has told the clinic something,
 * and the chart alone cannot carry it: a value that fails validation leaves the
 * old one standing, graded only as unconfirmed. So the front desk is told in
 * words, and an escalation already on the intake is never overwritten.
 */
function disownedEscalation(field: FieldId, deps: ToolDeps): Escalation {
  const label = FIELDS[field].label.toLowerCase();
  return {
    reason: `The caller said the ${label} on the chart is out of date and asked to replace it. No replacement was recorded, so it must not be treated as current.`,
    urgent: false,
    at: deps.now().getTime(),
  };
}

function replacementNote(note: string | undefined, disowned: Disowned): string {
  const label = FIELDS[disowned.field].label.toLowerCase();
  const tail = disowned.kept
    ? `The ${label} on the chart is the one the caller has just disowned. The front desk has been told. Ask for the new one once more, and never read the old one back as theirs.`
    : `The earlier ${label} is replaced. Do not use it again.`;
  return note === undefined ? tail : `${note} ${tail}`;
}

/**
 * A caller asking to hear a detail again. Only this sentence groups the digits
 * the way the readback did, and the chart reducer stays quiet once a field is
 * confirmed, so the sentence is rebuilt here rather than left to the model.
 */
function repeatedReadback(
  chart: Chart,
  args: SaveArgs,
  reply: ToolReply,
  context: FieldContext,
): string | undefined {
  if (reply.say !== undefined || args.status !== "heard" || !isFieldId(args.field))
    return undefined;
  const spec = FIELDS[args.field];
  if (!spec.critical || chart[args.field].status !== "confirmed") return undefined;
  const parsed = normalise(spec, args.value, context);
  return parsed.ok ? readback(spec, parsed.value) : undefined;
}

async function checkMedication(intake: Intake, name: string, deps: ToolDeps): Promise<ToolResult> {
  const match = await deps.medications.lookup(name);
  await deps.store.save({
    ...intake,
    medicationChecks: [...intake.medicationChecks, { heard: name, match }],
  });
  if (match.kind === "exact") return { ok: true, name: match.name, note: "Use this spelling." };
  if (match.kind === "suggestion") {
    return {
      ok: true,
      say: `Just to check, is that ${match.name}?`,
      note: `If the caller says yes, use ${match.name}. If not, keep the name as they said it.`,
    };
  }
  return { ok: true, note: "Not in the drug list. Keep the name exactly as the caller said it." };
}

async function findSlots(
  args: z.infer<typeof schemas.find_slots>,
  deps: ToolDeps,
): Promise<ToolResult> {
  const { clinic } = deps;
  if (args.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    return { ok: false, note: "Pass the date as YYYY-MM-DD, or leave it out." };
  }
  if (args.doctor_id && !clinic.doctors.some((doctor) => doctor.id === args.doctor_id)) {
    const ids = clinic.doctors.map((doctor) => doctor.id).join(", ");
    return { ok: false, note: `Unknown doctor_id. Use one of: ${ids}.` };
  }
  const slots = openSlots(clinic, {
    now: deps.now(),
    partOfDay: args.part_of_day,
    date: args.date,
    doctorId: args.doctor_id,
    taken: await deps.store.takenSlots(clinic.id),
    limit: 3,
  });
  if (slots.length === 0) {
    const today = clinicNow(clinic.timezone, deps.now()).date;
    return { ok: true, slots: [], note: noSlotsNote(clinic, args, today) };
  }
  return {
    ok: true,
    slots: slots.map((slot) => ({ slot_id: slot.id, time: slot.spoken })),
    note: "Offer these times in words. Never read out a slot_id.",
  };
}

/** The half-open range of minutes each part of the day covers. */
const PART_RANGE: Record<PartOfDay, readonly [number, number]> = {
  morning: [0, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 24 * 60],
  any: [0, 24 * 60],
};

/** Does this clinic's timetable contain any appointment start in that part of the day? */
function clinicOpensIn(clinic: Clinic, part: PartOfDay): boolean {
  const step = clinic.hours.slotMinutes;
  const open = hhmmMinute(clinic.hours.open);
  const [from, until] = PART_RANGE[part];
  const first = open + Math.max(0, Math.ceil((from - open) / step)) * step;
  return first < until && first + step <= hhmmMinute(clinic.hours.close);
}

/**
 * Why there is nothing to offer. "No open times" is the same answer whether the
 * clinic is shut that day, the date is past the booking horizon, or every time
 * is taken, and a caller asking "is the doctor free on Sunday?" deserves the
 * real reason rather than a shrug.
 */
function noSlotsNote(clinic: Clinic, args: z.infer<typeof schemas.find_slots>, today: string) {
  const dated = args.date === undefined ? null : datedReason(clinic, args.date, today);
  if (dated !== null) return dated;
  if (!clinicOpensIn(clinic, args.part_of_day)) {
    return `The clinic has no ${args.part_of_day} appointments at all; it is open ${openingHours(clinic)}. Offer another time of day.`;
  }
  if (args.date === today) return "Nothing is left today. Offer another day.";
  return "Every open time then is already taken. Offer another day or time of day.";
}

function datedReason(clinic: Clinic, date: string, today: string): string | null {
  if (date < today) return `That day has gone; today is ${spokenDay(today)}. Offer another day.`;
  const last = addDays(today, HORIZON_DAYS);
  if (date > last) {
    return `The clinic books ${HORIZON_DAYS} days ahead at most, up to ${spokenDay(last)}. Offer another day.`;
  }
  if (!clinic.hours.days.includes(weekdayOf(date))) {
    return `The clinic is closed on ${DAY_NAMES[weekdayOf(date)]}; it is open ${openingHours(clinic)}. Offer another day.`;
  }
  return null;
}

async function book(intake: Intake, slotId: string, deps: ToolDeps): Promise<ToolResult> {
  const unconfirmed = BOOKING_REQUIRES.filter((id) => intake.chart[id].status !== "confirmed");
  if (unconfirmed.length > 0) {
    const labels = unconfirmed.map((id) => FIELDS[id].label.toLowerCase()).join(", ");
    return { ok: false, note: `Confirm the ${labels} with the caller before booking.` };
  }
  if (intake.booking) {
    return intake.booking.slotId === slotId.trim()
      ? { ok: true, say: `You're booked for ${intake.booking.spoken}.` }
      : {
          ok: false,
          note: `Already booked for ${intake.booking.spoken}. The front desk can change it.`,
        };
  }
  const slot = slotFromId(deps.clinic, slotId, deps.now());
  if (!slot) return { ok: false, note: "That time is not available. Call find_slots again." };
  if (!(await deps.store.claimSlot(deps.clinic.id, slot.id, intake.id))) {
    return { ok: false, note: "Someone has just taken that time. Call find_slots again." };
  }
  const phone = String(intake.chart.phone.value);
  const sent = await deps.sms
    .send(phone, bookingMessage(deps.clinic.name, slot.spoken))
    .catch(() => ({ ok: false }));
  const booking = {
    slotId: slot.id,
    spoken: slot.spoken,
    bookedAt: deps.now().getTime(),
    smsSent: sent.ok,
  };
  await deps.store.save({ ...intake, booking });
  return sent.ok
    ? { ok: true, say: `You're booked for ${slot.spoken}. A text message is on its way.` }
    : {
        ok: true,
        say: `You're booked for ${slot.spoken}.`,
        note: "The text message did not send. Tell the caller the front desk will confirm by phone.",
      };
}

async function escalate(
  intake: Intake,
  args: z.infer<typeof schemas.escalate>,
  deps: ToolDeps,
): Promise<ToolResult> {
  const escalation = { reason: args.reason, urgent: args.urgent, at: deps.now().getTime() };
  await deps.store.save({ ...intake, escalation });
  if (args.urgent) {
    return {
      ok: true,
      end_call: true,
      say: `Please call ${emergencyNumber(deps.clinic)} now. I have told the clinic as well.`,
      note: "Do not continue the intake. Say that sentence once, then stop; the call ends there.",
    };
  }
  return {
    ok: true,
    end_call: true,
    say: "Someone from the front desk will call you back shortly. Goodbye.",
    note: "The front desk has been told and will call them back soon. Say that sentence once, then stop; the call ends there.",
  };
}

async function finish(intake: Intake, deps: ToolDeps): Promise<ToolResult> {
  await deps.store.save({ ...intake, finishedAt: deps.now().getTime() });
  const open = FIELD_IDS.filter((id) => {
    const record = intake.chart[id];
    return FIELDS[id].critical && record.status !== "confirmed" && record.status !== "unresolved";
  });
  if (open.length === 0) {
    return {
      ok: true,
      end_call: true,
      say: farewell(intake),
      note: "Everything needed is confirmed. Say goodbye with that sentence, once, and stop. The call ends there: say nothing after it and call no other tool.",
    };
  }
  const labels = open.map((id) => FIELDS[id].label.toLowerCase()).join(", ");
  return {
    ok: true,
    unconfirmed: open,
    end_call: false,
    note: `Still unconfirmed: ${labels}. Ask for these once, then say goodbye.`,
  };
}

/**
 * The one sentence that ends the call. It is built here so the agent has
 * something exact to say instead of circling a confirmation it has already
 * given; three live calls ended in a goodbye repeated up to seven times.
 */
function farewell(intake: Intake): string {
  if (intake.booking === null) return "Thank you for calling. Goodbye.";
  return intake.booking.smsSent
    ? "Your appointment is booked and the text message is on its way. Thank you for calling. Goodbye."
    : "Your appointment is booked and the front desk will confirm it by phone. Thank you for calling. Goodbye.";
}
