import type { SaveFieldInput } from "@/lib/intake/chart";
import type { FieldContext, FieldId } from "@/lib/intake/fields";
import type { Grade } from "@/lib/intake/grade";
import type { Candidate, MedicationMatch } from "@/lib/medication/match";
import type { ReplayIssue } from "@/lib/postcall/replay";
import type { CallEvent } from "@/lib/postcall/timeline";
import type { HeardWord, Utterance } from "@/lib/verify/hearing";

/**
 * The scripted situations the harness grades.
 *
 * Every case is one thing that can happen on a call, written as the input the
 * product really receives: either the agent's own tool reports, or the whole
 * call record replayed afterwards, together with the caller's side of the
 * second hearing. The expected grade and the expected reason are stated in
 * full, so a change in wording is a failure and not a silent drift. Nothing
 * here reads a file or a network, so the same cases run anywhere.
 */

/** Which rule a case is about, so a failure points at the rule that broke. */
export const CATEGORIES = ["live", "recording", "confidence", "readback", "medication"] as const;

export type Category = (typeof CATEGORIES)[number];

/** One clinic, one moment, for every case: grades must not depend on the clock. */
export const EVAL_CONTEXT: FieldContext = {
  country: "IN",
  now: new Date("2026-09-14T09:30:00Z"),
};

const CALL_AT = EVAL_CONTEXT.now.getTime();
/** A word the second hearing had no trouble with. */
const CLEAR = 0.99;

export interface ExpectedField {
  field: FieldId;
  grade: Grade;
  reasons: readonly string[];
}

export interface ExpectedOutcome {
  /** The grade and the reasons each field under test must end with. */
  fields: readonly ExpectedField[];
  /** Confirmations the call record does not support. Empty unless the case replays a timeline. */
  issues: readonly ReplayIssue[];
  /** Every critical field green, so the clinic can act without calling back. */
  ready: boolean;
}

/** What the agent reported while the call was live, taken at its word. */
export interface ChartInput {
  kind: "chart";
  saves: readonly SaveFieldInput[];
}

/** The whole call, rebuilt from what the record proves. */
export interface TimelineInput {
  kind: "timeline";
  events: readonly CallEvent[];
}

export interface GradeCase {
  kind: "grade";
  id: string;
  category: Category;
  checks: string;
  input: ChartInput | TimelineInput;
  /** The caller's side of the recording, or null when there was no second hearing. */
  caller: readonly Utterance[] | null;
  expected: ExpectedOutcome;
}

export interface MatchCase {
  kind: "match";
  id: string;
  category: Category;
  checks: string;
  spoken: string;
  candidates: readonly Candidate[];
  expected: MedicationMatch;
}

export type EvalCase = GradeCase | MatchCase;

function said(text: string, confidence: number): Utterance {
  return text.split(" ").map((word, index): HeardWord => ({
    text: word,
    confidence,
    start: index * 400,
    end: index * 400 + 320,
  }));
}

/** The same words with one of them mumbled, which is what a low word confidence means. */
function saidWithWeakWord(text: string, weak: string, confidence: number): Utterance {
  return said(text, CLEAR).map((word) => (word.text === weak ? { ...word, confidence } : word));
}

/** What the agent reports for a value the caller said yes to. */
function confirmedLive(field: FieldId, value: string): SaveFieldInput[] {
  return [
    { field, value, status: "heard" },
    { field, value, status: "confirmed" },
  ];
}

function callerTurn(text: string): CallEvent {
  return { kind: "caller", text, confidence: 1 };
}

function agentTurn(text: string): CallEvent {
  return { kind: "agent", text, interrupted: false };
}

function saveFieldCall(field: FieldId, value: string, status: SaveFieldInput["status"]): CallEvent {
  return {
    kind: "tool",
    name: "save_field",
    args: { field, value, status },
    at: CALL_AT,
    durationMs: 120,
    failed: false,
    result: null,
  };
}

const NAME_READBACK = "I have your name as Priya Nair. Is that right?";
const PHONE_READBACK =
  "I have your number as nine eight seven six five, four three two one zero. Is that right?";

const NOT_CONFIRMED = "Heard but not confirmed by the caller.";
const NOT_CAPTURED = "Not captured.";
const DIFFERENT = "The recording suggests a different value.";
const NOT_IN_RECORDING = "The value could not be found in the recording.";

export const EVAL_CASES: readonly EvalCase[] = [
  {
    kind: "grade",
    id: "confirmed-and-clearly-heard",
    category: "recording",
    checks: "A value confirmed live and said clearly in the recording.",
    input: { kind: "chart", saves: confirmedLive("full_name", "Priya Nair") },
    caller: [said("my name is Priya Nair", CLEAR)],
    expected: {
      fields: [{ field: "full_name", grade: "green", reasons: [] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "confirmed-but-absent-from-recording",
    category: "recording",
    checks: "A value confirmed live that the recording does not contain at all.",
    input: { kind: "chart", saves: confirmedLive("phone", "9876543210") },
    caller: [said("just a moment", CLEAR)],
    expected: {
      fields: [{ field: "phone", grade: "amber", reasons: [NOT_IN_RECORDING] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "confirmed-but-recording-differs",
    category: "recording",
    checks: "A value confirmed live where the recording holds a different surname.",
    input: { kind: "chart", saves: confirmedLive("full_name", "Meera Joshi") },
    caller: [said("my name is Meera Joshy", 0.8)],
    expected: {
      fields: [{ field: "full_name", grade: "amber", reasons: [DIFFERENT] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "list-item-missing-from-recording",
    category: "recording",
    checks: "A confirmed medication list where the recording holds only one of the two drugs.",
    input: {
      kind: "chart",
      saves: confirmedLive("medications", "Metformin 500 mg twice daily; aspirin"),
    },
    caller: [said("I take metformin every morning", 0.9)],
    expected: {
      fields: [{ field: "medications", grade: "amber", reasons: [DIFFERENT] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "confidence-just-under-the-floor",
    category: "confidence",
    checks: "A confirmed value whose weakest word sits just under the confidence floor.",
    input: { kind: "chart", saves: confirmedLive("full_name", "Priya Nair") },
    caller: [saidWithWeakWord("my name is Priya Nair", "Nair", 0.49)],
    expected: {
      fields: [
        {
          field: "full_name",
          grade: "red",
          reasons: ["The recording is unclear here (49% confidence)."],
        },
      ],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "confidence-on-the-floor",
    category: "confidence",
    checks: "A confirmed value whose weakest word sits exactly on the confidence floor.",
    input: { kind: "chart", saves: confirmedLive("full_name", "Priya Nair") },
    caller: [saidWithWeakWord("my name is Priya Nair", "Nair", 0.5)],
    expected: {
      fields: [
        {
          field: "full_name",
          grade: "amber",
          reasons: ["Partly unclear in the recording (50% confidence)."],
        },
      ],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "confidence-just-under-good",
    category: "confidence",
    checks: "A confirmed value one point under the confidence a yes can rest on.",
    input: { kind: "chart", saves: confirmedLive("full_name", "Priya Nair") },
    caller: [saidWithWeakWord("my name is Priya Nair", "Nair", 0.79)],
    expected: {
      fields: [
        {
          field: "full_name",
          grade: "amber",
          reasons: ["Partly unclear in the recording (79% confidence)."],
        },
      ],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "confidence-exactly-good",
    category: "confidence",
    checks: "A confirmed value exactly on the confidence a yes can rest on.",
    input: { kind: "chart", saves: confirmedLive("full_name", "Priya Nair") },
    caller: [saidWithWeakWord("my name is Priya Nair", "Nair", 0.8)],
    expected: {
      fields: [{ field: "full_name", grade: "green", reasons: [] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "critical-field-heard-never-confirmed",
    category: "live",
    checks: "A critical field the caller stated but never said yes to.",
    input: {
      kind: "chart",
      saves: [{ field: "allergies", value: "penicillin", status: "heard" }],
    },
    caller: [said("I am allergic to penicillin", 0.95)],
    expected: {
      fields: [{ field: "allergies", grade: "amber", reasons: [NOT_CONFIRMED] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "optional-field-heard-never-confirmed",
    category: "live",
    checks: "A non-critical field that was heard, which never needs a yes.",
    input: {
      kind: "chart",
      saves: [
        { field: "reason_for_visit", value: "a persistent cough for three weeks", status: "heard" },
      ],
    },
    caller: [said("I have had a cough for three weeks", CLEAR)],
    expected: {
      fields: [{ field: "reason_for_visit", grade: "green", reasons: [] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "none-is-a-real-answer",
    category: "live",
    checks: "A caller who takes nothing, where an empty list is an answer and not a blank.",
    input: { kind: "chart", saves: confirmedLive("medications", "none") },
    caller: [said("no I don't take any medicines", 0.92)],
    expected: {
      fields: [{ field: "medications", grade: "green", reasons: [] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "unresolved-after-repeated-tries",
    category: "live",
    checks: "A date of birth that changed on every try until the agent ran out of tries.",
    input: {
      kind: "chart",
      saves: [
        { field: "date_of_birth", value: "1990-03-12", status: "heard" },
        { field: "date_of_birth", value: "1990-03-13", status: "heard" },
        { field: "date_of_birth", value: "1990-03-14", status: "heard" },
        { field: "date_of_birth", value: "1990-03-15", status: "heard" },
      ],
    },
    caller: [said("the 15th of March 1990", CLEAR)],
    expected: {
      fields: [
        {
          field: "date_of_birth",
          grade: "red",
          reasons: ["Could not be confirmed after 4 tries."],
        },
      ],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "agent-gives-up-on-a-field",
    category: "live",
    checks: "A field the agent reports it cannot settle, left for the front desk.",
    input: {
      kind: "chart",
      saves: [
        { field: "date_of_birth", value: "1990-03-12", status: "heard" },
        { field: "date_of_birth", value: "1990-03-21", status: "heard" },
        { field: "date_of_birth", value: "1990-03-21", status: "unresolved" },
      ],
    },
    caller: [said("I am not sure of the exact date", CLEAR)],
    expected: {
      fields: [
        {
          field: "date_of_birth",
          grade: "red",
          reasons: ["Could not be confirmed after 2 tries.", NOT_IN_RECORDING],
        },
      ],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "nothing-captured",
    category: "live",
    checks: "A call that ended early, where criticality decides red against amber.",
    input: { kind: "chart", saves: [] },
    caller: null,
    expected: {
      fields: [
        { field: "full_name", grade: "red", reasons: [NOT_CAPTURED] },
        { field: "preferred_time", grade: "amber", reasons: [NOT_CAPTURED] },
      ],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "complete-call-is-ready",
    category: "live",
    checks: "A call where every critical field is confirmed and clearly heard.",
    input: {
      kind: "chart",
      saves: [
        ...confirmedLive("full_name", "Rohan Iyer"),
        ...confirmedLive("date_of_birth", "1988-07-04"),
        ...confirmedLive("phone", "9876543210"),
        ...confirmedLive("medications", "none"),
        ...confirmedLive("allergies", "penicillin"),
        { field: "reason_for_visit", value: "a persistent cough", status: "heard" },
      ],
    },
    caller: [
      said("my name is Rohan Iyer", CLEAR),
      said("born on the 4th of July 1988", CLEAR),
      said("my number is 98765 43210", CLEAR),
      said("no regular medications", CLEAR),
      said("I am allergic to penicillin", CLEAR),
      // A complete call is one where the recording carries every value on the
      // chart, the reason for the visit included.
      said("I have had a persistent cough", CLEAR),
    ],
    expected: {
      fields: [
        { field: "full_name", grade: "green", reasons: [] },
        { field: "date_of_birth", grade: "green", reasons: [] },
        { field: "phone", grade: "green", reasons: [] },
        { field: "medications", grade: "green", reasons: [] },
        { field: "allergies", grade: "green", reasons: [] },
        { field: "reason_for_visit", grade: "green", reasons: [] },
        { field: "preferred_time", grade: "amber", reasons: [NOT_CAPTURED] },
      ],
      issues: [],
      ready: true,
    },
  },
  {
    kind: "grade",
    id: "readback-spoken-and-agreed",
    category: "readback",
    checks: "A readback the agent really spoke, answered with a yes.",
    input: {
      kind: "timeline",
      events: [
        callerTurn("My name is Priya Nair"),
        saveFieldCall("full_name", "Priya Nair", "heard"),
        agentTurn(NAME_READBACK),
        callerTurn("Yes, that's correct."),
        saveFieldCall("full_name", "Priya Nair", "confirmed"),
      ],
    },
    caller: [said("my name is Priya Nair", CLEAR)],
    expected: {
      fields: [{ field: "full_name", grade: "green", reasons: [] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "readback-never-spoken",
    category: "readback",
    checks: "A confirmation recorded for a readback the agent never said aloud.",
    input: {
      kind: "timeline",
      events: [
        callerTurn("Hi, my name is Priya Nair"),
        saveFieldCall("full_name", "Priya Nair", "heard"),
        agentTurn("One moment please."),
        callerTurn("Yes, that's correct."),
        saveFieldCall("full_name", "Priya Nair", "confirmed"),
      ],
    },
    caller: [said("my name is Priya Nair", CLEAR)],
    expected: {
      fields: [{ field: "full_name", grade: "amber", reasons: [NOT_CONFIRMED] }],
      issues: [{ field: "full_name", issue: "readback_not_spoken" }],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "caller-said-no-to-the-readback",
    category: "readback",
    checks: "A confirmation recorded after the caller answered the readback with a no.",
    input: {
      kind: "timeline",
      events: [
        callerTurn("My number is nine eight seven six five four three two one one"),
        saveFieldCall("phone", "98765 43210", "heard"),
        agentTurn(PHONE_READBACK),
        callerTurn("No, the last digit is one."),
        saveFieldCall("phone", "98765 43210", "confirmed"),
      ],
    },
    caller: [said("my number is 98765 43211", CLEAR)],
    expected: {
      fields: [{ field: "phone", grade: "amber", reasons: [NOT_CONFIRMED, DIFFERENT] }],
      issues: [
        { field: "phone", issue: "caller_did_not_agree", callerSaid: "No, the last digit is one." },
      ],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "confirmation-with-no-readback-at-all",
    category: "readback",
    checks: "A confirmation for a field nothing was ever read back for.",
    input: {
      kind: "timeline",
      events: [callerTurn("Yes, that's right."), saveFieldCall("allergies", "none", "confirmed")],
    },
    caller: [said("no allergies at all", CLEAR)],
    expected: {
      fields: [{ field: "allergies", grade: "red", reasons: [NOT_CAPTURED] }],
      issues: [],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "yes-to-an-earlier-field-reused",
    category: "readback",
    checks: "A second readback the caller never answered, after a yes to the first one.",
    input: {
      kind: "timeline",
      events: [
        callerTurn("My name is Priya Nair"),
        saveFieldCall("full_name", "Priya Nair", "heard"),
        agentTurn(NAME_READBACK),
        callerTurn("Yes, that's correct."),
        saveFieldCall("full_name", "Priya Nair", "confirmed"),
        saveFieldCall("phone", "98765 43210", "heard"),
        agentTurn(PHONE_READBACK),
        saveFieldCall("phone", "98765 43210", "confirmed"),
      ],
    },
    caller: [said("my name is Priya Nair", CLEAR), said("my number is 98765 43210", CLEAR)],
    expected: {
      fields: [
        { field: "full_name", grade: "green", reasons: [] },
        { field: "phone", grade: "amber", reasons: [NOT_CONFIRMED] },
      ],
      // The stale yes belonged to the name. Nothing answered the phone readback at all.
      issues: [{ field: "phone", issue: "no_answer_after_readback" }],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "readback-the-caller-talked-over",
    category: "readback",
    checks: "A yes to a readback the caller cut in on, so they never heard the whole value.",
    input: {
      kind: "timeline",
      events: [
        callerTurn("My name is Priya Nair"),
        saveFieldCall("full_name", "Priya Nair", "heard"),
        { kind: "agent", text: NAME_READBACK, interrupted: true },
        callerTurn("Yes, that's correct."),
        saveFieldCall("full_name", "Priya Nair", "confirmed"),
      ],
    },
    caller: [said("my name is Priya Nair", CLEAR)],
    expected: {
      fields: [{ field: "full_name", grade: "amber", reasons: [NOT_CONFIRMED] }],
      issues: [{ field: "full_name", issue: "readback_interrupted" }],
      ready: false,
    },
  },
  {
    kind: "grade",
    id: "one-yes-two-readbacks",
    category: "readback",
    checks: "Two values read back in one breath, answered with a single yes.",
    input: {
      kind: "timeline",
      events: [
        callerTurn("I am Priya Nair and my number is 98765 43210"),
        saveFieldCall("full_name", "Priya Nair", "heard"),
        saveFieldCall("phone", "98765 43210", "heard"),
        agentTurn(`${NAME_READBACK} ${PHONE_READBACK}`),
        callerTurn("Yes."),
        saveFieldCall("full_name", "Priya Nair", "confirmed"),
        saveFieldCall("phone", "98765 43210", "confirmed"),
      ],
    },
    caller: [said("i am Priya Nair and my number is 98765 43210", CLEAR)],
    expected: {
      fields: [
        { field: "full_name", grade: "green", reasons: [] },
        { field: "phone", grade: "amber", reasons: [NOT_CONFIRMED] },
      ],
      // One word of agreement answers one readback, not both.
      issues: [{ field: "phone", issue: "one_yes_two_values", alsoAnswered: "full_name" }],
      ready: false,
    },
  },
  {
    kind: "match",
    id: "medication-spelling-corrected",
    category: "medication",
    checks: "A misspelt drug close enough to become a question for the caller.",
    spoken: "metphormin",
    candidates: [{ name: "metformin", rxcui: "6809" }],
    expected: { kind: "suggestion", name: "metformin", rxcui: "6809", heard: "metphormin" },
  },
  {
    kind: "match",
    id: "medication-never-swapped",
    category: "medication",
    checks: "A brand whose top database match is a different drug, so the caller's word is kept.",
    spoken: "Glycomet",
    candidates: [{ name: "glycogen", rxcui: "1426910" }],
    expected: { kind: "none", name: "Glycomet" },
  },
  {
    kind: "match",
    id: "medication-dose-is-not-a-different-drug",
    category: "medication",
    checks: "The same drug with a dose attached, which is an exact match and not a swap.",
    spoken: "Telmisartan 40 mg",
    candidates: [{ name: "telmisartan 40 MG", rxcui: "316764" }],
    expected: { kind: "exact", name: "telmisartan", rxcui: "316764" },
  },
];
