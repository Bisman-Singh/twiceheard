import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import { emptyChart } from "@/lib/intake/chart";
import {
  ArtifactsNotReady,
  processSession,
  verifyChart,
  type PostCallDeps,
} from "@/lib/postcall/process";
import { memoryCallStore, percentile } from "@/lib/postcall/record";
import { describeSlotId } from "@/lib/scheduling/slots";
import type { Utterance } from "@/lib/verify/hearing";
import { SecondHearingError } from "@/lib/verify/transcribe";
import type { SessionDetail } from "@/lib/voice-agent/client";

const timeline = JSON.parse(readFileSync("tests/fixtures/timeline.json", "utf8"));
const hearingFixture = JSON.parse(readFileSync("tests/fixtures/second-hearing.json", "utf8")) as {
  utterances: Array<{ channel: string; words: Utterance }>;
};
const caller = hearingFixture.utterances.filter((u) => u.channel === "1").map((u) => u.words);
const agentsWords = hearingFixture.utterances.filter((u) => u.channel === "2").map((u) => u.words);

const session: SessionDetail = {
  id: "sess_fixture",
  agent_id: "agent-sunrise",
  status: "completed",
  duration_seconds: 63.1,
  artifacts: [
    { type: "audio", url: "https://cdn.assemblyai.com/a.ogg" },
    { type: "timeline", url: "https://cdn.assemblyai.com/t.json" },
  ],
};

function deps(overrides: Partial<PostCallDeps> = {}): PostCallDeps {
  return {
    getSession: async () => session,
    clinicForAgent: (agentId) => (agentId === "agent-sunrise" ? DEMO_CLINIC : null),
    fetchJson: async () => timeline,
    hearing: { transcribe: vi.fn(async () => ({ caller, agent: agentsWords })) },
    calls: memoryCallStore(),
    now: () => new Date("2026-09-14T12:05:00Z"),
    ...overrides,
  };
}

describe("processSession on a real call", () => {
  it("writes a record where what was confirmed and heard again is green and the rest is honest", async () => {
    const d = deps();
    const record = await processSession("sess_fixture", d);
    expect(record).not.toBeNull();
    const grades = Object.fromEntries(
      record?.grade.fields.map((field) => [field.id, field.grade]) ?? [],
    );
    expect(grades).toMatchObject({
      full_name: "green",
      date_of_birth: "green",
      phone: "red",
      allergies: "red",
    });
    expect(record?.grade.ready).toBe(false);
    expect(record?.hearing).toBe("verified");
    expect(record?.verifications.full_name?.hearing).toBe("agrees");
    expect(record).toMatchObject({
      clinicId: "sunrise-family",
      durationSeconds: 63.1,
      issues: [],
      booking: null,
      escalation: null,
      latency: { firstAudioMs: [506], p50: 506, p95: 506 },
      tools: { calls: 4, failures: 0 },
    });
    expect(await d.calls.get("sess_fixture")).toEqual(record);
    expect(d.hearing.transcribe).toHaveBeenCalledWith(
      "https://cdn.assemblyai.com/a.ogg",
      expect.arrayContaining(["Dr. Neha Kapoor"]),
    );
  });
});

describe("processSession", () => {
  it("ignores sessions that belong to no clinic", async () => {
    const d = deps({ clinicForAgent: () => null });
    expect(await processSession("sess_other", d)).toBeNull();
  });

  it("asks to be retried when the timeline is not attached yet", async () => {
    const d = deps({ getSession: async () => ({ ...session, artifacts: [] }) });
    await expect(processSession("sess_fixture", d)).rejects.toBeInstanceOf(ArtifactsNotReady);
  });

  it("still writes the record when the second hearing fails or there is no recording, and says so", async () => {
    const failing = deps({
      hearing: { transcribe: async () => Promise.reject(new SecondHearingError("timed_out")) },
    });
    const noAudio = deps({
      getSession: async () => ({ ...session, artifacts: session.artifacts.slice(1) }),
    });
    for (const d of [failing, noAudio]) {
      const record = await processSession("sess_fixture", d);
      expect(record?.hearing).toBe("unavailable");
      expect(record?.verifications).toEqual({});
      expect(record?.grade.fields.find((field) => field.id === "full_name")?.grade).toBe("green");
    }
  });

  it("records the booking and escalation the tools actually completed", async () => {
    const turns = [
      {
        turn_id: "t1",
        tool_calls: [
          {
            call_id: "a",
            name: "book_appointment",
            arguments: { slot_id: "dr-sen_20260915T1000" },
            result: '{"ok":false}',
          },
          {
            call_id: "b",
            name: "book_appointment",
            arguments: { slot_id: "dr-iyer_20260915T0940" },
            result: '{"ok":true,"say":"booked"}',
            duration_ms: 120,
          },
          {
            call_id: "c",
            name: "book_appointment",
            arguments: { slot_id: "dr-kapoor_20260915T0900" },
            result: "not json",
          },
          {
            call_id: "d",
            name: "escalate",
            arguments: { reason: "Wants a person", urgent: "true" },
            result: '{"ok":true}',
            duration_ms: 80,
          },
          {
            call_id: "e",
            name: "escalate",
            arguments: { urgent: false },
            is_error: true,
            result: '{"ok":true}',
          },
          { call_id: "f", name: "finish_intake", timed_out: true },
        ],
      },
    ];
    const d = deps({ fetchJson: async () => ({ session_id: "s", turns }) });
    const record = await processSession("sess_fixture", d);
    expect(record?.booking).toEqual({
      slotId: "dr-iyer_20260915T0940",
      spoken: "Tuesday 15 September at 9:40 am with Dr. Rahul Iyer",
    });
    expect(record?.escalation).toEqual({ reason: "Wants a person", urgent: true });
    expect(record?.tools).toEqual({ calls: 6, failures: 2, p50Ms: 80 });
    expect(record?.startedAt).toBeNull();
    expect(record?.latency).toEqual({ firstAudioMs: [], p50: null, p95: null });
  });

  it("leaves booking and escalation empty when their arguments cannot be read", async () => {
    const turns = [
      {
        turn_id: "t1",
        tool_calls: [
          {
            call_id: "a",
            name: "book_appointment",
            arguments: { slot_id: 7 },
            result: '{"ok":true}',
          },
          {
            call_id: "b",
            name: "book_appointment",
            arguments: { slot_id: "dr-who_20260915T0940" },
            result: '{"ok":true}',
          },
          { call_id: "c", name: "escalate", arguments: {}, result: '{"ok":true}' },
          { call_id: "d", name: "escalate", arguments: {} },
        ],
      },
    ];
    const record = await processSession(
      "sess_fixture",
      deps({ fetchJson: async () => ({ session_id: "s", turns }) }),
    );
    expect(record?.booking).toBeNull();
    expect(record?.escalation).toEqual({ reason: "", urgent: false });
    expect(record?.durationSeconds).toBe(63.1);
    const noDuration = await processSession(
      "sess_fixture",
      deps({ getSession: async () => ({ ...session, duration_seconds: undefined }) }),
    );
    expect(noDuration?.durationSeconds).toBeNull();
  });
});

describe("verifyChart", () => {
  it("verifies only fields that hold a value and can be verified", () => {
    expect(verifyChart(emptyChart(), caller)).toEqual({});
  });
});

describe("records", () => {
  it("lists a clinic's calls newest first and computes percentiles", async () => {
    const store = memoryCallStore();
    const base = (await processSession("sess_fixture", deps())) as NonNullable<
      Awaited<ReturnType<typeof processSession>>
    >;
    await store.save({ ...base, sessionId: "old", processedAt: 1 });
    await store.save({ ...base, sessionId: "new", processedAt: 2 });
    await store.save({ ...base, sessionId: "elsewhere", clinicId: "other", processedAt: 3 });
    expect((await store.list("sunrise-family", 10)).map((record) => record.sessionId)).toEqual([
      "new",
      "old",
    ]);
    expect(await store.list("sunrise-family", 1)).toHaveLength(1);
    expect(await store.get("missing")).toBeNull();
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([900, 300, 700, 500, 1900], 0.5)).toBe(700);
    expect(percentile([900, 300, 700, 500, 1900], 0.95)).toBe(1900);
    expect(percentile([5], 0)).toBe(5);
  });

  it("describes a slot id after the fact without checking it is still open", () => {
    expect(describeSlotId(DEMO_CLINIC, "dr-iyer_20200101T0940")?.spoken).toBe(
      "Wednesday 1 January at 9:40 am with Dr. Rahul Iyer",
    );
    expect(describeSlotId(DEMO_CLINIC, "dr-who_20260915T0940")).toBeNull();
    expect(describeSlotId(DEMO_CLINIC, "garbage")).toBeNull();
  });
});
