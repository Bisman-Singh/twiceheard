import type { Clinic } from "@/lib/clinic/config";
import { emptyChart, type Chart } from "@/lib/intake/chart";
import { FIELDS, FIELD_IDS, type FieldId } from "@/lib/intake/fields";
import { gradeChart, type ChartGrade, type Grade, type Verification } from "@/lib/intake/grade";
import { percentile, type CallRecord, type CallStore } from "@/lib/postcall/record";
import { replayChart, type Replay } from "@/lib/postcall/replay";
import {
  callEvents,
  firstAudioLatencies,
  timelineSchema,
  type CallEvent,
} from "@/lib/postcall/timeline";
import { describeSlotId } from "@/lib/scheduling/slots";
import { verifyValue, type Utterance } from "@/lib/verify/hearing";
import type { SecondHearingClient } from "@/lib/verify/transcribe";
import type { SessionDetail } from "@/lib/voice-agent/client";
import { keyterms } from "@/lib/voice-agent/prompt";

/**
 * From a finished session to the record the clinic sees.
 *
 * The session timeline is replayed into a chart that only accepts what the
 * call proves; the recording is heard a second time to score each value; the
 * two are combined into grades. If the second hearing is unavailable the
 * record still gets written, flagged as such and with nothing on it green,
 * because a late chart is worse for a clinic than an honestly partial one and
 * a field is only green when both hearings agree. Each step is walled off for
 * the same reason: one that fails costs its own part of the record, not the
 * call.
 */

export interface PostCallDeps {
  getSession: (sessionId: string) => Promise<SessionDetail>;
  clinicForAgent: (agentId: string | null) => Clinic | null;
  fetchJson: (url: string) => Promise<unknown>;
  hearing: SecondHearingClient;
  calls: CallStore;
  now: () => Date;
}

/** The platform has not attached the timeline yet; worth retrying shortly. */
export class ArtifactsNotReady extends Error {
  constructor() {
    super("session artifacts are not ready");
    this.name = "ArtifactsNotReady";
  }
}

export async function processSession(
  sessionId: string,
  deps: PostCallDeps,
): Promise<CallRecord | null> {
  const session = await deps.getSession(sessionId);
  const clinic = deps.clinicForAgent(session.agent_id);
  if (!clinic) return null;
  const artifact = (type: "audio" | "timeline") =>
    session.artifacts.find((item) => item.type === type)?.url;
  const timelineUrl = artifact("timeline");
  if (!timelineUrl) throw new ArtifactsNotReady();

  const timeline = timelineSchema.parse(await deps.fetchJson(timelineUrl));
  const events = callEvents(timeline);
  // The call's own start is the right stand-in clock for a tool event with no timestamp.
  const replay = stage<Replay>(
    sessionId,
    "replay",
    () =>
      replayChart(
        events,
        { country: clinic.country, timezone: clinic.timezone },
        timeline.started_at_unix_ms ?? deps.now().getTime(),
      ),
    { chart: emptyChart(), issues: [] },
  );
  const { verifications, hearing } = await secondHearing(
    replay.chart,
    artifact("audio"),
    clinic,
    deps,
  );
  const toolEvents = events.filter(
    (event): event is Extract<CallEvent, { kind: "tool" }> => event.kind === "tool",
  );

  const record: CallRecord = {
    // Filed under the id this was asked about, not the one the session echoes back.
    // Every reader of a record has the former: the page, the result route and the
    // webhook all look it up by the id they were given.
    sessionId,
    clinicId: clinic.id,
    processedAt: deps.now().getTime(),
    startedAt: timeline.started_at_unix_ms ?? null,
    durationSeconds: session.duration_seconds ?? null,
    chart: replay.chart,
    grade: gradeFor(replay.chart, verifications, hearing),
    issues: replay.issues,
    verifications,
    hearing,
    ...callFacts(sessionId, toolEvents, clinic, firstAudioLatencies(timeline)),
  };
  await deps.calls.save(record);
  return record;
}

/**
 * One step of the rebuild, walled off. A step that fails costs its own part of
 * the record and nothing more: a clinic can work from a partial chart and can do
 * nothing with a call that was never charted at all. The failure is logged by
 * kind, never by content, because everything a caller said is content.
 */
function stage<T>(sessionId: string, name: string, work: () => T, fallback: T): T {
  try {
    return work();
  } catch (error) {
    console.error("post-call stage failed", {
      sessionId,
      stage: name,
      kind: error instanceof Error ? error.name : "unknown",
    });
    return fallback;
  }
}

/** Heard once, so graded once. */
const HEARD_ONCE = "Heard once only: the recording was not available for a second hearing.";

/**
 * A field is green only when both hearings agree, so a chart graded on the
 * conversation alone has nothing green on it and is not ready for the clinic to
 * act on. The cap lives here and not in the grader because this is where it is
 * known whether the recording was heard: the grader also runs during the call
 * and in the evals, where no second hearing exists yet.
 */
function gradeFor(
  chart: Chart,
  verifications: Partial<Record<FieldId, Verification>>,
  hearing: CallRecord["hearing"],
): ChartGrade {
  const graded = gradeChart(chart, verifications);
  if (hearing === "verified") return graded;
  const fields = graded.fields.map((field) =>
    field.grade === "green"
      ? { ...field, grade: "amber" as const, reasons: [...field.reasons, HEARD_ONCE] }
      : field,
  );
  const counts: Record<Grade, number> = { green: 0, amber: 0, red: 0 };
  for (const field of fields) counts[field.grade] += 1;
  // No field is green, and every critical field would have to be.
  return { fields, counts, ready: false };
}

/** What the tools and the platform's own timings say about the call. */
function callFacts(
  sessionId: string,
  events: ReadonlyArray<Extract<CallEvent, { kind: "tool" }>>,
  clinic: Clinic,
  firstAudioMs: number[],
) {
  const durations = events.map((event) => event.durationMs).filter((ms) => ms !== null);
  return {
    booking: stage(sessionId, "booking", () => bookingFrom(events, clinic), null),
    escalation: stage(sessionId, "escalation", () => escalationFrom(events), null),
    latency: {
      firstAudioMs,
      p50: percentile(firstAudioMs, 0.5),
      p95: percentile(firstAudioMs, 0.95),
    },
    tools: {
      calls: events.length,
      failures: events.filter((event) => event.failed).length,
      p50Ms: percentile(durations, 0.5),
    },
  };
}

async function secondHearing(
  chart: Chart,
  audioUrl: string | undefined,
  clinic: Clinic,
  deps: PostCallDeps,
) {
  if (!audioUrl) return { verifications: {}, hearing: "unavailable" as const };
  try {
    const heard = await deps.hearing.transcribe(audioUrl, keyterms(clinic));
    // Nothing on the caller's channel is not a second hearing. Saying it was one
    // would let every field be graded against silence.
    if (heard.caller.length === 0) return { verifications: {}, hearing: "unavailable" as const };
    return {
      verifications: verifyChart(chart, heard.caller, heard.agent),
      hearing: "verified" as const,
    };
  } catch {
    return { verifications: {}, hearing: "unavailable" as const };
  }
}

export function verifyChart(
  chart: Chart,
  caller: readonly Utterance[],
  agent: readonly Utterance[] = [],
): Partial<Record<FieldId, Verification>> {
  const result: Partial<Record<FieldId, Verification>> = {};
  for (const id of FIELD_IDS) {
    const value = chart[id].value;
    if (value === null) continue;
    // A field the second hearing cannot check has not been heard twice, so it must
    // not be green. Free text has no value to search the recording for, and leaving
    // it out of the result let the grader fall back to the live chart: the reason
    // for the visit came out green on every ordinary call, on the model's word
    // alone, with no readback, no yes and no second hearing behind it.
    result[id] = verifyValue(FIELDS[id], value, caller, agent);
  }
  return result;
}

function succeeded(event: Extract<CallEvent, { kind: "tool" }>): boolean {
  if (event.failed || !event.result) return false;
  try {
    return (JSON.parse(event.result) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

function bookingFrom(events: ReadonlyArray<Extract<CallEvent, { kind: "tool" }>>, clinic: Clinic) {
  const booked = events
    .filter((event) => event.name === "book_appointment" && succeeded(event))
    .at(-1);
  const slot =
    booked && typeof booked.args.slot_id === "string"
      ? describeSlotId(clinic, booked.args.slot_id)
      : null;
  return slot ? { slotId: slot.id, spoken: slot.spoken } : null;
}

function escalationFrom(events: ReadonlyArray<Extract<CallEvent, { kind: "tool" }>>) {
  const raised = events.filter((event) => event.name === "escalate" && succeeded(event)).at(-1);
  if (!raised) return null;
  const urgent = raised.args.urgent === true || raised.args.urgent === "true";
  return { reason: String(raised.args.reason ?? "").slice(0, 300), urgent };
}
