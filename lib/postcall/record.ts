import type { Chart } from "@/lib/intake/chart";
import type { FieldId } from "@/lib/intake/fields";
import type { ChartGrade, Verification } from "@/lib/intake/grade";
import type { ReplayIssue } from "@/lib/postcall/replay";

/**
 * What the clinic keeps about a finished call.
 *
 * Structured results only: the verified chart, the grades and the reasons for
 * them, what was booked, and how the call went. No transcript and no audio;
 * those stay in the voice platform's session history, where the dashboard
 * links to them, and the second hearing's words are deleted once scored.
 */
export interface CallRecord {
  sessionId: string;
  clinicId: string;
  processedAt: number;
  startedAt: number | null;
  durationSeconds: number | null;
  chart: Chart;
  grade: ChartGrade;
  issues: ReplayIssue[];
  verifications: Partial<Record<FieldId, Verification>>;
  /** Whether the second hearing ran; when it did not, grades rest on the conversation alone. */
  hearing: "verified" | "unavailable";
  booking: { slotId: string; spoken: string } | null;
  escalation: { reason: string; urgent: boolean } | null;
  latency: { firstAudioMs: number[]; p50: number | null; p95: number | null };
  tools: { calls: number; failures: number; p50Ms: number | null };
}

export interface CallStore {
  save(record: CallRecord): Promise<void>;
  get(sessionId: string): Promise<CallRecord | null>;
  /** Newest first. */
  list(clinicId: string, limit: number): Promise<CallRecord[]>;
}

export function memoryCallStore(): CallStore {
  const records = new Map<string, CallRecord>();
  return {
    async save(record) {
      records.set(record.sessionId, record);
    },
    async get(sessionId) {
      return records.get(sessionId) ?? null;
    },
    async list(clinicId, limit) {
      return [...records.values()]
        .filter((record) => record.clinicId === clinicId)
        .sort((a, b) => b.processedAt - a.processedAt)
        .slice(0, limit);
    },
  };
}

/** The value below which the given share of samples fall; null for no samples. */
export function percentile(samples: readonly number[], share: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1));
  return sorted[index] as number;
}
