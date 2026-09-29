import { HttpError } from "@/lib/http/guard";
import { ArtifactsNotReady, processSession, type PostCallDeps } from "@/lib/postcall/process";
import type { CallRecord } from "@/lib/postcall/record";
import type { ServerDeps } from "@/lib/server/deps";

/**
 * Processing a finished call in the background, patiently.
 *
 * The completion webhook can arrive a moment before the platform has
 * attached the recording and timeline, so a missing artifact is retried after
 * a short wait. Any other failure is logged by kind, never by content, and
 * left for the next delivery or a manual reprocess.
 */

export const RETRY_DELAYS_MS = [5_000, 20_000] as const;

export async function processWithRetry(
  sessionId: string,
  deps: PostCallDeps,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<CallRecord | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await processSession(sessionId, deps);
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (error instanceof ArtifactsNotReady && delay !== undefined) {
        await sleep(delay);
        continue;
      }
      console.error("post-call processing failed", {
        sessionId,
        attempt: attempt + 1,
        kind: error instanceof Error ? error.name : "unknown",
      });
      return null;
    }
  }
}

/** The post-call dependencies, drawn from the server's shared set. */
export function postCallDeps(deps: ServerDeps, fetchImpl: typeof fetch = fetch): PostCallDeps {
  return {
    getSession: (id) => deps.voice.getSession(id),
    clinicForAgent: (agentId) => deps.clinics.forAgent(agentId),
    fetchJson: (url) => fetchArtifact(url, fetchImpl),
    hearing: deps.hearing,
    calls: deps.calls,
    now: deps.now,
  };
}

/** Timelines are small; a capped, time-limited fetch keeps a bad link from holding the function. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** The platform's own hosts. A link that points anywhere else is not followed. */
const ARTIFACT_HOSTS = /(^|\.)assemblyai\.com$/;

export async function fetchArtifact(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const target = new URL(url);
  if (target.protocol !== "https:" || !ARTIFACT_HOSTS.test(target.hostname)) {
    throw new HttpError(502, "artifact_unavailable");
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new HttpError(502, "artifact_unavailable");
  const text = await response.text();
  if (text.length > MAX_ARTIFACT_BYTES) throw new HttpError(502, "artifact_too_large");
  return JSON.parse(text);
}
