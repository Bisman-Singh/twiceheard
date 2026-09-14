import { z } from "zod";
import type { Clinic } from "@/lib/clinic/config";
import { saveField } from "@/lib/intake/chart";
import { FIELDS, FIELD_IDS, type FieldId } from "@/lib/intake/fields";
import { canonicalIntakeId, newIntake, newIntakeId, type Intake } from "@/lib/intake/intake";
import type { IntakeStore } from "@/lib/intake/store";
import type { MedicationLookup } from "@/lib/medication/rxnorm";
import { bookingMessage, type Messenger } from "@/lib/notify/sms";
import { clinicNow, openSlots, slotFromId, spokenDay, spokenTime } from "@/lib/scheduling/slots";
import { emergencyNumber } from "@/lib/voice-agent/prompt";
import type { ToolName } from "@/lib/voice-agent/tools";

/**
 * What each tool does when the agent calls it.
 *
 * Handlers take plain arguments and return a small JSON object the platform
 * feeds back to the model: `say` is spoken verbatim, `note` steers the next
 * step, and anything else is data for the model to use. They never throw for
 * a bad request from the model; they explain what to do instead, because a
 * thrown error on a live call is a silence the caller has to sit through.
 */

export interface ToolDeps {
  clinic: Clinic;
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
  return intake && intake.clinicId === deps.clinic.id ? intake : null;
}

async function startIntake(deps: ToolDeps): Promise<ToolResult> {
  const now = deps.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const intake = newIntake((deps.newId ?? newIntakeId)(), deps.clinic.id, now);
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
  const minute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return `${ranges.join(" and ")}, ${spokenTime(minute(clinic.hours.open))} to ${spokenTime(minute(clinic.hours.close))}`;
}

async function recordField(
  intake: Intake,
  args: z.infer<typeof schemas.save_field>,
  deps: ToolDeps,
): Promise<ToolResult> {
  const context = { country: deps.clinic.country, now: deps.now() };
  const outcome = saveField(
    intake.chart,
    { field: args.field, value: args.value, status: args.status },
    context,
  );
  if (outcome.chart !== intake.chart) await deps.store.save({ ...intake, chart: outcome.chart });
  return { ...outcome.reply };
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
    return {
      ok: true,
      slots: [],
      note: "No open times for that. Ask about another day or time of day.",
    };
  }
  return {
    ok: true,
    slots: slots.map((slot) => ({ slot_id: slot.id, time: slot.spoken })),
    note: "Offer these times in words. Never read out a slot_id.",
  };
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
      say: `Please call ${emergencyNumber(deps.clinic)} now. I have told the clinic as well.`,
      note: "Do not continue the intake.",
    };
  }
  return {
    ok: true,
    note: "The front desk has been told. Tell the caller someone will call them back soon.",
  };
}

async function finish(intake: Intake, deps: ToolDeps): Promise<ToolResult> {
  await deps.store.save({ ...intake, finishedAt: deps.now().getTime() });
  const open = FIELD_IDS.filter((id) => {
    const record = intake.chart[id];
    return FIELDS[id].critical && record.status !== "confirmed" && record.status !== "unresolved";
  });
  if (open.length === 0) return { ok: true, note: "Everything needed is confirmed. Say goodbye." };
  const labels = open.map((id) => FIELDS[id].label.toLowerCase()).join(", ");
  return {
    ok: true,
    unconfirmed: open,
    note: `Still unconfirmed: ${labels}. Ask for these once, then say goodbye.`,
  };
}
