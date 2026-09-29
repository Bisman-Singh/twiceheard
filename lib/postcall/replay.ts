import { emptyChart, saveField, type Chart } from "@/lib/intake/chart";
import { isFieldId, type FieldContext, type FieldId } from "@/lib/intake/fields";
import type { CallEvent } from "@/lib/postcall/timeline";

/**
 * Rebuilding the chart from what the call record proves.
 *
 * During the call the agent's tool reports are taken at their word, because
 * that is all a live call has. Afterwards the whole conversation is on
 * record, so each confirmation is checked against it: the readback sentence
 * must actually have been spoken by the agent, and the caller's own answer to
 * that sentence, the turn straight after it, must have been a yes. A
 * confirmation that fails either check is replayed as a plain "heard", and the
 * reason is kept for the front desk. This chart, not the live one, is what the
 * clinic sees.
 */

export type ReplayIssue =
  | { field: FieldId; issue: "readback_not_spoken" }
  | { field: FieldId; issue: "readback_interrupted" }
  | { field: FieldId; issue: "one_yes_two_values"; alsoAnswered: FieldId }
  | { field: FieldId; issue: "no_answer_after_readback" }
  | { field: FieldId; issue: "caller_did_not_agree"; callerSaid: string }
  | { field: FieldId; issue: "caller_did_not_confirm"; callerSaid: string };

export interface Replay {
  chart: Chart;
  issues: ReplayIssue[];
}

/**
 * A yes and a no, in the languages this line is answered in.
 *
 * `\b` is defined over ASCII word characters, so it cannot anchor a Devanagari
 * word. Written as bare alternatives these matched as substrings: जी inside
 * जीवन, सही inside a longer word. Letter, mark and number lookarounds anchor
 * both scripts. "ha" is gone from the yes list because "ha ha" is laughter, not
 * agreement, and ना is in the no list because it is an ordinary Hindi no.
 */
const YES =
  /\b(yes|yeah|yep|yup|that's right|exactly|haan|haa|sahi|sahi hai)\b|(?<![\p{L}\p{M}\p{N}])(हाँ|हां|सही)(?![\p{L}\p{M}\p{N}])/iu;
const NO =
  /\b(no|nope|not|wrong|incorrect|nahi|nahin|galat)\b|(?<![\p{L}\p{M}\p{N}])(नहीं|नही|ना|न|गलत)(?![\p{L}\p{M}\p{N}])/iu;
/**
 * "जी" alone is "yes, of course". In a sentence it is an ordinary word: "जी
 * मिचला रहा है" is "I feel nauseous", which was being read as agreement to
 * whatever had just been read back. It counts as a yes only when it is the
 * whole answer; every phrase where it really is agreement ("जी हाँ", "haan ji")
 * carries a yes of its own.
 */
const JI_ALONE = /^[\s.,!?।]*(जी|ji)[\s.,!?।]*$/iu;
/**
 * The same trap as जी, in the other script. "right", "correct" and "sure" are
 * ordinary words in the middle of a sentence: "sorry, I didn't hear you right",
 * "correct that to Kumar", "are you sure?". Each was being scored as agreement
 * to whatever had just been read back, so a phone number the caller had asked
 * to have repeated came out confirmed and green. They count only as the whole
 * answer. "ठीक है" joins them here rather than in YES because it is the
 * commonest Hindi yes on its own and an ordinary "it is fine" inside a
 * sentence, which is why "मेरा जीवन ठीक है" must not be agreement.
 */
const RIGHT_ALONE =
  /^[\s.,!?।]*((that'?s |quite |all |absolutely )?(right|correct|sure)|(theek hai|theek|ठीक है|ठीक)( ji| जी)?)[\s.,!?।]*$/iu;
/** Share of the readback's words that must appear in what the agent said. */
const SPOKEN_OVERLAP = 0.85;

/**
 * A transcriber writes a number however it heard it, and the agent was given the other
 * form to say: "9 8 1" against "nine eight one", "12 March 1990" against "March twelfth,
 * nineteen ninety". Both sides are reduced to their digits before they are compared, or a
 * readback that was spoken perfectly well would be recorded as never spoken.
 */
const NUMBER_FOR_WORD: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};

function expand(word: string): string[] {
  const plain = word.replace(/^(\d+)(st|nd|rd|th)$/, "$1");
  if (/^\d+$/.test(plain)) return [...plain];
  const number = NUMBER_FOR_WORD[plain];
  return number === undefined ? [plain] : [...String(number)];
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(expand);

/** The digits in a sentence, in the order they were said. */
const digitsOf = (text: string) =>
  words(text)
    .filter((word) => /^\d$/.test(word))
    .join("");

/**
 * The words this product puts around a value. Only these may be paraphrased.
 */
const TEMPLATE = new Set(
  words(
    "I have your name as. I have your date of birth as. I have your number as. I have noted. " +
      "I have your allergies as. I have your medications as. and " +
      "I have that you have no known allergies. " +
      "I have that you are not taking any regular medications. " +
      "Is that right? Is that the complete list? Mr Mrs Ms Dr",
  ),
);

/**
 * Did the agent say this sentence, allowing for small differences in how it
 * was voiced? Wording is forgiven; the value is not. The digits of the readback
 * have to appear in the agent's words in the same order, so a transposed or
 * altered number can never pass as the value that was read back.
 *
 * A share of matching words was not enough on its own. The frame is most of the
 * sentence, so "I have your name as Arjun Mehta" scored as spoken against "Arjun
 * Sharma", and an allergy read back as sulfa passed for penicillin. A word that
 * belongs to the value rather than to the frame has to have been said.
 */
export function wasSpoken(sentence: string, agentSaid: string): boolean {
  const digits = digitsOf(sentence);
  if (digits.length > 0 && !digitsOf(agentSaid).includes(digits)) return false;
  const wanted = words(sentence);
  const available = new Map<string, number>();
  for (const word of words(agentSaid)) available.set(word, (available.get(word) ?? 0) + 1);
  let found = 0;
  for (const word of wanted) {
    const count = available.get(word) ?? 0;
    if (count === 0) {
      // A missing word of the value means the agent read something other than what
      // the chart holds, which is a different sentence, not a paraphrase of this one.
      if (!TEMPLATE.has(word)) return false;
      continue;
    }
    available.set(word, count - 1);
    found += 1;
  }
  return wanted.length > 0 && found / wanted.length >= SPOKEN_OVERLAP;
}

/**
 * A clear no: the caller pushed back on what was read to them.
 *
 * Not any negative anywhere in the answer. "I am not certain of the name" is a
 * patient being careful, not a patient saying the value is wrong, and telling a
 * clinic the caller objected would be telling it something untrue. A refusal
 * leads with a no, or calls the value wrong. Either way the field is still held
 * back from green; this only decides which sentence the desk reads.
 */
const REFUSAL_LEAD =
  /^[\s.,!?।"']*(no|nope|nahi|nahin)\b|^[\s.,!?।"']*(नहीं|नही|ना|न)(?![\p{L}\p{M}\p{N}])/iu;
const CALLED_WRONG = /\b(wrong|incorrect|galat)\b|(?<![\p{L}\p{M}\p{N}])गलत(?![\p{L}\p{M}\p{N}])/iu;

export function isRefusal(text: string): boolean {
  return REFUSAL_LEAD.test(text) || CALLED_WRONG.test(text);
}

/** A clear yes: affirmative words and no negative ones. "No, that's right" is not a yes. */
export function isAgreement(text: string): boolean {
  return (YES.test(text) || JI_ALONE.test(text) || RIGHT_ALONE.test(text)) && !NO.test(text);
}

/** A readback, the point at which the agent was heard to say it, and the answer it drew. */
interface Readback {
  sentence: string;
  spokenAt: number | null;
  /** The caller talked over the sentence, so they did not hear all of the value. */
  interrupted: boolean;
  /**
   * The caller's next turn after the sentence was read. Only that turn can
   * agree to it: a yes to a later question is an answer to that question.
   */
  answer: { text: string; at: number } | null;
}

interface ReplayState {
  chart: Chart;
  issues: ReplayIssue[];
  pending: Map<FieldId, Readback>;
  /**
   * Which field spent the caller's agreement at each of their turns. A single
   * slot was not enough: any third confirmation judged in between overwrote it,
   * so one "yes, both of those are correct" confirmed two values and nothing
   * was flagged.
   */
  agreementSpentAt: Map<number, FieldId>;
  /** Stands in for the clock when a tool event carries no timestamp of its own. */
  startedAt: number;
}

/** A confirmation either has something wrong with it or spends the yes at this turn. */
type Verdict = ReplayIssue | { agreedAt: number };

export function replayChart(
  events: readonly CallEvent[],
  context: Omit<FieldContext, "now">,
  startedAt: number = Date.now(),
): Replay {
  const state: ReplayState = {
    chart: emptyChart(),
    issues: [],
    pending: new Map(),
    agreementSpentAt: new Map(),
    startedAt,
  };
  // Position in the call, so an agreement can be tied to the readback it answers.
  let step = 0;
  for (const event of events) {
    step += 1;
    if (event.kind === "caller") answerReadbacks(state, event.text, step);
    else if (event.kind === "agent") markSpoken(state, event.text, step, event.interrupted);
    else if (event.name === "save_field" && !event.failed) applySave(state, event, context);
  }
  return { chart: state.chart, issues: state.issues };
}

/**
 * The caller's first words after a readback are the answer to it. Anything they
 * say later is an answer to whatever was asked in between, which is how a yes to
 * an unrelated question was reviving a value the caller had rejected.
 */
function answerReadbacks(state: ReplayState, text: string, step: number): void {
  for (const entry of state.pending.values()) {
    if (entry.spokenAt !== null && entry.answer === null) entry.answer = { text, at: step };
  }
}

function markSpoken(
  state: ReplayState,
  agentSaid: string,
  step: number,
  interrupted: boolean,
): void {
  for (const entry of state.pending.values()) {
    if (!wasSpoken(entry.sentence, agentSaid)) continue;
    entry.spokenAt = step;
    // Reading the value again puts the question again, so the answer that counts is
    // the one after this reading and not the one after an earlier attempt.
    entry.answer = null;
    // The platform records the whole sentence it meant to say. If the caller cut in, they
    // did not hear all of it, so a yes cannot be a yes to a value they never heard.
    entry.interrupted = interrupted;
  }
}

function applySave(
  state: ReplayState,
  event: Extract<CallEvent, { kind: "tool" }>,
  context: Omit<FieldContext, "now">,
): void {
  const input = saveFieldInput(event.args);
  if (!input) return;
  const demoted = judgeConfirmation(state, input.field, input.status);
  const status = demoted ? "heard" : input.status;
  const outcome = saveField(
    state.chart,
    { ...input, status },
    // A tool event without a timestamp used to become 1970, which then failed every date
    // of birth as impossible and dropped it from the chart with no reason recorded.
    { ...context, now: new Date(event.at ?? state.startedAt) },
  );
  state.chart = outcome.chart;
  if (outcome.reply.say && isFieldId(input.field)) {
    rememberReadback(state, input.field, outcome.reply.say);
  }
}

/**
 * Whether a reported confirmation has to be demoted. One that stands spends the
 * caller's agreement, so a second field cannot lean on the same word.
 */
function judgeConfirmation(state: ReplayState, field: string, status: string): boolean {
  if (status !== "confirmed" || !isFieldId(field)) return false;
  const verdict = checkConfirmation(field, state);
  if (verdict === null) return false;
  if ("agreedAt" in verdict) {
    state.agreementSpentAt.set(verdict.agreedAt, field);
    return false;
  }
  state.issues.push(verdict);
  return true;
}

/** The agent repeating a readback it already said must not erase the fact that it said it. */
function rememberReadback(state: ReplayState, field: FieldId, sentence: string): void {
  if (state.pending.get(field)?.sentence === sentence) return;
  state.pending.set(field, { sentence, spokenAt: null, interrupted: false, answer: null });
}

function checkConfirmation(field: FieldId, state: ReplayState): Verdict | null {
  const readback = state.pending.get(field);
  // Nothing was read back: the reducer itself refuses this confirmation, with no issue to add.
  if (!readback) return null;
  if (readback.spokenAt === null) return { field, issue: "readback_not_spoken" };
  if (readback.interrupted) return { field, issue: "readback_interrupted" };
  const { answer } = readback;
  if (!answer) return { field, issue: "no_answer_after_readback" };
  if (!isAgreement(answer.text)) {
    // Saying no and saying something that is not a yes are different things, and a
    // clinic reading the chart should not be told the caller objected when they
    // answered "I would have to check the box at home". Both are held back from
    // green, because a confirmation still has to be a yes, but the desk is told
    // which of the two it is and what was actually said.
    const refused = isRefusal(answer.text);
    return {
      field,
      issue: refused ? "caller_did_not_agree" : "caller_did_not_confirm",
      callerSaid: answer.text.slice(0, 200),
    };
  }
  // A field confirmed twice off one yes is the model repeating itself, not two values.
  const spentBy = state.agreementSpentAt.get(answer.at);
  if (spentBy !== undefined && spentBy !== field) {
    return { field, issue: "one_yes_two_values", alsoAnswered: spentBy };
  }
  return { agreedAt: answer.at };
}

function saveFieldInput(args: Record<string, unknown>) {
  const { field, value, status } = args;
  if (typeof field !== "string") return null;
  if (status !== "heard" && status !== "confirmed" && status !== "unresolved") return null;
  return { field, value: typeof value === "string" ? value : "", status } as const;
}
