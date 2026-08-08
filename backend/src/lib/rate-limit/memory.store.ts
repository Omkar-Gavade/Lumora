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

  private sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
