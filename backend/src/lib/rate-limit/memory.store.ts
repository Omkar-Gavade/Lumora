import type { RateLimitHit, RateLimitStore } from './store.interface.js';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window counter.
 *
 * Fixed window, not sliding: a sliding log is more accurate and costs a stored
 * timestamp per request per key, which is an unbounded allocation driven
 * directly by attacker traffic. The failure mode of a fixed window — up to 2×
 * the limit across a boundary — is acceptable for limits whose purpose is to
 * make automation impractical rather than to meter precisely.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, Window>();

  constructor(sweepIntervalMs = 60_000) {
    /*
      Expired entries are never read again but would otherwise be retained
      forever — and the keys include client IPs and email addresses, so an
      attacker chooses how much memory this map holds. The sweep bounds it.

      `unref` so a periodic timer is not a reason the process stays alive
      during shutdown.
    */
    const timer = setInterval(() => {
      this.sweep();
    }, sweepIntervalMs);
    timer.unref();
  }

  hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      const window: Window = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, window);
      return Promise.resolve({ count: 1, resetAt: new Date(window.resetAt) });
    }

    existing.count += 1;
    return Promise.resolve({ count: existing.count, resetAt: new Date(existing.resetAt) });
  }

  reset(key: string): Promise<void> {
    this.windows.delete(key);
    return Promise.resolve();
  }

  /**
   * Drops every window.
   *
   * Deliberately **not** on the `RateLimitStore` interface. A shared Redis
   * store would have to implement it, and "delete every rate limit for every
   * client" is not an operation that should exist on a production interface
   * where a stray call empties the whole namespace.
   *
   * It lives on the in-memory implementation because that implementation is
   * process-local, and the test suite needs it: limits are keyed partly by IP,
   * every test connects from 127.0.0.1, and signup allows three per hour — so
   * the fourth signup test in a run would fail on a limit the third one
   * consumed.
   */
  clearAll(): void {
    this.windows.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
