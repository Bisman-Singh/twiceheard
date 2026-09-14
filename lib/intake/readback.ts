import type { FieldSpec, FieldValue } from "@/lib/intake/fields";

/**
 * The sentence the agent reads back before a critical field can be confirmed.
 *
 * It is built here, not by the model, so digits are spoken one at a time in
 * the groups people use, dates never come out in the wrong order, and a list
 * is read in full. The agent is told to say it exactly; the platform's hold
 * mode keeps to that wording.
 */

const DIGIT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
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

export function readback(spec: FieldSpec, value: FieldValue): string {
  switch (spec.kind) {
    case "name":
      return `I have your name as ${String(value)}. Is that right?`;
    case "date":
      return `I have your date of birth as ${spokenDate(String(value))}. Is that right?`;
    case "phone":
      return `I have your number as ${spokenPhone(String(value))}. Is that right?`;
    case "list":
      return listReadback(spec, value as readonly string[]);
    case "text":
      return `I have noted: ${String(value)}. Is that right?`;
  }
}

/** "1990-03-12" becomes "12 March 1990", the order used in India and the UK. */
export function spokenDate(iso: string): string {
  const day = Number(iso.slice(8, 10));
  const month = MONTHS[Number(iso.slice(5, 7)) - 1];
  return `${day} ${month} ${iso.slice(0, 4)}`;
}

/** "+919876543210" becomes "nine eight seven six five, four three two one zero". */
export function spokenPhone(e164: string): string {
  const national = e164.startsWith("+91") ? e164.slice(3) : e164.slice(2);
  const groups = e164.startsWith("+91")
    ? [national.slice(0, 5), national.slice(5)]
    : [national.slice(0, 3), national.slice(3, 6), national.slice(6)];
  return groups
    .map((group) => [...group].map((digit) => DIGIT_WORDS[Number(digit)]).join(" "))
    .join(", ");
}

function listReadback(spec: FieldSpec, items: readonly string[]): string {
  if (spec.id === "allergies" && items.length === 0) {
    return "I have that you have no known allergies. Is that right?";
  }
  if (items.length === 0) {
    return "I have that you are not taking any regular medications. Is that right?";
  }
  const joined =
    items.length === 1
      ? items[0]
      : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const noun = spec.id === "allergies" ? "allergies" : "medications";
  return `I have your ${noun} as ${joined}. Is that the complete list?`;
}
