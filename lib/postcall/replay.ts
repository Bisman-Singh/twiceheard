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

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Did the agent say this sentence, allowing for small differences in how it was voiced? */
export function wasSpoken(sentence: string, agentSaid: string): boolean {
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
}

interface ReplayState {
  chart: Chart;
  issues: ReplayIssue[];
  pending: Map<FieldId, Readback>;
  lastCaller: { text: string; at: number };
}

export function replayChart(
  events: readonly CallEvent[],
  context: Omit<FieldContext, "now">,
): Replay {
  const state: ReplayState = {
    chart: emptyChart(),
    issues: [],
    pending: new Map(),
    lastCaller: { text: "", at: -1 },
  };
  // Position in the call, so an agreement can be tied to the readback it answers.
  let step = 0;
  for (const event of events) {
    step += 1;
    if (event.kind === "caller") state.lastCaller = { text: event.text, at: step };
    else if (event.kind === "agent") markSpoken(state, event.text, step);
    else if (event.name === "save_field" && !event.failed) applySave(state, event, context);
  }
  return { chart: state.chart, issues: state.issues };
}

function markSpoken(state: ReplayState, agentSaid: string, step: number): void {
  for (const entry of state.pending.values()) {
    if (entry.spokenAt === null && wasSpoken(entry.sentence, agentSaid)) entry.spokenAt = step;
  }
}

function applySave(
  state: ReplayState,
  event: Extract<CallEvent, { kind: "tool" }>,
  context: Omit<FieldContext, "now">,
): void {
  const input = saveFieldInput(event.args);
  if (!input) return;
  const checked =
    input.status === "confirmed"
      ? checkConfirmation(input.field, state.pending, state.lastCaller)
      : null;
  if (checked) state.issues.push(checked);
  const status = checked ? "heard" : input.status;
  const outcome = saveField(
    state.chart,
    { ...input, status },
    { ...context, now: new Date(event.at ?? 0) },
  );
  state.chart = outcome.chart;
  if (outcome.reply.say && isFieldId(input.field)) {
    state.pending.set(input.field, { sentence: outcome.reply.say, spokenAt: null });
  }
}

function checkConfirmation(
  field: string,
  pending: ReadonlyMap<FieldId, Readback>,
  lastCaller: { text: string; at: number },
): ReplayIssue | null {
  if (!isFieldId(field)) return null;
  const readback = pending.get(field);
  // Nothing was read back: the reducer itself refuses this confirmation, with no issue to add.
  if (!readback) return null;
  if (readback.spokenAt === null) return { field, issue: "readback_not_spoken" };
  // The yes has to answer this readback. A yes given to an earlier field was about that field.
  if (lastCaller.at <= readback.spokenAt) return { field, issue: "no_answer_after_readback" };
  if (!isAgreement(lastCaller.text)) {
    return { field, issue: "caller_did_not_agree", callerSaid: lastCaller.text.slice(0, 200) };
  }
  return null;
}

function saveFieldInput(args: Record<string, unknown>) {
  const { field, value, status } = args;
  if (typeof field !== "string") return null;
  if (status !== "heard" && status !== "confirmed" && status !== "unresolved") return null;
  return { field, value: typeof value === "string" ? value : "", status } as const;
}
