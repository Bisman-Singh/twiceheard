import { after } from "next/server";
import { z } from "zod";
import { HttpError, assertContentLength, jsonError } from "@/lib/http/guard";
import { postCallDeps, processWithRetry } from "@/lib/postcall/run";
import { validWebhookSignature } from "@/lib/security/keys";
import { serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";
/** Post-call work runs after the response, within this budget: two retries plus the second hearing. */
export const maxDuration = 300;

const MAX_BODY_BYTES = 64 * 1024;

const deliverySchema = z.object({
  event_id: z.string().min(1).max(200),
  event: z.string().max(60),
  session: z.object({ session_id: z.string().min(1).max(200) }).optional(),
  call: z.object({ session_id: z.string().min(1).max(200).nullable().optional() }).optional(),
});

/**
 * POST /api/webhooks/assemblyai
 *
 * Verifies the HMAC signature over the exact raw body before parsing
 * anything, answers at once, and processes a completed session afterwards.
 * Retried deliveries are recognised by event id and acknowledged without
 * doing the work twice.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertContentLength(request, MAX_BODY_BYTES);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
    const deps = serverDeps();
    if (
      !validWebhookSignature(raw, request.headers.get("x-aai-signature"), deps.env.webhookSecret)
    ) {
      throw new HttpError(401, "invalid_signature");
    }
    const delivery = deliverySchema.safeParse(safeJson(raw));
    if (!delivery.success) throw new HttpError(400, "invalid_request");
    if (!(await deps.firstDelivery(delivery.data.event_id))) {
      return Response.json({ received: true, duplicate: true });
    }
    const sessionId = delivery.data.session?.session_id;
    if (delivery.data.event === "session.completed" && sessionId) {
      after(() => processWithRetry(sessionId, postCallDeps(deps)).then(() => undefined));
    }
    return Response.json({ received: true });
  } catch (error) {
    return jsonError(error);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
