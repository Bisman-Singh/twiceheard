import { z } from "zod";
import { claimIsLive, readCaller } from "@/lib/http/caller";
import { HttpError, assertSameOrigin, jsonError, meterCaller, readJson } from "@/lib/http/guard";
import { ArtifactsNotReady, processSession } from "@/lib/postcall/process";
import type { CallRecord } from "@/lib/postcall/record";
import { postCallDeps } from "@/lib/postcall/run";
import { serverDeps } from "@/lib/server/deps";
import type { SessionClaim } from "@/lib/store/redis";
import { VoiceAgentApiError } from "@/lib/voice-agent/client";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 2 * 1024;
const bodySchema = z.strictObject({ sessionId: z.string().min(8).max(100) });

/**
 * POST /api/call/result
 *
 * The caller's own chart, once the call is over. In production the completion
 * webhook usually gets there first and this only reads what it wrote; on a
 * laptop no webhook can reach the machine, so the first ask does the work
 * itself. Either way the recording is heard a second time exactly once per
 * call, because a finished record is never processed again.
 *
 * A session that has just ended has no recording attached yet, which is not
 * an error: the answer is "pending" and the page asks again.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const deps = serverDeps();
    const caller = readCaller(request, deps.env.secret, deps.now());
    const clinic = caller ? deps.clinics.byId(caller.clinicId) : null;
    if (!caller || !clinic) throw new HttpError(401, "no_call_in_progress");
    // Each ask can drive a paid second transcription, so it is metered on the
    // address as well as the owner.
    await meterCaller(deps.resultChecks, caller.owner, request);
    const { sessionId } = await readJson(request, bodySchema, MAX_BODY_BYTES);
    // Ownership, not a guessable id, is what makes this call's chart readable.
    // The owner is checked before any work is done; whether the claim was made
    // while the call was live is checked against the call's own start, below.
    const claim = await deps.sessions.claimOf(sessionId);
    if (claim?.owner !== caller.owner) throw new HttpError(403, "not_yours");

    const saved = await deps.calls.get(sessionId);
    if (saved) return ready(mine(saved, claim, clinic.id));

    // A relayed call carries no agent id, so the clinic comes from the grant instead.
    const post = postCallDeps(deps);
    const record = await processSession(sessionId, {
      ...post,
      hearing: deps.quickHearing,
      clinicForAgent: (agentId) => post.clinicForAgent(agentId) ?? clinic,
    }).catch((error: unknown) => {
      // Not ready, and a session the platform has not published yet, are both "ask again".
      if (error instanceof ArtifactsNotReady) return undefined;
      if (error instanceof VoiceAgentApiError && error.status === 404) return undefined;
      throw error;
    });
    // Not ready yet, and a session that belongs to no clinic here, are both
    // "ask again": neither is a chart, and neither is an error to report.
    if (!record) {
      return Response.json({ status: "pending" }, { headers: { "cache-control": "no-store" } });
    }
    return ready(mine(record, claim, clinic.id));
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * The record, but only if it is this caller's to see. The clinic on the record
 * decides, not the clinic on the grant, and the claim has to have been made
 * while the call was running.
 */
function mine(record: CallRecord, claim: SessionClaim, clinicId: string): CallRecord | null {
  if (record.clinicId !== clinicId) return null;
  return claimIsLive(claim, claim.owner, record.startedAt) ? record : null;
}

function ready(record: CallRecord | null): Response {
  if (!record) throw new HttpError(404, "no_record");
  return Response.json({ status: "ready", record }, { headers: { "cache-control": "no-store" } });
}
