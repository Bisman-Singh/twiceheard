import { FIELDS, fieldNouns, type FieldSpec, type FieldValue } from "@/lib/intake/fields";
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
/**
 * A denial, in either language the caller may use. The intake side accepts the
 * Hindi forms too, so leaving them out here meant a caller who plainly denied an
 * allergy in Hindi was reported as never having denied it, and the clinic saw
 * amber on a field that was answered clearly.
 */
const NEGATIVE = new Set([
  "no",
  "none",
  "nothing",
  "not",
  "nil",
  "don't",
  "dont",
  "nope",
  "never",
  "nahi",
  "nahin",
  "नहीं",
  "नही",
]);
/** Words that carry no meaning of their own inside a denial. */
const DENIAL_FILLER = new Set([
  "a",
  "all",
  "am",
  "an",
  "any",
  "anything",
  "at",
  "currently",
  "do",
  "dont",
  "don't",
  "else",
  "for",
  "had",
  "hai",
  "hain",
  "has",
  "have",
  "i",
  "is",
  "it",
  "just",
  "known",
  "koi",
  "kuch",
  "me",
  "moment",
  "my",
  "of",
  "on",
  "present",
  "regular",
  "regularly",
  "right",
  "so",
  "take",
  "taking",
  "that",
  "thats",
  "that's",
  "the",
  "them",
  "this",
  "time",
  "to",
  "है",
  "हैं",
]);
/** The nouns a caller names when denying one of these lists. */
const LIST_NOUNS = new Set([
  "allergen",
  "allergens",
  "allergic",
  "allergies",
  "allergy",
  "dawai",
  "drug",
  "drugs",
  "food",
  "foods",
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
  "reaction",
  "reactions",
  "tablet",
  "tablets",
]);
/** Dose and frequency words, which name no drug. */
const UNITS = new Set([
  "mg",
  "mcg",
  "ug",
  "ml",
  "g",
  "gm",
  "iu",
  "unit",
  "units",
  "tab",
  "tabs",
  "tablet",
  "tablets",
  "cap",
  "caps",
  "capsule",
  "capsules",
  "puff",
  "puffs",
  "drop",
  "drops",
  "daily",
  "twice",
  "once",
  "thrice",
  "od",
  "bd",
  "tds",
  "hs",
  "prn",
  "mane",
  "nocte",
]);
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
  ["hundred", 100],
  ["thousand", 1000],
]);
const TENS_VALUES = new Set(TENS.map((_word, index) => (index + 2) * 10));

/** "eighty five" is one number, 85, not eighty followed by five. */
function joinTensAndUnit(tens: number, unit: number): number | null {
  return TENS_VALUES.has(tens) && unit >= 1 && unit <= 9 ? tens + unit : null;
}

/** "five hundred" is 500. A dose is said in words and written in digits. */
function joinScale(count: number, scale: number): number | null {
  const scaled = count * scale;
  return (scale === 100 || scale === 1000) && count >= 1 && count <= 99 ? scaled : null;
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
  return fusePairs(fusePairs(fusePairs(said, joinTensAndUnit), joinScale), joinYear).map(
    (item) => ({
      token: item.value === null ? item.token : String(item.value),
      confidence: item.confidence,
    }),
  );
}

/** A wanted value read the way the recording is, so "Kumar-Sharma" can match what was said. */
function tokenise(text: string): Token[] {
  return tokens(text.split(/\s+/).map((word) => ({ text: word, confidence: 1, start: 0, end: 0 })));
}

export function verifyValue(
  spec: FieldSpec,
  value: FieldValue,
  caller: readonly Utterance[],
  agent: readonly Utterance[] = [],
): Verification {
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
      return verifyList(value as readonly string[], spoken, spec, caller, agent);
    case "text":
      return verifyText(String(value), spoken);
  }
}

const ABSENT: Verification = { hearing: "absent", minConfidence: null };

/** Words that carry none of a phrase's meaning, so their absence proves nothing. */
const EMPTY_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "my",
  "me",
  "i",
  "is",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "been",
  "be",
  "am",
  "it",
  "this",
  "that",
  "some",
  "about",
  "since",
  "very",
  "really",
  "quite",
  "bit",
  "been",
  "getting",
  "got",
  "feel",
  "feeling",
]);
/** Share of a phrase's own words the recording has to carry before it counts as agreement. */
const TEXT_OVERLAP = 0.6;

/**
 * Free text, checked by the words it is made of.
 *
 * A reason for a visit is never said twice the same way, so there is no exact
 * sequence to look for: "I have had a fever and a sore throat for three days"
 * becomes "fever and a sore throat for 3 days" on the chart. What can be
 * checked is that the words carrying the meaning were actually said. Returning
 * nothing here, which is what this did, meant the grader fell back to the live
 * chart and the field came out green on the model\u0027s word alone, with no
 * readback, no yes and no second hearing behind it.
 */
/** Every word the caller said in order to rule it out, and how clearly they said it. */
function ruledOut(spoken: Token[][]): Map<string, Token> {
  const denied = new Map<string, Token>();
  for (const utterance of spoken) {
    const stated = new Set(affirmed(utterance).map((item) => item.token));
    for (const item of utterance) if (!stated.has(item.token)) denied.set(item.token, item);
  }
  return denied;
}

function verifyText(value: string, spoken: Token[][]): Verification {
  const wanted = tokenise(value)
    .map((item) => item.token)
    .filter((word) => !EMPTY_WORDS.has(word));
  if (wanted.length === 0) return ABSENT;
  // Only what the caller stated. Without this, "I have no fever but I do have a sore
  // throat" agreed with a chart line reading "fever and sore throat", because the words
  // were all present somewhere and nothing looked at the "no" in front of one of them.
  const said = new Map<string, Token>();
  for (const utterance of spoken) {
    for (const item of affirmed(utterance)) {
      const held = said.get(item.token);
      if (!held || item.confidence < held.confidence) said.set(item.token, item);
    }
  }
  const denied = ruledOut(spoken);
  const found = wanted
    .map((word) => said.get(word))
    .filter((item): item is Token => item !== undefined);
  // The caller said this word to rule it out. A chart that carries it anyway is not
  // agreed with, however many of the other words line up.
  const contradicted = wanted
    .filter((word) => !said.has(word))
    .map((word) => denied.get(word))
    .filter((item): item is Token => item !== undefined);
  if (contradicted.length > 0) {
    return { hearing: "differs", minConfidence: lowest([...found, ...contradicted]) };
  }
  if (found.length === 0) return ABSENT;
  return found.length / wanted.length >= TEXT_OVERLAP
    ? { hearing: "agrees", minConfidence: lowest(found) }
    : { hearing: "differs", minConfidence: lowest(found) };
}

function lowest(found: readonly Token[]): number {
  return Math.min(...found.map((item) => item.confidence));
}

/** The best stretch of an utterance that says every word in order. */
/**
 * A name spelled out, as the word it spells. The agent asks a caller to spell a name it
 * got wrong, so "P R I Y A" has to be readable as "priya" or the very callers this
 * product works hardest for come out unverified.
 */
function spelled(stream: Token[]): Token[] {
  const out: Token[] = [];
  let letters: Token[] = [];
  const flush = (): void => {
    if (letters.length >= 2) {
      out.push({ token: letters.map((item) => item.token).join(""), confidence: lowest(letters) });
    } else {
      out.push(...letters);
    }
    letters = [];
  };
  for (const item of stream) {
    if (item.token.length === 1 && /\p{L}/u.test(item.token)) {
      letters.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

/**
 * The name, as a run of words the caller actually said in that order.
 *
 * Read one utterance at a time this said a correct name was contradicted by the
 * recording: a caller who gives "Priya" and then "Sharma", which is what happens when
 * the agent asks for a surname or asks them to spell it, has no single utterance
 * holding the whole name. "The recording suggests a different value" is a specific and
 * false thing to print on a chart, so the run is looked for across the call's own
 * order, and a spelled name is read as the word it spells.
 */
function verifySequence(wanted: string[], spoken: Token[][]): Verification {
  if (wanted.length === 0) return ABSENT;
  // Per utterance, then joined. Flattened first, "P R I Y A" and "S H A R M A" in two
  // turns ran together into one word that is neither name, which is the same squash the
  // agent itself makes when a caller spells a whole name in one breath.
  const stream = spoken.flatMap(spelled);
  let best: number | null = null;
  for (let start = 0; start + wanted.length <= stream.length; start += 1) {
    const run = stream.slice(start, start + wanted.length);
    if (run.every((item, index) => item.token === wanted[index])) {
      best = Math.max(best ?? 0, lowest(run));
    }
  }
  if (best !== null) return { hearing: "agrees", minConfidence: best };
  const partial = stream.filter((item) => wanted.includes(item.token));
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

/**
 * The word that names an item: "Metformin 500 mg twice daily" is found by
 * "metformin". A dose can come first, and "500 mg Metformin" used to be looked
 * for by "mg", so any dose anywhere in the call verified the drug.
 */
function keyWord(item: string): string {
  const named = tokenise(item).filter((token) => /\p{L}/u.test(token.token));
  return (
    named.find((token) => !UNITS.has(token.token))?.token ?? named[0]?.token ?? item.toLowerCase()
  );
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

/** When an utterance began, so a denial can be tied to the question before it. */
function startedAt(utterance: Utterance): number {
  return utterance[0]?.start ?? 0;
}

/**
 * An empty list is only agreed to by a denial that answered THIS field's question.
 *
 * Two earlier versions were not enough. Any negative anywhere in the call, scored by
 * the loudest, let a goodbye verify an allergy list. Narrowing it to an utterance made
 * only of negatives and filler still let a bare "no" through, because nothing told this
 * function which field it was grading: one caller's "no" to "have you been here before?"
 * came back agreeing that they take no medication and have no allergy, at 0.99, on the
 * two entries where being wrong is most dangerous. So a denial now counts only when it
 * names this field itself, or when the agent's last question before it did. The agent's
 * side of the recording is on its own channel, and this is what it is for.
 */
function verifyNone(
  spec: FieldSpec,
  caller: readonly Utterance[],
  agent: readonly Utterance[],
): Verification {
  const nouns = fieldNouns(spec);
  // "Drug" and "medicine" belong to both lists, because an allergy is usually to a drug,
  // so a shared noun alone does not say which question was answered. An allergy word
  // does: "no drug allergies" is about allergies, and "I take no medicines" is about
  // medications precisely because no allergy word is in it.
  const allergyWords = fieldNouns(FIELDS.allergies);
  const medicationWords = fieldNouns(FIELDS.medications);
  const namesAllergies = (utterance: Token[]) =>
    utterance.some((item) => allergyWords.has(item.token) && !medicationWords.has(item.token));
  const namesMedications = (utterance: Token[]) =>
    !namesAllergies(utterance) && utterance.some((item) => medicationWords.has(item.token));
  const namesField = spec.id === "allergies" ? namesAllergies : namesMedications;
  const namesTheOtherField = spec.id === "allergies" ? namesMedications : namesAllergies;
  const questions = agent.map((utterance) => ({
    at: startedAt(utterance),
    aboutThisField: tokens(utterance).some((item) => nouns.has(item.token)),
  }));
  const lastQuestionBefore = (at: number): boolean =>
    questions.filter((question) => question.at <= at).at(-1)?.aboutThisField === true;
  // Walked over the caller's own utterances, not the tokenised copy, so each denial
  // still knows when it was said and therefore what it was answering.
  const denials = caller.flatMap((words) => {
    const utterance = tokens(words);
    const first = utterance[0];
    const isDenialShaped =
      first !== undefined &&
      NEGATIVE.has(first.token) &&
      utterance.every(
        (item) =>
          NEGATIVE.has(item.token) || DENIAL_FILLER.has(item.token) || LIST_NOUNS.has(item.token),
      );
    if (!isDenialShaped) return [];
    // "No allergies" does not deny a medication, whatever was asked.
    if (namesTheOtherField(utterance)) return [];
    if (!namesField(utterance) && !lastQuestionBefore(startedAt(words))) return [];
    return utterance.filter((item) => NEGATIVE.has(item.token));
  });
  return denials.length > 0
    ? { hearing: "agrees", minConfidence: Math.min(...denials.map((item) => item.confidence)) }
    : ABSENT;
}

/** Each item's first word, or a clear "no" for an empty list. */
function verifyList(
  items: readonly string[],
  spoken: Token[][],
  spec: FieldSpec,
  caller: readonly Utterance[],
  agent: readonly Utterance[],
): Verification {
  if (items.length === 0) return verifyNone(spec, caller, agent);
  const keys = items.map((item) => keyWord(item));
  // "I do not take metformin any more" names the drug to deny it, which is not a list.
  const stated = spoken.flatMap(affirmed);
  const hits = keys
    .map((key) => stated.find((item) => item.token === key))
    .filter((item): item is Token => item !== undefined);
  // The dose is the part of a medication line that harms someone when it is wrong, and
  // `keyWord` throws it away. `tokens` has already turned "five hundred" into 500, so the
  // numbers on the chart have to be numbers the recording also carries.
  const doses = items.flatMap((item) =>
    tokenise(item).filter((token) => /^\d+$/.test(token.token)),
  );
  const saidDose = (dose: Token) => stated.some((item) => item.token === dose.token);
  if (hits.length === keys.length) {
    if (doses.every(saidDose)) return { hearing: "agrees", minConfidence: lowest(hits) };
    return { hearing: "differs", minConfidence: lowest(hits), doseUnheard: true };
  }
  return hits.length > 0 ? { hearing: "differs", minConfidence: lowest(hits) } : ABSENT;
}
