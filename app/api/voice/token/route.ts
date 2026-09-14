import { z } from "zod";
import { HttpError, assertSameOrigin, clientAddress, jsonError, readJson } from "@/lib/http/guard";
import { serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ clinicId: z.string().min(1).max(40) });
/** Long enough to open the socket, too short to be worth stealing. */
const TOKEN_SECONDS = 60;
/** A browser intake call never needs more than a quarter of an hour. */
const MAX_CALL_SECONDS = 15 * 60;

/**
 * POST /api/voice/token
 *
 * Mints a single-use token for the browser call button. Only pages on this
 * site may ask, and each address may start a handful of calls in ten
 * minutes, because a token is credit on the voice platform and a public page
 * is otherwise an open tap on it.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const deps = serverDeps();
    if (!(await deps.callStarts.allow(clientAddress(request)))) {
      throw new HttpError(
        429,
        "rate_limited",
        "Too many calls started. Please wait a few minutes.",
      );
    }
    const { clinicId } = await readJson(request, bodySchema, 1024);
    const agentId = deps.clinics.byId(clinicId) ? deps.clinics.agentFor(clinicId) : null;
    if (!agentId) throw new HttpError(404, "no_agent");
    const token = await deps.voice.mintToken({
      expiresInSeconds: TOKEN_SECONDS,
      maxSessionSeconds: MAX_CALL_SECONDS,
    });
    return Response.json({ token, agentId }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
