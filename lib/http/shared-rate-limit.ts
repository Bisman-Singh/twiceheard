import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import type { RequestLimiter } from "@/lib/http/rate-limit";

/**
 * The rate limit every instance shares.
 *
 * A serverless deployment runs many instances, and a per-instance window lets
 * a client spend the limit once per instance. With Redis configured the
 * sliding window lives there instead, so the limit means the same thing from
 * every region. Keys are client addresses, never anything from a document.
 */

/** The one call the limiter needs; kept small so tests can fake it. */
export interface LimitClient {
  limit(identifier: string): Promise<{ success: boolean }>;
}

export class SharedRateLimiter implements RequestLimiter {
  constructor(private readonly client: LimitClient) {}

  /** A shared store that cannot be reached lets the request through: availability over strictness. */
  async allow(key: string): Promise<boolean> {
    try {
      return (await this.client.limit(key)).success;
    } catch (error) {
      console.warn("shared rate limit unavailable, allowing request", { error: String(error) });
      return true;
    }
  }

  /** Nothing is held locally; the window expires on its own in Redis. */
  reset(): void {}
}

export function createSharedRateLimiter(
  redis: Redis,
  limit: number,
  windowMs: number,
): SharedRateLimiter {
  return new SharedRateLimiter(
    new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${Math.round(windowMs / 1000)} s`),
      prefix: "clausesaathi:ratelimit",
      analytics: false,
    }),
  );
}
