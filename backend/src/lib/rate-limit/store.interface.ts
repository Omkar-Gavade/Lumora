export interface RateLimitHit {
  /** Requests recorded in the current window, including this one. */
  count: number;
  /** When the current window ends. */
  resetAt: Date;
}

/**
 * Counting, behind an interface (docs/04-data-and-api.md §3.4: "the limiter is
 * written behind an interface so a shared store slots in when there is more
 * than one process").
 *
 * Phase 1 is explicitly single-node, and an in-memory counter is correct for
 * that. The moment there are two processes it is not — each keeps its own
 * tally, so a 5-per-15-minutes limit silently becomes 10. Naming the seam now
 * is what keeps that from being discovered in production.
 */
export interface RateLimitStore {
  /** Records one request against `key` and returns the resulting state. */
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
  /** Clears a key — used to forgive a successful sign-in. */
  reset(key: string): Promise<void>;
}
