import { after } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readCapped } from "@/lib/http/guard";
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
    const raw = await readCapped(request, MAX_BODY_BYTES);
    const deps = serverDeps();
    if (
      !validWebhookSignature(raw, request.headers.get("x-aai-signature"), deps.env.webhookSecret)
    ) {
      throw new HttpError(401, "invalid_signature");
    }
    const delivery = deliverySchema.safeParse(safeJson(raw));
    if (!delivery.success) throw new HttpError(400, "invalid_request");
    const fresh = await deps.firstDelivery(delivery.data.event_id);
    const sessionId = delivery.data.session?.session_id;
    if (delivery.data.event === "session.completed" && sessionId) {
      after(async () => {
        // A repeat delivery is skipped only once the call really is charted. The platform
        // retries a delivery whose processing failed, and that retry is the only thing
        // standing between a failed call and a chart the clinic never sees.
        if (fresh || !(await deps.calls.get(sessionId))) {
          await processWithRetry(sessionId, postCallDeps(deps));
        }
      });
    }
    return Response.json({ received: true, ...(fresh ? {} : { duplicate: true }) });
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
