import type { Clinic } from "@/lib/clinic/config";

/**
 * Open appointment times, in the clinic's own time zone.
 *
 * Times are wall-clock strings local to the clinic ("2026-09-15T09:20"), so a
 * slot means the same thing to the caller, the front desk and the calendar.
 * A slot id names the doctor and the start; booking parses it again and
 * rejects anything the clinic does not actually offer, so the model can
 * offer only what this module produced.
 */

export type PartOfDay = "morning" | "afternoon" | "evening" | "any";

export interface Slot {
  id: string;
  doctorId: string;
  /** Clinic-local start, YYYY-MM-DDTHH:MM. */
  start: string;
  /** How the agent says it: "Tuesday 15 September at 9:20 am with Dr. Neha Kapoor". */
  spoken: string;
}

export interface SlotQuery {
  now: Date;
  partOfDay: PartOfDay;
  date?: string;
  doctorId?: string;
  taken: ReadonlySet<string>;
  limit: number;
}

/** No booking for a time sooner than this, so a patient has time to get there. */
export const LEAD_MINUTES = 60;
/** How far ahead a caller can book. */
export const HORIZON_DAYS = 14;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The clinic's current date and minute of the day. */
export function clinicNow(timezone: string, now: Date): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = Object.fromEntries(parts.map((item) => [item.type, item.value])) as Record<
    string,
    string
  >;
  return {
    date: `${part.year}-${part.month}-${part.day}`,
    minute: Number(part.hour) * 60 + Number(part.minute),
  };
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toClock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

function inPart(minute: number, part: PartOfDay): boolean {
  if (part === "morning") return minute < 12 * 60;
  if (part === "afternoon") return minute >= 12 * 60 && minute < 17 * 60;
  if (part === "evening") return minute >= 17 * 60;
  return true;
}

/** "Tuesday 15 September". */
export function spokenDay(date: string): string {
  return `${WEEKDAYS[weekday(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

/** "9:20 am", "12 noon", "5:40 pm". */
export function spokenTime(minute: number): string {
  if (minute === 12 * 60) return "12 noon";
  const hour = Math.floor(minute / 60) % 12 || 12;
  const mins = minute % 60;
  const suffix = minute < 12 * 60 ? "am" : "pm";
  return mins === 0 ? `${hour} ${suffix}` : `${hour}:${String(mins).padStart(2, "0")} ${suffix}`;
}

export function slotId(doctorId: string, date: string, minute: number): string {
  return `${doctorId}_${date.replaceAll("-", "")}T${toClock(minute).replace(":", "")}`;
}

/** Days worth searching: the one asked for, or every day from today to the horizon. */
function candidateDays(today: string, date: string | undefined): string[] {
  const horizon = Array.from({ length: HORIZON_DAYS + 1 }, (_, i) => addDays(today, i));
  return date === undefined ? horizon : horizon.filter((day) => day === date);
}

export function openSlots(clinic: Clinic, query: SlotQuery): Slot[] {
  const today = clinicNow(clinic.timezone, query.now);
  const found: Slot[] = [];
  for (const date of candidateDays(today.date, query.date)) {
    if (!clinic.hours.days.includes(weekday(date))) continue;
    // A day's times come out in order, so the first `limit` across days are the earliest.
    const earliest = date === today.date ? today.minute + LEAD_MINUTES : 0;
    found.push(...slotsOnDay(clinic, date, earliest, query));
    if (found.length >= query.limit) return found.slice(0, query.limit);
  }
  return found;
}

/** Every free time on one day from `earliest` on, in time order, each doctor in clinic order. */
function slotsOnDay(clinic: Clinic, date: string, earliest: number, query: SlotQuery): Slot[] {
  const doctors = clinic.doctors.filter(
    (doctor) => !query.doctorId || doctor.id === query.doctorId,
  );
  const step = clinic.hours.slotMinutes;
  const close = toMinute(clinic.hours.close);
  const slots: Slot[] = [];
  for (let minute = toMinute(clinic.hours.open); minute + step <= close; minute += step) {
    if (minute < earliest || !inPart(minute, query.partOfDay)) continue;
    const free = doctors.filter((doctor) => !query.taken.has(slotId(doctor.id, date, minute)));
    slots.push(
      ...free.map((doctor) => ({
        id: slotId(doctor.id, date, minute),
        doctorId: doctor.id,
        start: `${date}T${toClock(minute)}`,
        spoken: `${spokenDay(date)} at ${spokenTime(minute)} with ${doctor.name}`,
      })),
    );
  }
  return slots;
}

/** What a slot id names, whether or not it is still open: for records written after the call. */
export function describeSlotId(clinic: Clinic, id: string): Slot | null {
  // The clock is matched digit by digit rather than parsed: reading 09:60 as 10:00 booked
  // a time nobody offered, and 99:00 was described as a start that cannot happen.
  const match = /^([a-z0-9-]+)_(\d{4})(\d{2})(\d{2})T([01]\d|2[0-3])([0-5]\d)$/.exec(id.trim());
  if (!match) return null;
  const [, doctorId, year, month, day, hour, mins] = match as unknown as string[];
  const doctor = clinic.doctors.find((candidate) => candidate.id === doctorId);
  if (!doctor) return null;
  const date = `${year}-${month}-${day}`;
  const minute = Number(hour) * 60 + Number(mins);
  return {
    id: slotId(doctor.id, date, minute),
    doctorId: doctor.id,
    start: `${date}T${toClock(minute)}`,
    spoken: `${spokenDay(date)} at ${spokenTime(minute)} with ${doctor.name}`,
  };
}

/** The slot an id names, if the clinic really offers it at that time. */
export function slotFromId(clinic: Clinic, id: string, now: Date): Slot | null {
  const named = describeSlotId(clinic, id);
  if (!named) return null;
  const offered = openSlots(clinic, {
    now,
    partOfDay: "any",
    date: named.start.slice(0, 10),
    doctorId: named.doctorId,
    taken: new Set(),
    limit: 1_000,
  });
  return offered.find((slot) => slot.id === named.id) ?? null;
}
