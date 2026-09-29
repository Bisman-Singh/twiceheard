import { z } from "zod";
import { readCaller } from "@/lib/http/caller";
import { HttpError, assertSameOrigin, jsonError, readJson } from "@/lib/http/guard";
import { ArtifactsNotReady, processSession } from "@/lib/postcall/process";
import { postCallDeps } from "@/lib/postcall/run";
import { serverDeps } from "@/lib/server/deps";
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
    if (!(await deps.resultChecks.allow(caller.owner))) {
      throw new HttpError(429, "rate_limited", "Too many requests. Please wait a moment.");
    }
    const { sessionId } = await readJson(request, bodySchema, MAX_BODY_BYTES);
    // Ownership, not a guessable id, is what makes this call's chart readable.
    if (!(await deps.sessions.isOwner(sessionId, caller.owner)))
      throw new HttpError(403, "not_yours");

    const saved = await deps.calls.get(sessionId);
    if (saved) return ready(saved.clinicId === clinic.id ? saved : null);

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
    if (record === undefined) {
      return Response.json({ status: "pending" }, { headers: { "cache-control": "no-store" } });
    }
    return ready(record);
  } catch (error) {
    return jsonError(error);
  }
}

function ready(record: unknown): Response {
  if (!record) throw new HttpError(404, "no_record");
  return Response.json({ status: "ready", record }, { headers: { "cache-control": "no-store" } });
}
