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

/** A token with the number it stands for, when the caller said it as a word. */
interface Counted extends Token {
  value: number | null;
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
/** How far past a "no" the denial still reaches: "I do not currently take metformin". */
const NEGATION_REACH = 4;
/** Fewer digits than this is a house number or an age, not a phone number. */
const PHONE_DIGITS = 7;
/** A two-part spoken year only reads as a year inside these bounds. */
const EARLIEST_YEAR = 1900;
const LATEST_YEAR = 2099;

const ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const ORDINALS =
  "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth".split(
    " ",
  );

/**
 * A transcriber writes a number however it heard it, so a phone number can arrive as
 * "nine eight seven" and a year as "nineteen eighty five". Left as words they are
 * invisible to every digit check below, which reported a correct field as absent.
 */
const NUMBER_FOR_WORD = new Map<string, number>([
  ...ONES.map((word, index) => [word, index] as const),
  ...TENS.map((word, index) => [word, (index + 2) * 10] as const),
  ...ORDINALS.map((word, index) => [word, index + 1] as const),
  ["oh", 0],
  ["twentieth", 20],
  ["thirtieth", 30],
]);
const TENS_VALUES = new Set(TENS.map((_word, index) => (index + 2) * 10));

/** "eighty five" is one number, 85, not eighty followed by five. */
function joinTensAndUnit(tens: number, unit: number): number | null {
  return TENS_VALUES.has(tens) && unit >= 1 && unit <= 9 ? tens + unit : null;
}

/** "nineteen eighty five" is 1985, and "ninety eight seven" is still two numbers. */
function joinYear(first: number, second: number): number | null {
  const year = first * 100 + second;
  return first >= 10 && year >= EARLIEST_YEAR && year <= LATEST_YEAR ? year : null;
}

/** One spoken word as the tokens it holds: "12/03" is two, "Kumar-Sharma" is two. */
function spell(word: HeardWord): Counted[] {
  return word.text
    .toLowerCase()
    .split(/[/\-]/)
    .map((part) => part.replace(/[^\p{L}\p{N}']/gu, "").replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
    .filter((part) => part.length > 0)
    .map((token) => ({
      token,
      confidence: word.confidence,
      // Only a number said as a word is joined to its neighbour; digits stay as transcribed.
      value: NUMBER_FOR_WORD.get(token) ?? null,
    }));
}

/** Neighbouring spoken numbers the caller meant as one, scored by the weaker word. */
function fusePairs(
  said: Counted[],
  join: (first: number, second: number) => number | null,
): Counted[] {
  const out: Counted[] = [];
  let joined = false;
  for (const [index, left] of said.entries()) {
    if (joined) {
      joined = false;
      continue;
    }
    const right = said[index + 1];
    const value =
      left.value !== null && right !== undefined && right.value !== null
        ? join(left.value, right.value)
        : null;
    if (value === null || right === undefined) {
      out.push(left);
      continue;
    }
    out.push({
      token: String(value),
      confidence: Math.min(left.confidence, right.confidence),
      value,
    });
    joined = true;
  }
  return out;
}

/**
 * Lower-case, punctuation off, ordinals reduced, numbers as digits: "12th," becomes "12"
 * and "nineteen eighty five" becomes "1985".
 */
export function tokens(words: Utterance): Token[] {
  const said = words.flatMap(spell);
  // A number said as a word is kept as the number, so every digit check below sees it.
  return fusePairs(fusePairs(said, joinTensAndUnit), joinYear).map((item) => ({
    token: item.value === null ? item.token : String(item.value),
    confidence: item.confidence,
  }));
}

/** A wanted value read the way the recording is, so "Kumar-Sharma" can match what was said. */
function tokenise(text: string): Token[] {
  return tokens(text.split(/\s+/).map((word) => ({ text: word, confidence: 1, start: 0, end: 0 })));
}

export function verifyValue(
  spec: FieldSpec,
  value: FieldValue,
  caller: readonly Utterance[],
): Verification | null {
  const spoken = caller.map(tokens);
  switch (spec.kind) {
    case "name":
      return verifySequence(
        tokenise(String(value)).map((item) => item.token),
        spoken,
      );
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
  if (wanted.length === 0) return ABSENT;
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

interface WantedDate {
  day: number;
  month: string;
  monthNumber: number;
  year: string;
}

// Numbers compare as numbers here, so "03" said or written still means March.
const isNumber = (token: string, number: number) =>
  /^\d{1,2}$/.test(token) && Number(token) === number;

/**
 * Year, month and day inside one window. When the day and the month are the same number
 * one token has to do both jobs, so every token that could be the month is tried in turn.
 */
function datePartsIn(window: Token[], want: WantedDate): Token[] | null {
  const year = window.find((item) => item.token === want.year);
  if (!year) return null;
  const months = window.filter(
    (item) => item.token === want.month || isNumber(item.token, want.monthNumber),
  );
  const days = window.filter((item) => isNumber(item.token, want.day));
  for (const month of months) {
    const day = days.find((item) => item !== month);
    if (day) return [year, month, day];
  }
  return null;
}

/** Day, month and year close together, in any order people say them. */
function verifyDate(iso: string, spoken: Token[][]): Verification {
  const want: WantedDate = {
    day: Number(iso.slice(8, 10)),
    month: MONTHS[Number(iso.slice(5, 7)) - 1] as string,
    monthNumber: Number(iso.slice(5, 7)),
    year: iso.slice(0, 4),
  };
  let best: number | null = null;
  let sawADate = false;
  for (const utterance of spoken) {
    sawADate ||= utterance.some(
      (item) => MONTHS.includes(item.token) || /^(19|20)\d{2}$/.test(item.token),
    );
    for (let start = 0; start < utterance.length; start += 1) {
      const found = datePartsIn(utterance.slice(start, start + DATE_WINDOW), want);
      if (found) best = Math.max(best ?? 0, lowest(found));
    }
  }
  if (best !== null) return { hearing: "agrees", minConfidence: best };
  return sawADate ? { hearing: "differs", minConfidence: null } : ABSENT;
}

/** The national number as a run of digits, however the words were split. */
function verifyDigits(e164: string, spoken: Token[][]): Verification {
  const national = e164.startsWith("+91") ? e164.slice(3) : e164.slice(2);
  // Callers stop for breath in the middle of a number, so the digits are read as one
  // run across the utterances; each token keeps its own score for the reading below.
  const digitTokens = spoken.flat().filter((item) => /^\d+$/.test(item.token));
  const stream = digitTokens.map((item) => item.token).join("");
  const at = stream.indexOf(national);
  if (at === -1) {
    return stream.length >= PHONE_DIGITS ? { hearing: "differs", minConfidence: null } : ABSENT;
  }
  const used = coveringTokens(digitTokens, at, national.length);
  return { hearing: "agrees", minConfidence: lowest(used) };
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
  return tokenise(item).find((token) => /\p{L}/u.test(token.token))?.token ?? item.toLowerCase();
}

/** The words the caller stated, with everything a denial covers left out. */
function affirmed(utterance: Token[]): Token[] {
  let deniedUntil = -1;
  const stated: Token[] = [];
  for (const [index, item] of utterance.entries()) {
    if (NEGATIVE.has(item.token)) deniedUntil = index + NEGATION_REACH;
    else if (index > deniedUntil) stated.push(item);
  }
  return stated;
}

/** An empty list is only agreed to by a clear "no". */
function verifyNone(all: Token[]): Verification {
  const negative = all.filter((item) => NEGATIVE.has(item.token));
  return negative.length > 0
    ? { hearing: "agrees", minConfidence: Math.max(...negative.map((item) => item.confidence)) }
    : ABSENT;
}

/** Each item's first word, or a clear "no" for an empty list. */
function verifyList(items: readonly string[], spoken: Token[][]): Verification {
  if (items.length === 0) return verifyNone(spoken.flat());
  const keys = items.map((item) => keyWord(item));
  // "I do not take metformin any more" names the drug to deny it, which is not a list.
  const stated = spoken.flatMap(affirmed);
  const hits = keys
    .map((key) => stated.find((item) => item.token === key))
    .filter((item): item is Token => item !== undefined);
  if (hits.length === keys.length) return { hearing: "agrees", minConfidence: lowest(hits) };
  return hits.length > 0 ? { hearing: "differs", minConfidence: lowest(hits) } : ABSENT;
}
