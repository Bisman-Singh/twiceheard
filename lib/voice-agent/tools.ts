import { FIELD_IDS } from "@/lib/intake/fields";

/**
 * The tools the agent can call, defined once.
 *
 * Every tool is an HTTP tool on a stored agent, so a phone call works with no
 * client in the loop: AssemblyAI calls Twiceheard's API directly. Tool requests
 * carry only the model's arguments, so the first call, `start_intake`, hands
 * the agent a short intake id that every later call repeats. That id is what
 * lets the live board follow a call; the authoritative record is rebuilt
 * after the call from the session timeline, so a garbled id costs the live
 * view, never the chart.
 *
 * Execution mode follows the platform's own rule, "Default to interactive",
 * with hold kept for what its table lists: transfers, escalations, and
 * operations over ten seconds. Every tool here is one store read or write that
 * returns in well under a second, and in hold mode "Agent stays silent (no
 * reply.started)", which the same page names as the anti-pattern: the agent
 * goes mute and the caller thinks the call dropped. Measured on live calls,
 * every one of those windows was added to the gap the caller sits through.
 *
 * `save_field` is the single exception. It is the only tool whose result is a
 * sentence the caller has to hear word for word, and interactive mode opens a
 * reply of the agent's own while the tool runs, the documented "let me check"
 * transition. That would put filler in front of every readback and give the
 * model a turn in which to say the number its own way. Nothing in the docs
 * says hold makes a returned sentence verbatim; it is kept here because it is
 * the one tool that must not be talked over.
 *
 * Parameter hints are written for turn-taking as much as validation: the
 * platform waits for a whole phone number or date before it ends the caller's
 * turn, and it learns what a whole one looks like from these descriptions,
 * examples and patterns.
 */

export type ToolName =
  | "start_intake"
  | "save_field"
  | "check_medication"
  | "find_slots"
  | "book_appointment"
  | "escalate"
  | "finish_intake";

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: JsonSchemaObject;
  execution_mode: "interactive" | "hold";
  timeout_seconds: number;
}

const INTAKE_ID = {
  type: "string",
  description:
    "The intake id that start_intake returned, exactly as given. Six characters. Never say it out loud.",
  examples: ["K7F2Q9"],
};

/**
 * What a complete value looks like for each field, written as the value the
 * tool receives rather than the words the caller says. The phone line is the
 * one that decides turn-taking: it tells the platform to wait for ten digits
 * instead of replying after the first pause.
 */
const VALUE_SHAPES =
  "full_name: the whole name. date_of_birth: YYYY-MM-DD. phone: every digit the caller gives, ten of them in India, spaces where they paused; wait for the whole number before calling. reason_for_visit and preferred_time: the caller's own words. medications and allergies: items separated by semicolons, or the word none.";

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "start_intake",
    description:
      "Call once, at the start of your first reply, before anything else. Returns the intake id to pass to every other tool, today's date, the clinic's hours and its doctors. Those are the only clinic facts you may state.",
    parameters: { type: "object", properties: {}, required: [] },
    execution_mode: "interactive",
    timeout_seconds: 8,
  },
  {
    name: "save_field",
    description:
      "Record one intake detail and get the sentence to read back. Call with status heard as soon as the caller gives a value, then say the returned sentence exactly. Call again with status confirmed and the same value only after the caller says yes. Call it again with status heard and the same value when the caller asks to hear a detail again: the sentence it returns is the only correct wording for it. Use status unresolved when the caller cannot or will not give it. Do not call it for a value the caller has not said.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        field: {
          type: "string",
          description: `Which detail this value is. Each one expects its own shape. ${VALUE_SHAPES}`,
          enum: [...FIELD_IDS],
        },
        value: {
          type: "string",
          description: `The value as heard, in the shape this field expects. ${VALUE_SHAPES}`,
          examples: ["Arjun Mehta", "1990-03-12", "98765 43210", "9 8 7 6 5 4 3 2 1 0"],
        },
        status: {
          type: "string",
          description:
            "heard when the caller has just said it, confirmed only after they said yes to the readback, unresolved when they cannot or will not give it.",
          enum: ["heard", "confirmed", "unresolved"],
        },
        replaces_earlier_value: {
          type: "boolean",
          description:
            'True when the caller says the value already on the chart is wrong or out of date, for example "that number is my old one". It records that the caller disowned the earlier value, so the clinic never reads it as current.',
        },
      },
      required: ["intake_id", "field", "value", "status"],
    },
    execution_mode: "hold",
    timeout_seconds: 8,
  },
  {
    name: "check_medication",
    description:
      "Look up a medication the caller named, to get its standard name and spelling before you read the medication list back. Do not call it to find out what a medication does, or for a name you already have the spelling of.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        name: {
          type: "string",
          description: "The medication as the caller said it, without the dose.",
          examples: ["metformin", "atorvastatin", "glycomet"],
        },
      },
      required: ["intake_id", "name"],
    },
    execution_mode: "interactive",
    timeout_seconds: 10,
  },
  {
    name: "find_slots",
    description:
      "Find open appointment times. Offer the caller at most three of the returned times. Call it once for what the caller asked for, and again only if they name a different day or time of day. When it returns no times it says why: tell the caller that reason.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        doctor_id: {
          type: "string",
          description:
            "A doctor id from start_intake, if the caller asked for one. Leave it out otherwise.",
          examples: ["dr-kapoor"],
        },
        date: {
          type: "string",
          description:
            "The day the caller named, as YYYY-MM-DD. Work it out from today's date, which start_intake returned. Leave it out if they named no day.",
          format: "date",
          pattern: "\\d{4}-\\d{2}-\\d{2}",
          examples: ["2026-09-15"],
        },
        part_of_day: {
          type: "string",
          description: "The part of the day the caller asked for, or any if they did not say.",
          enum: ["morning", "afternoon", "evening", "any"],
        },
      },
      required: ["intake_id", "part_of_day"],
    },
    execution_mode: "interactive",
    timeout_seconds: 10,
  },
  {
    name: "book_appointment",
    description:
      "Book the slot the caller chose. Only after full name, date of birth and phone are confirmed. Sends the caller a text message confirmation. Call it once for a chosen time, and never for a time find_slots did not return.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        slot_id: {
          type: "string",
          description: "The slot id from find_slots, exactly as given. Never say it out loud.",
          examples: ["dr-iyer_20260915T0940"],
        },
      },
      required: ["intake_id", "slot_id"],
    },
    execution_mode: "interactive",
    timeout_seconds: 15,
  },
  {
    name: "escalate",
    description:
      "Hand the call to the front desk: the caller describes an emergency, asks for a person, is upset, or has stopped answering. The front desk will call them back. It returns the sentence that ends the call.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        reason: {
          type: "string",
          description: "One short sentence, in your own words, for the front desk to read.",
          examples: ["The caller asked to speak to a person.", "No answer after two tries."],
        },
        urgent: { type: "boolean", description: "True if the caller may need emergency care." },
      },
      required: ["intake_id", "reason", "urgent"],
    },
    execution_mode: "interactive",
    timeout_seconds: 8,
  },
  {
    name: "finish_intake",
    description:
      "Call when the intake is done and you are about to say goodbye. Returns any critical detail still unconfirmed, so you can ask for it once more, and once nothing is open, the sentence that ends the call.",
    parameters: {
      type: "object",
      properties: { intake_id: INTAKE_ID },
      required: ["intake_id"],
    },
    execution_mode: "interactive",
    timeout_seconds: 10,
  },
];

/** Tool secrets travel in this header; the platform stores header values write-only. */
export const TOOL_KEY_HEADER = "x-twiceheard-tool-key";

export interface HttpTool extends ToolSpec {
  http: { url: string; http_method: "POST"; headers: Array<{ name: string; value: string }> };
}

/** The tools as a stored agent needs them: each one posting to this clinic's endpoint. */
export function httpTools(baseUrl: string, clinicId: string, toolKey: string): HttpTool[] {
  const root = new URL(baseUrl);
  if (root.protocol !== "https:") throw new Error("tool endpoints must be https");
  return TOOL_SPECS.map((spec) => ({
    ...spec,
    http: {
      url: new URL(`/api/tools/${clinicId}/${spec.name}`, root).toString(),
      http_method: "POST",
      headers: [{ name: TOOL_KEY_HEADER, value: toolKey }],
    },
  }));
}
