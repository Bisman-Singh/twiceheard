import { FIELD_IDS } from "@/lib/intake/fields";

/**
 * The tools the agent can call, defined once.
 *
 * Every tool is an HTTP tool on a stored agent, so a phone call works with no
 * client in the loop: AssemblyAI calls Earshot's API directly. Tool requests
 * carry only the model's arguments, so the first call, `start_intake`, hands
 * the agent a short intake id that every later call repeats. That id is what
 * lets the live board follow a call; the authoritative record is rebuilt
 * after the call from the session timeline, so a garbled id costs the live
 * view, never the chart.
 *
 * Almost everything runs in hold mode: the platform then speaks the tool's
 * sentence verbatim, which matters when that sentence is a readback.
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
  description: "The intake id that start_intake returned, exactly as given.",
  examples: ["K7F2Q9"],
};

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "start_intake",
    description:
      "Call once, at the start of your first reply, before anything else. Returns the intake id to pass to every other tool, today's date, the clinic's hours and its doctors.",
    parameters: { type: "object", properties: {}, required: [] },
    execution_mode: "hold",
    timeout_seconds: 8,
  },
  {
    name: "save_field",
    description:
      "Record one intake detail. Call with status heard as soon as the caller gives a value, then say the returned sentence exactly. Call again with status confirmed and the same value only after the caller says yes. Use status unresolved when the caller cannot or will not give it.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        field: { type: "string", enum: [...FIELD_IDS] },
        value: {
          type: "string",
          description:
            "The value as heard. Dates as YYYY-MM-DD. Phone numbers as the digits heard, spaces allowed. Medications and allergies: items separated by semicolons, or the word none.",
          examples: ["Arjun Mehta", "1990-03-12", "98765 43210", "metformin 500 mg; atorvastatin"],
        },
        status: { type: "string", enum: ["heard", "confirmed", "unresolved"] },
      },
      required: ["intake_id", "field", "value", "status"],
    },
    execution_mode: "hold",
    timeout_seconds: 8,
  },
  {
    name: "check_medication",
    description:
      "Look up a medication the caller named, to get its standard name and spelling before you read the medication list back.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        name: {
          type: "string",
          description: "The medication as the caller said it.",
          examples: ["metformin"],
        },
      },
      required: ["intake_id", "name"],
    },
    execution_mode: "hold",
    timeout_seconds: 10,
  },
  {
    name: "find_slots",
    description:
      "Find open appointment times. Offer the caller at most three of the returned times.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        doctor_id: {
          type: "string",
          description: "A doctor id from start_intake, if the caller asked for one.",
        },
        date: { type: "string", description: "YYYY-MM-DD, if the caller named a day." },
        part_of_day: { type: "string", enum: ["morning", "afternoon", "evening", "any"] },
      },
      required: ["intake_id", "part_of_day"],
    },
    execution_mode: "hold",
    timeout_seconds: 10,
  },
  {
    name: "book_appointment",
    description:
      "Book the slot the caller chose. Only after full name, date of birth and phone are confirmed. Sends the caller a text message confirmation.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        slot_id: { type: "string", description: "The slot id from find_slots." },
      },
      required: ["intake_id", "slot_id"],
    },
    execution_mode: "hold",
    timeout_seconds: 15,
  },
  {
    name: "escalate",
    description:
      "Hand the call to the front desk: the caller describes an emergency, asks for a person, or is upset. The front desk will call them back.",
    parameters: {
      type: "object",
      properties: {
        intake_id: INTAKE_ID,
        reason: { type: "string", description: "One short sentence." },
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
      "Call when you are about to say goodbye. Returns any critical detail still unconfirmed, so you can ask for it once more.",
    parameters: {
      type: "object",
      properties: { intake_id: INTAKE_ID },
      required: ["intake_id"],
    },
    execution_mode: "hold",
    timeout_seconds: 10,
  },
];

/** Tool secrets travel in this header; the platform stores header values write-only. */
export const TOOL_KEY_HEADER = "x-earshot-tool-key";

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
