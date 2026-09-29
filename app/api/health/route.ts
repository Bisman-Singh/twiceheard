import { serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";
/** A readiness answer is only worth reading if it was produced by this request. */
export const dynamic = "force-dynamic";

/**
 * What a readiness check may say to someone who has not identified themselves.
 *
 * Every field is a fact about this instance's own shape, not about its
 * configuration. No variable name, no value, no host, no URL and no identifier
 * appears here, so the answer is the same whether the reader is the platform's
 * health probe or a stranger.
 */
interface Health {
  /** Whether this instance can serve a call at all. */
  status: "ok" | "degraded";
  /** Whether the environment parsed and the server dependencies were built. */
  environment: "loaded" | "unreadable";
  /** Whether a live intake survives the next instance, or dies with this one. */
  stores: "shared" | "in-process" | "unknown";
  /** Makes a stale copy obvious if something along the way ignores no-store. */
  time: string;
}

function answer(body: Health, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * GET /api/health
 *
 * Open on purpose: a probe that needs a credential is one more thing to rotate,
 * and everything below is already visible from the outside to anyone who sends
 * a few requests.
 *
 * It touches no network. An unauthenticated endpoint that reaches Redis or the
 * voice platform on demand is a free amplifier, and neither answer would change
 * what this instance can do about it. It reports readiness, not the health of
 * everything downstream.
 */
export function GET(): Response {
  try {
    const deps = serverDeps();
    return answer(
      {
        status: "ok",
        environment: "loaded",
        stores: deps.env.redis ? "shared" : "in-process",
        time: deps.now().toISOString(),
      },
      200,
    );
  } catch {
    // The reason is deliberately not logged with the error: an environment
    // failure names the variables it is unhappy about, and any other failure
    // can drag a value along with it. The line below is enough to find it.
    console.error("health check could not read the environment");
    return answer(
      { status: "degraded", environment: "unreadable", stores: "unknown", time: now() },
      503,
    );
  }
}

/** The clock lives on the dependencies, which is exactly what failed here. */
function now(): string {
  return new Date().toISOString();
}
