/**
 * The intake form, field by field.
 *
 * Each field declares how a spoken value is normalised, what makes it valid,
 * and whether it is critical. Critical fields are the ones a clinic cannot
 * act on without an explicit yes from the caller: who they are, how to reach
 * them, and what could hurt them. Everything here is pure, so the same rules
 * apply whichever voice engine is on the call.
 */

export const FIELD_IDS = [
  "full_name",
  "date_of_birth",
  "phone",
  "reason_for_visit",
  "medications",
  "allergies",
  "preferred_time",
] as const;

export type FieldId = (typeof FIELD_IDS)[number];

/** A scalar answer, or a list where an empty list means the caller said "none". */
export type FieldValue = string | readonly string[];

export type FieldKind = "name" | "date" | "phone" | "text" | "list";

/** Where the clinic is, which decides how a bare phone number is read. */
export type Country = "IN" | "US";

export interface FieldContext {
  country: Country;
  now: Date;
}

export interface FieldSpec {
  id: FieldId;
  label: string;
  kind: FieldKind;
  critical: boolean;
}

export const FIELDS: Record<FieldId, FieldSpec> = {
  full_name: { id: "full_name", label: "Full name", kind: "name", critical: true },
  date_of_birth: { id: "date_of_birth", label: "Date of birth", kind: "date", critical: true },
  phone: { id: "phone", label: "Phone number", kind: "phone", critical: true },
  reason_for_visit: {
    id: "reason_for_visit",
    label: "Reason for visit",
    kind: "text",
    critical: false,
  },
  medications: { id: "medications", label: "Current medications", kind: "list", critical: true },
  allergies: { id: "allergies", label: "Allergies", kind: "list", critical: true },
  preferred_time: {
    id: "preferred_time",
    label: "Preferred time",
    kind: "text",
    critical: false,
  },
};

export function isFieldId(value: string): value is FieldId {
  return (FIELD_IDS as readonly string[]).includes(value);
}

export type Normalised = { ok: true; value: FieldValue } | { ok: false; problem: string };

const NONE =
  /^(none|no|nil|nothing|no known allergies|no allergies|no medications?|कोई नहीं|नहीं)$/i;
const MAX_TEXT = 300;
const MAX_ITEMS = 20;
const MAX_AGE_YEARS = 120;

/** Turn what the model passed into the stored form, or say what to ask again. */
export function normalise(spec: FieldSpec, raw: string, context: FieldContext): Normalised {
  const text = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (text.length === 0) return { ok: false, problem: `No ${spec.label.toLowerCase()} was given.` };
  switch (spec.kind) {
    case "name":
      return normaliseName(text);
    case "date":
      return normaliseDate(text, context.now);
    case "phone":
      return normalisePhone(text, context.country);
    case "list":
      return normaliseList(text);
    case "text":
      return { ok: true, value: text.slice(0, MAX_TEXT) };
  }
}

function normaliseName(text: string): Normalised {
  if (!/\p{L}/u.test(text) || text.length < 2 || text.length > 100) {
    return { ok: false, problem: "That does not sound like a name. Ask for the full name again." };
  }
  return { ok: true, value: text };
}

function normaliseDate(text: string, now: Date): Normalised {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const retry = "Ask for the date of birth again and pass it as YYYY-MM-DD.";
  if (!match) return { ok: false, problem: `The date must be YYYY-MM-DD. ${retry}` };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real) return { ok: false, problem: `That is not a real calendar date. ${retry}` };
  if (date.getTime() > now.getTime()) {
    return { ok: false, problem: `A date of birth cannot be in the future. ${retry}` };
  }
  if (now.getUTCFullYear() - year > MAX_AGE_YEARS) {
    return { ok: false, problem: `That would make the caller over ${MAX_AGE_YEARS}. ${retry}` };
  }
  return { ok: true, value: text };
}

/** Phone numbers are stored in E.164 so the SMS adapter and the EMR agree. */
function normalisePhone(text: string, country: Country): Normalised {
  const digits = text.replace(/\D/g, "");
  const e164 = country === "IN" ? indianNumber(digits) : usNumber(digits);
  if (!e164) {
    return { ok: false, problem: "That phone number has the wrong number of digits. Ask again." };
  }
  return { ok: true, value: e164 };
}

function indianNumber(digits: string): string | null {
  const national =
    digits.length === 12 && digits.startsWith("91")
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith("0")
        ? digits.slice(1)
        : digits;
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : null;
}

function usNumber(digits: string): string | null {
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? `+1${national}` : null;
}

/** Items arrive separated by semicolons; "none" is an answer, not a gap. */
function normaliseList(text: string): Normalised {
  if (NONE.test(text.replace(/[.!]$/, ""))) return { ok: true, value: [] };
  const items = text
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) return { ok: false, problem: "Nothing was listed. Ask again." };
  if (items.length > MAX_ITEMS) return { ok: false, problem: "That list is too long to confirm." };
  return { ok: true, value: items.map((item) => item.slice(0, MAX_TEXT)) };
}

/** Two values are the same answer if they only differ in case, order or spacing. */
export function sameValue(a: FieldValue | null, b: FieldValue | null): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") {
    return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  }
  const left = [...a].map((item) => item.toLowerCase()).sort();
  const right = [...b].map((item) => item.toLowerCase()).sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
