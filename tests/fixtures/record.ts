import { FIELD_IDS, type FieldId, type FieldValue } from "@/lib/intake/fields";
import type { Chart, FieldRecord, FieldStatus } from "@/lib/intake/chart";
import { gradeChart, type Verification } from "@/lib/intake/grade";
import type { CallRecord } from "@/lib/postcall/record";

/** A finished call, built from the real types so a display test cannot drift from the product. */

type Answers = Partial<Record<FieldId, { value: FieldValue | null; status: FieldStatus }>>;

export function chartOf(answers: Answers): Chart {
  const entries = FIELD_IDS.map((id): [FieldId, FieldRecord] => {
    const answer = answers[id] ?? { value: null, status: "missing" as FieldStatus };
    return [
      id,
      {
        id,
        value: answer.value,
        status: answer.status,
        attempts: answer.value === null ? 0 : 1,
        history: [],
      },
    ];
  });
  return Object.fromEntries(entries) as Chart;
}

export function callRecord(
  answers: Answers,
  verifications: Partial<Record<FieldId, Verification>> = {},
  overrides: Partial<CallRecord> = {},
): CallRecord {
  const chart = chartOf(answers);
  return {
    sessionId: "sess_fixture",
    clinicId: "sunrise-family",
    processedAt: Date.parse("2026-09-29T06:40:00Z"),
    startedAt: Date.parse("2026-09-29T06:38:00Z"),
    durationSeconds: 63,
    chart,
    grade: gradeChart(chart, verifications),
    issues: [],
    verifications,
    hearing: "verified",
    booking: null,
    escalation: null,
    latency: { firstAudioMs: [800], p50: 800, p95: 800 },
    tools: { calls: 4, failures: 0, p50Ms: 40 },
    ...overrides,
  };
}
