/**
 * Sliding-window rate limiter kept in process memory.
 *
 * The fallback for a deployment without Redis: each serverless instance keeps
 * its own window, which blunts a single abusive client without any shared
 * store. With Redis configured, `SharedRateLimiter` takes its place.
 */

/** What every route needs from a limiter, whichever home it has. */
export interface RequestLimiter {
  allow(key: string): boolean | Promise<boolean>;
  reset(): void;
}

/** How many allowed hits go by between sweeps of idle keys. */
const PRUNE_EVERY = 100;
/** Addresses tracked at once; a flood of fresh addresses evicts the oldest rather than growing memory. */
const MAX_KEYS = 10_000;

export class RateLimiter implements RequestLimiter {
  private readonly hits = new Map<string, number[]>();
  private sinceLastPrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = MAX_KEYS,
  ) {}

  /** Record a hit and report whether the caller is still within the limit. */
  allow(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.makeRoom(key, cutoff);
    this.hits.set(key, recent);
    this.prune(cutoff);
    return true;
  }

  /** Before a new key goes in at the cap, sweep idle keys; if none were idle, drop the oldest. */
  private makeRoom(key: string, cutoff: number): void {
    if (this.hits.has(key) || this.hits.size < this.maxKeys) return;
    this.sweep(cutoff);
    if (this.hits.size < this.maxKeys) return;
    for (const oldest of this.hits.keys()) {
      this.hits.delete(oldest);
      break;
    }
  }

  /** How many addresses are being tracked right now. */
  get size(): number {
    return this.hits.size;
  }

  /** Forget every hit. Tests use it between cases; production never needs it. */
  reset(): void {
    this.hits.clear();
  }

  /** Drop keys with no live hits, every so often, so a flood does not pay for a full sweep per request. */
  private prune(cutoff: number): void {
    this.sinceLastPrune += 1;
    if (this.sinceLastPrune < PRUNE_EVERY) return;
    this.sinceLastPrune = 0;
    this.sweep(cutoff);
  }

  private sweep(cutoff: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= cutoff)) this.hits.delete(key);
    }
  }
}

/** Browser calls a visitor may start: five in ten minutes is plenty for a person, too few to burn credits. */
export const CALL_START_LIMIT = { limit: 5, windowMs: 10 * 60_000 } as const;
/** A caller polls for their own chart while it is being worked out; generous, but not unbounded. */
export const RESULT_CHECK_LIMIT = { limit: 60, windowMs: 10 * 60_000 } as const;
/** A whole intake runs well inside this; a script trying to take a clinic's diary does not. */
export const TOOL_CALL_LIMIT = { limit: 80, windowMs: 10 * 60_000 } as const;
/** Guessing a desk code should be pointless, and slow. */
export const DESK_SIGN_IN_LIMIT = { limit: 5, windowMs: 10 * 60_000 } as const;
/** A page claims its own call once and erases it at most once; more than this is someone trying ids. */
export const SESSION_ACT_LIMIT = { limit: 10, windowMs: 10 * 60_000 } as const;
/**
 * Every call this deployment will start in a day, across everyone.
 *
 * The per-address limits above blunt one abusive client, and addresses are
 * cheap, so on their own they put no ceiling on what a public demo can spend:
 * each call it starts costs platform minutes and a second transcription. This
 * is the ceiling. It is deliberately far above what a day of people trying the
 * demo looks like and far below a bill worth minding, and when it is reached
 * the line says so plainly rather than failing in a way nobody can read.
 */
export const DAILY_CALL_CEILING = { limit: 250, windowMs: 24 * 60 * 60_000 } as const;
/** One key, because the point of the ceiling is that everyone shares it. */
export const EVERYONE = "everyone";
