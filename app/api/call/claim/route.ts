import { z } from "zod";
import { readCaller } from "@/lib/http/caller";
import { HttpError, assertSameOrigin, jsonError, readJson } from "@/lib/http/guard";
import { serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024;
const bodySchema = z.strictObject({ sessionId: z.string().min(8).max(100) });

/**
 * POST /api/call/claim
 *
 * The page says which platform session its call is running on, the moment the
 * call goes live. First claim wins, so the chart from that call can only ever
 * be read back by the browser that made it. Without this, knowing a session
 * id would be enough to read a stranger's intake.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const deps = serverDeps();
    const caller = readCaller(request, deps.env.secret, deps.now());
    if (!caller || !deps.clinics.byId(caller.clinicId)) {
      throw new HttpError(401, "no_call_in_progress");
    }
    const { sessionId } = await readJson(request, bodySchema, MAX_BODY_BYTES);
    if (!(await deps.claimSession(sessionId, caller.owner))) {
      throw new HttpError(409, "session_claimed");
    }
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
