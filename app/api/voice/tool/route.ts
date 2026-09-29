import { z } from "zod";
import { HttpError, assertSameOrigin, jsonError, readJson } from "@/lib/http/guard";
import { CALL_GRANT_COOKIE, readCallGrant } from "@/lib/security/call-grant";
import { serverDeps } from "@/lib/server/deps";
import { runTool } from "@/lib/tools/handlers";
import { TOOL_SPECS, type ToolName } from "@/lib/voice-agent/tools";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 16 * 1024;
const TOOL_NAMES = new Set<string>(TOOL_SPECS.map((spec) => spec.name));
const bodySchema = z.strictObject({
  tool: z.string().max(40),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

/**
 * POST /api/voice/tool
 *
 * The browser's side of a relayed call: the platform asks the page to run a
 * tool, and the page passes it here rather than doing anything itself. The
 * request must come from this site and carry the grant cookie issued when
 * the call started, so a page cannot drive another clinic's intake and a
 * stranger cannot drive one at all. The work is the same code the phone runs.
 */
export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  try {
    assertSameOrigin(request);
    const deps = serverDeps();
    const grant = cookieValue(request.headers.get("cookie"), CALL_GRANT_COOKIE);
    const clinicId = readCallGrant(grant, deps.env.secret, deps.now());
    const clinic = clinicId ? deps.clinics.byId(clinicId) : null;
    if (!clinic) throw new HttpError(401, "no_call_in_progress");
    const body = await readJson(request, bodySchema, MAX_BODY_BYTES);
    if (!TOOL_NAMES.has(body.tool)) throw new HttpError(404, "unknown_tool");
    const result = await runTool(body.tool as ToolName, body.arguments, {
      clinic,
      store: deps.intakes,
      medications: deps.medications,
      sms: deps.sms,
      now: deps.now,
    });
    // Tool name, outcome and timing only: arguments and results can hold a patient's details.
    console.warn("tool", {
      clinicId: clinic.id,
      tool: body.tool,
      ok: result.ok,
      ms: Date.now() - started,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

function cookieValue(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
