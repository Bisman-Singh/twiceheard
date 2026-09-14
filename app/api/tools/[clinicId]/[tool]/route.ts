import { z } from "zod";
import { HttpError, jsonError, readJson } from "@/lib/http/guard";
import { sameSecret, toolKeyFor } from "@/lib/security/keys";
import { serverDeps } from "@/lib/server/deps";
import { runTool } from "@/lib/tools/handlers";
import { TOOL_KEY_HEADER, TOOL_SPECS, type ToolName } from "@/lib/voice-agent/tools";

export const runtime = "nodejs";
export const maxDuration = 30;

/** A tool call's arguments are a small JSON object; anything bigger is not from the agent. */
const MAX_BODY_BYTES = 16 * 1024;
const TOOL_NAMES = new Set<string>(TOOL_SPECS.map((spec) => spec.name));
const argumentsSchema = z.record(z.string(), z.unknown());

interface Context {
  params: Promise<{ clinicId: string; tool: string }>;
}

/**
 * POST /api/tools/{clinicId}/{tool}
 *
 * Called by the Voice Agent API, never by a browser, so the proof of origin
 * is the clinic's derived key in a header rather than a same-origin check.
 * The key is compared in constant time before the body is read. The response
 * is what the agent hears back, so failures inside a tool come back as a
 * sentence the agent can act on, not as an error status.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const started = Date.now();
  try {
    const { clinicId, tool } = await context.params;
    const deps = serverDeps();
    const clinic = deps.clinics.byId(clinicId);
    if (!clinic || !TOOL_NAMES.has(tool)) throw new HttpError(404, "not_found");
    const expected = toolKeyFor(clinic.id, deps.env.secret);
    if (!sameSecret(request.headers.get(TOOL_KEY_HEADER), expected)) {
      throw new HttpError(401, "unauthorized");
    }
    const args = await readJson(request, argumentsSchema, MAX_BODY_BYTES);
    const result = await runTool(tool as ToolName, args, {
      clinic,
      store: deps.intakes,
      medications: deps.medications,
      sms: deps.sms,
      now: deps.now,
    });
    // Tool name, outcome and timing only: arguments and results can hold a patient's details.
    console.warn("tool", { clinicId: clinic.id, tool, ok: result.ok, ms: Date.now() - started });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
