import type { FieldSpec, FieldValue } from "@/lib/intake/fields";
import type { Verification } from "@/lib/intake/grade";

/**
 * The second hearing: find a confirmed value in the caller's own words.
 *
 * After the call, the stored recording is transcribed again with every word
 * scored for confidence, the caller and the agent on separate channels. This
 * module takes the caller's words and asks, for one field, whether the value
 * the chart holds is actually there, and how sure the transcription was about
 * the words that carry it. It is pure; fetching and transcribing live in the
 * adapter that feeds it.
 */

export interface HeardWord {
  text: string;
  confidence: number;
  start: number;
  end: number;
}

/** One stretch of the caller speaking. */
export type Utterance = readonly HeardWord[];

interface Token {
  token: string;
  confidence: number;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const NEGATIVE = new Set(["no", "none", "nothing", "not", "nil", "don't", "dont", "नहीं"]);
/** How many words a spoken date may spread across: "the 12th of March, 1990". */
const DATE_WINDOW = 8;

/** Lower-case, punctuation off, ordinals reduced: "12th," becomes "12". */
export function tokens(words: Utterance): Token[] {
  return words.flatMap((word) =>
    word.text
      .toLowerCase()
      .split(/[/\-]/)
      .map((part) => part.replace(/[^\p{L}\p{N}']/gu, "").replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
      .filter((part) => part.length > 0)
      .map((token) => ({ token, confidence: word.confidence })),
  );
}

export function verifyValue(
  spec: FieldSpec,
  value: FieldValue,
  caller: readonly Utterance[],
): Verification | null {
  const spoken = caller.map(tokens);
  switch (spec.kind) {
    case "name":
      return verifySequence(String(value).toLowerCase().split(/\s+/), spoken);
    case "date":
      return verifyDate(String(value), spoken);
    case "phone":
      return verifyDigits(String(value), spoken);
    case "list":
      return verifyList(value as readonly string[], spoken);
    case "text":
      return null;
  }
}

const ABSENT: Verification = { hearing: "absent", minConfidence: null };

function lowest(found: readonly Token[]): number {
  return Math.min(...found.map((item) => item.confidence));
}

/** The best stretch of an utterance that says every word in order. */
function verifySequence(wanted: string[], spoken: Token[][]): Verification {
  let best: number | null = null;
  let partial: Token[] = [];
  for (const utterance of spoken) {
    for (let start = 0; start < utterance.length; start += 1) {
      const run = utterance.slice(start, start + wanted.length);
      if (
        run.length === wanted.length &&
        run.every((item, index) => item.token === wanted[index])
      ) {
        best = Math.max(best ?? 0, lowest(run));
      }
    }
    const matched = utterance.filter((item) => wanted.includes(item.token));
    if (matched.length > partial.length) partial = matched;
  }
  if (best !== null) return { hearing: "agrees", minConfidence: best };
  return partial.length > 0 ? { hearing: "differs", minConfidence: lowest(partial) } : ABSENT;
}

/** Day, month and year close together, in any order people say them. */
function verifyDate(iso: string, spoken: Token[][]): Verification {
  const want = {
    day: Number(iso.slice(8, 10)),
    month: MONTHS[Number(iso.slice(5, 7)) - 1] as string,
    monthNumber: Number(iso.slice(5, 7)),
    year: iso.slice(0, 4),
  };
  // Numbers compare as numbers here, so "03" said or written still means March.
  const isNumber = (token: string, number: number) =>
    /^\d{1,2}$/.test(token) && Number(token) === number;
  let best: number | null = null;
  let sawADate = false;
  for (const utterance of spoken) {
    sawADate ||= utterance.some(
      (item) => MONTHS.includes(item.token) || /^(19|20)\d{2}$/.test(item.token),
    );
    for (let start = 0; start < utterance.length; start += 1) {
      const window = utterance.slice(start, start + DATE_WINDOW);
      const year = window.find((item) => item.token === want.year);
      const month = window.find(
        (item) => item.token === want.month || isNumber(item.token, want.monthNumber),
      );
      const day = window.find((item) => isNumber(item.token, want.day) && item !== month);
      if (year && month && day) best = Math.max(best ?? 0, lowest([year, month, day]));
    }
  }
  if (best !== null) return { hearing: "agrees", minConfidence: best };
  return sawADate ? { hearing: "differs", minConfidence: null } : ABSENT;
}

/** The national number as a run of digits, however the words were split. */
function verifyDigits(e164: string, spoken: Token[][]): Verification {
  const national = e164.startsWith("+91") ? e164.slice(3) : e164.slice(2);
  let sawDigits = false;
  for (const utterance of spoken) {
    const digitTokens = utterance.filter((item) => /^\d+$/.test(item.token));
    const stream = digitTokens.map((item) => item.token).join("");
    sawDigits ||= stream.length >= 7;
    const at = stream.indexOf(national);
    if (at === -1) continue;
    const used = coveringTokens(digitTokens, at, national.length);
    return { hearing: "agrees", minConfidence: lowest(used) };
  }
  return sawDigits ? { hearing: "differs", minConfidence: null } : ABSENT;
}

/** The tokens whose digits make up the characters [from, from + length). */
function coveringTokens(digitTokens: readonly Token[], from: number, length: number): Token[] {
  const used: Token[] = [];
  let offset = 0;
  for (const item of digitTokens) {
    const end = offset + item.token.length;
    if (end > from && offset < from + length) used.push(item);
    offset = end;
  }
  return used;
}

/** The word that names an item: "Metformin 500 mg twice daily" is found by "metformin". */
function keyWord(item: string): string {
  const words = item.split(/\s+/).map((text) => ({ text, confidence: 1, start: 0, end: 0 }));
  return tokens(words).find((token) => /\p{L}/u.test(token.token))?.token ?? item.toLowerCase();
}

/** Each item's first word, or a clear "no" for an empty list. */
function verifyList(items: readonly string[], spoken: Token[][]): Verification {
  const all = spoken.flat();
  if (items.length === 0) {
    const negative = all.filter((item) => NEGATIVE.has(item.token));
    return negative.length > 0
      ? { hearing: "agrees", minConfidence: Math.max(...negative.map((n) => n.confidence)) }
      : ABSENT;
  }
  const keys = items.map((item) => keyWord(item));
  const found = keys.map((key) => all.find((item) => item.token === key));
  const hits = found.filter((item): item is Token => item !== undefined);
  if (hits.length === keys.length) return { hearing: "agrees", minConfidence: lowest(hits) };
  return hits.length > 0 ? { hearing: "differs", minConfidence: lowest(hits) } : ABSENT;
}
