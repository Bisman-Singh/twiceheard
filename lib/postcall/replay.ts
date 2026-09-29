import { emptyChart, saveField, type Chart } from "@/lib/intake/chart";
import { isFieldId, type FieldContext, type FieldId } from "@/lib/intake/fields";
import type { CallEvent } from "@/lib/postcall/timeline";

/**
 * Rebuilding the chart from what the call record proves.
 *
 * During the call the agent's tool reports are taken at their word, because
 * that is all a live call has. Afterwards the whole conversation is on
 * record, so each confirmation is checked against it: the readback sentence
 * must actually have been spoken by the agent, and the caller's last words
 * before the confirmation must have been a yes. A confirmation that fails
 * either check is replayed as a plain "heard", and the reason is kept for the
 * front desk. This chart, not the live one, is what the clinic sees.
 */

export type ReplayIssue =
  | { field: FieldId; issue: "readback_not_spoken" }
  | { field: FieldId; issue: "readback_interrupted" }
  | { field: FieldId; issue: "one_yes_two_values"; alsoAnswered: FieldId }
  | { field: FieldId; issue: "no_answer_after_readback" }
  | { field: FieldId; issue: "caller_did_not_agree"; callerSaid: string };

export interface Replay {
  chart: Chart;
  issues: ReplayIssue[];
}

const YES =
  /\b(yes|yeah|yep|yup|correct|right|that's right|exactly|sure|haan|haa|ha|ji|theek hai|sahi|sahi hai)\b|हाँ|हां|जी|सही/i;
const NO = /\b(no|nope|not|wrong|incorrect|nahi|nahin|galat)\b|नहीं|गलत/i;
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
 * Did the agent say this sentence, allowing for small differences in how it
 * was voiced? Wording is forgiven; a number is not. The digits of the readback
 * have to appear in the agent's words in the same order, so a transposed or
 * altered number can never pass as the value that was read back.
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
    if (count === 0) continue;
    available.set(word, count - 1);
    found += 1;
  }
  return wanted.length > 0 && found / wanted.length >= SPOKEN_OVERLAP;
}

/** A clear yes: affirmative words and no negative ones. "No, that's right" is not a yes. */
export function isAgreement(text: string): boolean {
  return YES.test(text) && !NO.test(text);
}

/** A readback, and the point in the call at which the agent was heard to say it. */
interface Readback {
  sentence: string;
  spokenAt: number | null;
  /** The caller talked over the sentence, so they did not hear all of the value. */
  interrupted: boolean;
}

interface ReplayState {
  chart: Chart;
  issues: ReplayIssue[];
  pending: Map<FieldId, Readback>;
  lastCaller: { text: string; at: number };
  /** Which field has already spent the caller's latest agreement. */
  agreementSpentBy: { field: FieldId; at: number } | null;
  /** Stands in for the clock when a tool event carries no timestamp of its own. */
  startedAt: number;
}

export function replayChart(
  events: readonly CallEvent[],
  context: Omit<FieldContext, "now">,
  startedAt: number = Date.now(),
): Replay {
  const state: ReplayState = {
    chart: emptyChart(),
    issues: [],
    pending: new Map(),
    lastCaller: { text: "", at: -1 },
    agreementSpentBy: null,
    startedAt,
  };
  // Position in the call, so an agreement can be tied to the readback it answers.
  let step = 0;
  for (const event of events) {
    step += 1;
    if (event.kind === "caller") state.lastCaller = { text: event.text, at: step };
    else if (event.kind === "agent") markSpoken(state, event.text, step, event.interrupted);
    else if (event.name === "save_field" && !event.failed) applySave(state, event, context);
  }
  return { chart: state.chart, issues: state.issues };
}

function markSpoken(
  state: ReplayState,
  agentSaid: string,
  step: number,
  interrupted: boolean,
): void {
  for (const entry of state.pending.values()) {
    if (entry.spokenAt !== null || !wasSpoken(entry.sentence, agentSaid)) continue;
    entry.spokenAt = step;
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
  const checked = judgeConfirmation(state, input.field, input.status);
  const status = checked ? "heard" : input.status;
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
 * Whether a reported confirmation stands. One that stands also spends the caller's
 * agreement, so a second field cannot lean on the same word.
 */
function judgeConfirmation(state: ReplayState, field: string, status: string): ReplayIssue | null {
  if (status !== "confirmed" || !isFieldId(field)) return null;
  const issue = checkConfirmation(field, state);
  if (issue) {
    state.issues.push(issue);
    return issue;
  }
  state.agreementSpentBy = { field, at: state.lastCaller.at };
  return null;
}

/** The agent repeating a readback it already said must not erase the fact that it said it. */
function rememberReadback(state: ReplayState, field: FieldId, sentence: string): void {
  if (state.pending.get(field)?.sentence === sentence) return;
  state.pending.set(field, { sentence, spokenAt: null, interrupted: false });
}

function checkConfirmation(field: FieldId, state: ReplayState): ReplayIssue | null {
  const readback = state.pending.get(field);
  // Nothing was read back: the reducer itself refuses this confirmation, with no issue to add.
  if (!readback) return null;
  if (readback.spokenAt === null) return { field, issue: "readback_not_spoken" };
  if (readback.interrupted) return { field, issue: "readback_interrupted" };
  const { lastCaller, agreementSpentBy } = state;
  // The yes has to answer this readback. A yes given to an earlier field was about that field.
  if (lastCaller.at <= readback.spokenAt) return { field, issue: "no_answer_after_readback" };
  if (!isAgreement(lastCaller.text)) {
    return { field, issue: "caller_did_not_agree", callerSaid: lastCaller.text.slice(0, 200) };
  }
  if (agreementSpentBy && agreementSpentBy.at === lastCaller.at) {
    return { field, issue: "one_yes_two_values", alsoAnswered: agreementSpentBy.field };
  }
  return null;
}

function saveFieldInput(args: Record<string, unknown>) {
  const { field, value, status } = args;
  if (typeof field !== "string") return null;
  if (status !== "heard" && status !== "confirmed" && status !== "unresolved") return null;
  return { field, value: typeof value === "string" ? value : "", status } as const;
}
