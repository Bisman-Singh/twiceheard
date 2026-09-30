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
  /** The clinic's IANA zone. Without it, the usual zone for the country is assumed. */
  timezone?: string;
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

/**
 * "No" in the words callers actually use, including Hindi written in Latin letters.
 * A caller who answers the allergies question with "nahi" must not be charted as
 * allergic to a word, which is what happened before the romanised forms were here.
 */
const NEGATIVES = new Set([
  "no",
  "none",
  "nil",
  "nope",
  "not",
  "never",
  "nothing",
  "nahi",
  "nahin",
  "नहीं",
  "नही",
]);

/** "koi nahi" and "kuch nahi" open with a quantifier before the "no" arrives. */
const QUANTIFIERS = new Set(["koi", "kuch", "kuchh", "कोई", "कुछ"]);

/** Words that carry nothing in a denial: "no known allergies", "nothing at the moment". */
const DENIAL_FILLER = new Set([
  "a",
  "actually",
  "all",
  "am",
  "an",
  "any",
  "anything",
  "at",
  "currently",
  "else",
  "far",
  "for",
  "had",
  "hai",
  "hain",
  "has",
  "have",
  "i",
  "just",
  "known",
  "me",
  "moment",
  "my",
  "new",
  "now",
  "of",
  "on",
  "other",
  "others",
  "present",
  "really",
  "regular",
  "regularly",
  "right",
  "so",
  "take",
  "takes",
  "taking",
  "that",
  "the",
  "them",
  "this",
  "time",
  "to",
  "है",
  "हैं",
]);

/** The nouns each list field owns, so "no known drug allergies" reads as a denial. */
const ALLERGY_NOUNS = new Set([
  "allergen",
  "allergens",
  "allergic",
  "allergies",
  "allergy",
  "drug",
  "drugs",
  "food",
  "foods",
  "medication",
  "medications",
  "medicine",
  "medicines",
  "reaction",
  "reactions",
]);
const MEDICATION_NOUNS = new Set([
  "dawai",
  "drug",
  "drugs",
  "med",
  "medication",
  "medications",
  "medicine",
  "medicines",
  "meds",
  "pill",
  "pills",
  "prescription",
  "prescriptions",
  "tablet",
  "tablets",
]);

const MAX_TEXT = 300;
const MAX_ITEMS = 20;
const MAX_AGE_YEARS = 120;

/** The zone assumed when the caller's clinic did not say which one it keeps. */
const DEFAULT_TIMEZONE: Record<Country, string> = { IN: "Asia/Kolkata", US: "America/New_York" };

/** Turn what the model passed into the stored form, or say what to ask again. */
export function normalise(spec: FieldSpec, raw: string, context: FieldContext): Normalised {
  const text = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (text.length === 0) return { ok: false, problem: `No ${spec.label.toLowerCase()} was given.` };
  switch (spec.kind) {
    case "name":
      return normaliseName(text);
    case "date":
      return normaliseDate(text, context);
    case "phone":
      return normalisePhone(text, context.country);
    case "list":
      return normaliseList(spec, text);
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

/** The clinic's own calendar date, which is the day a caller means by "today". */
function clinicToday(context: FieldContext): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timezone ?? DEFAULT_TIMEZONE[context.country],
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(context.now);
  const part = Object.fromEntries(parts.map((item) => [item.type, item.value])) as Record<
    string,
    string
  >;
  return `${part.year}-${part.month}-${part.day}`;
}

/** Whole years lived, so a birthday still to come this year has not been counted yet. */
function ageOn(birth: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
  return today.slice(5) < birth.slice(5) ? years - 1 : years;
}

function normaliseDate(text: string, context: FieldContext): Normalised {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const retry = "Ask for the date of birth again and pass it as YYYY-MM-DD.";
  if (!match) return { ok: false, problem: `The date must be YYYY-MM-DD. ${retry}` };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real) return { ok: false, problem: `That is not a real calendar date. ${retry}` };
  // Both sides are calendar dates in the clinic's own zone. Comparing the date against a
  // UTC instant refused a birth date the clinic had already reached, hours into its day.
  const today = clinicToday(context);
  if (text > today) {
    return { ok: false, problem: `A date of birth cannot be in the future. ${retry}` };
  }
  if (ageOn(text, today) > MAX_AGE_YEARS) {
    return { ok: false, problem: `That would make the caller over ${MAX_AGE_YEARS}. ${retry}` };
  }
  return { ok: true, value: text };
}

/** Phone numbers are stored in E.164, the one form a messaging provider will accept. */
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

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Marks are kept: a Devanagari vowel sign is part of its word, not punctuation.
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 0)
  );
}

/**
 * The words that name one list field, so a denial can be tied to the question it
 * answered. The second hearing needs the same binding the live side has: without it
 * a caller's "no" to "have you been here before?" reads as a denial of everything.
 */
export function fieldNouns(spec: FieldSpec): ReadonlySet<string> {
  return spec.id === "allergies" ? ALLERGY_NOUNS : MEDICATION_NOUNS;
}

function listNouns(spec: FieldSpec): ReadonlySet<string> {
  return fieldNouns(spec);
}

/**
 * A denial is a leading "no" followed by nothing but filler and the field's own noun.
 * Matching a fixed set of whole sentences let "no known drug allergies" and "not taking
 * anything" through as list items, and the clinic then read them as allergies the
 * patient has.
 */
function isDenial(spec: FieldSpec, text: string): boolean {
  const tokens = words(text).filter((token, index) => !(index === 0 && QUANTIFIERS.has(token)));
  const first = tokens[0];
  if (first === undefined || !NEGATIVES.has(first)) return false;
  const nouns = listNouns(spec);
  return tokens.every(
    (token) => NEGATIVES.has(token) || DENIAL_FILLER.has(token) || nouns.has(token),
  );
}

/** Items arrive separated by semicolons, commas or "and"; "none" is an answer, not a gap. */
function normaliseList(spec: FieldSpec, text: string): Normalised {
  if (isDenial(spec, text)) return { ok: true, value: [] };
  const items = text
    .split(/[;,]| and /i)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) return { ok: false, problem: "Nothing was listed. Ask again." };
  if (items.length > MAX_ITEMS) return { ok: false, problem: "That list is too long to confirm." };
  // A denial worded in a way the pattern missed would otherwise be charted as something
  // the patient has, which is the dangerous direction to be wrong in.
  if (
    items.some((item) =>
      words(item)
        .slice(0, 1)
        .some((word) => NEGATIVES.has(word)),
    )
  ) {
    return {
      ok: false,
      problem: "That sounds like a no. Ask again, and pass none if there is nothing to list.",
    };
  }
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
