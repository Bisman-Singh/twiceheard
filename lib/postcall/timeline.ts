import { z } from "zod";

/**
 * The session timeline the Voice Agent API stores for every call, reduced to
 * what Earshot uses: who said what, which tools ran with which arguments, and
 * how quickly the agent answered.
 *
 * Parsing is lenient about fields Earshot does not read and strict about the
 * ones it does, so a new field from the platform never breaks a chart.
 */

const toolCallSchema = z.object({
  call_id: z.string(),
  name: z.string(),
  arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  result: z.string().nullable().optional(),
  dispatched_at_ms: z.number().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  is_error: z.boolean().optional(),
  timed_out: z.boolean().optional(),
});

const turnSchema = z.object({
  turn_id: z.string(),
  status: z.string().optional(),
  trigger: z.string().optional(),
  user_transcript: z.string().nullable().optional(),
  user_speech_ended_at_ms: z.number().nullable().optional(),
  user_confidence: z.number().nullable().optional(),
  agent_text: z.string().nullable().optional(),
  interrupted_at_ms: z.number().nullable().optional(),
  time_to_first_audio_ms: z.number().nullable().optional(),
  tool_calls: z.array(toolCallSchema).nullable().optional(),
});

export const timelineSchema = z.object({
  session_id: z.string(),
  started_at_unix_ms: z.number().optional(),
  turns: z.array(turnSchema).default([]),
});

export type Timeline = z.infer<typeof timelineSchema>;
export type TimelineTurn = z.infer<typeof turnSchema>;

/** One thing that happened on the call, in the order it happened. */
export type CallEvent =
  | { kind: "caller"; text: string; confidence: number | null }
  | {
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      at: number | null;
      durationMs: number | null;
      failed: boolean;
    }
  | { kind: "agent"; text: string; interrupted: boolean };

/**
 * Within a turn the caller speaks first, tools run on what they said, and the
 * agent's words come last. Turn labels are not relied on: the platform can
 * file a tool call under an unexpected trigger, but never out of order.
 */
export function callEvents(timeline: Timeline): CallEvent[] {
  return timeline.turns.flatMap((turn) => {
    const events: CallEvent[] = [];
    const caller = turn.user_transcript?.trim();
    if (caller)
      events.push({ kind: "caller", text: caller, confidence: turn.user_confidence ?? null });
    events.push(...(turn.tool_calls ?? []).map(toolEvent));
    const agent = turn.agent_text?.trim();
    const interrupted = (turn.interrupted_at_ms ?? null) !== null;
    if (agent) events.push({ kind: "agent", text: agent, interrupted });
    return events;
  });
}

function toolEvent(call: z.infer<typeof toolCallSchema>): CallEvent {
  return {
    kind: "tool",
    name: call.name,
    args: parseArguments(call.arguments),
    at: call.dispatched_at_ms ?? null,
    durationMs: call.duration_ms ?? null,
    failed: Boolean(call.is_error || call.timed_out),
  };
}

function parseArguments(
  raw: Record<string, unknown> | string | undefined,
): Record<string, unknown> {
  if (raw === undefined) return {};
  if (typeof raw !== "string") return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** How quickly the agent started speaking, per answered turn, as the platform measured it. */
export function firstAudioLatencies(timeline: Timeline): number[] {
  return timeline.turns
    .filter((turn) => turn.trigger !== "greeting")
    .map((turn) => turn.time_to_first_audio_ms)
    .filter((ms): ms is number => typeof ms === "number" && ms >= 0);
}
