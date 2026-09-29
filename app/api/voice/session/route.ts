import { z } from "zod";
import { HttpError, assertSameOrigin, clientAddress, jsonError, readJson } from "@/lib/http/guard";
import { CALL_GRANT_COOKIE, CALL_GRANT_TTL_MS, issueCallGrant } from "@/lib/security/call-grant";
import { serverDeps } from "@/lib/server/deps";
import { inlineSession } from "@/lib/voice-agent/session";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ clinicId: z.string().min(1).max(40) });
/** Long enough to open the socket, too short to be worth stealing. */
const TOKEN_SECONDS = 60;
/** A browser intake call never needs more than a quarter of an hour. */
const MAX_CALL_SECONDS = 15 * 60;

/**
 * POST /api/voice/session
 *
 * Everything the call button needs to start: a single-use token, and either
 * the clinic's stored agent id or, when no agent can reach this deployment,
 * the same agent configured inline. Only pages on this site may ask, and each
 * address may start a handful of calls in ten minutes, because a token is
 * credit on the voice platform and a public page is otherwise an open tap.
 *
 * The response also sets the short-lived grant the browser needs to relay
 * that call's tool calls back to this app.
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
    const clinic = deps.clinics.byId(clinicId);
    if (!clinic) throw new HttpError(404, "unknown_clinic");
    const token = await deps.voice.mintToken({
      expiresInSeconds: TOKEN_SECONDS,
      maxSessionSeconds: MAX_CALL_SECONDS,
    });
    // A browser call always runs the session inline. The clinic's stored agent
    // lives on the platform's regional host, because that is the only host that
    // can hold a phone number, and this socket opens on the global one, which
    // answers `agent_not_found` for it. The inline session is built from the same
    // prompt and the same tool specs, so the two paths cannot drift.
    const body = { token, mode: "relay" as const, session: inlineSession(clinic) };
    const response = Response.json(body, { headers: { "cache-control": "no-store" } });
    response.headers.append(
      "set-cookie",
      cookie(CALL_GRANT_COOKIE, issueCallGrant(clinic.id, deps.env.secret, deps.now())),
    );
    return response;
  } catch (error) {
    return jsonError(error);
  }
}

function cookie(name: string, value: string): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(CALL_GRANT_TTL_MS / 1000)}`,
  ];
  // Localhost is a secure context but is not served over https during development.
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}
