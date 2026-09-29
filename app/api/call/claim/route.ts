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
 *
 * The claim is only worth anything while the call is running, so it is refused
 * once the call has been charted, and the time it was made is kept with it.
 * `claimIsLive` reads that time back when a chart is asked for.
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
    // A charted call is a finished call, so the window for a live claim has passed.
    // Every call that came in over the phone ends up here, which is what stops a
    // stranger claiming one by quoting an id they read off a desk address.
    if (await deps.calls.get(sessionId)) throw new HttpError(409, "session_claimed");
    if (!(await deps.sessions.claim(sessionId, caller.owner, deps.now().getTime()))) {
      throw new HttpError(409, "session_claimed");
    }
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
