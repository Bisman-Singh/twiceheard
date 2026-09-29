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
  /**
   * Whether the second hearing ran. When it did not, the grades rest on the
   * conversation alone, so nothing on the chart is green and it is not ready:
   * a field is green only when both hearings agree.
   */
  hearing: "verified" | "unavailable";
  booking: { slotId: string; spoken: string } | null;
  escalation: { reason: string; urgent: boolean } | null;
  latency: { firstAudioMs: number[]; p50: number | null; p95: number | null };
  tools: { calls: number; failures: number; p50Ms: number | null };
}

export interface CallStore {
  save(record: CallRecord): Promise<void>;
  get(sessionId: string): Promise<CallRecord | null>;
  /** Newest first, skipping `offset` of the newest so a desk can page back. */
  list(clinicId: string, limit: number, offset?: number): Promise<CallRecord[]>;
  /**
   * Erases one call for good, so a person can be forgotten on request.
   *
   * The clinic is part of the ask, not something the store infers, so a record
   * can only ever be erased by the clinic that holds it. Reports whether a
   * record was there to erase: a caller asking twice is not an error, but the
   * difference is worth an audit line the first time.
   */
  remove(clinicId: string, sessionId: string): Promise<boolean>;
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
    async list(clinicId, limit, offset = 0) {
      return [...records.values()]
        .filter((record) => record.clinicId === clinicId)
        .sort((a, b) => b.processedAt - a.processedAt)
        .slice(offset, offset + limit);
    },
    async remove(clinicId, sessionId) {
      if (records.get(sessionId)?.clinicId !== clinicId) return false;
      records.delete(sessionId);
      return true;
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
