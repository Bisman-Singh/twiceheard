import { z } from "zod";
import { readCaller } from "@/lib/http/caller";
import { HttpError, assertSameOrigin, jsonError, readJson } from "@/lib/http/guard";
import { serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024;
const bodySchema = z.strictObject({ sessionId: z.string().min(8).max(100) });

/**
 * POST /api/call/forget
 *
 * The caller erases the record of their own call, which is the right the India
 * DPDP Act gives the person the call was about.
 *
 * POST rather than DELETE: the session id is the one handle a caller has on
 * their call, and a body keeps it out of the path, where a proxy log or a
 * referrer would keep a copy. The route names an act, not the record's own
 * address, so there is no resource at this URL for DELETE to mean.
 *
 * Authorisation is the result endpoint's, unchanged, because reading this
 * record back and erasing it are the same entitlement: same origin, a live
 * call grant naming a clinic this deployment serves, and a session this
 * browser claimed while the call was running.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const deps = serverDeps();
    const caller = readCaller(request, deps.env.secret, deps.now());
    const clinic = caller ? deps.clinics.byId(caller.clinicId) : null;
    if (!caller || !clinic) throw new HttpError(401, "no_call_in_progress");
    const { sessionId } = await readJson(request, bodySchema, MAX_BODY_BYTES);
    // Ownership, not a guessable id, is what makes this call's record erasable.
    if (!(await deps.claimSession(sessionId, caller.owner))) throw new HttpError(403, "not_yours");

    if (await deps.calls.remove(clinic.id, sessionId)) {
      // The clinic and the fact of it. What was erased is not written down again here.
      console.warn("call record deleted", { clinicId: clinic.id });
    }
    // Nothing of this caller's is held under that id, whether it went just now,
    // went on an earlier attempt, or was never theirs. One answer for all three
    // keeps a retry safe and says nothing about what another clinic holds.
    return Response.json({ status: "deleted" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
