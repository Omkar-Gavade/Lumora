import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RateLimitError } from '../../domain/errors/index.js';
import { MemoryRateLimitStore } from '../../lib/rate-limit/memory.store.js';
import type { RateLimitStore } from '../../lib/rate-limit/store.interface.js';

/** Single process, single store (docs/04-data-and-api.md §3.4). */
const memoryStore = new MemoryRateLimitStore();
const store: RateLimitStore = memoryStore;

/**
 * Clears every counter. **Test seam — nothing in the application calls this.**
 *
 * The limiters are keyed partly by client IP and the whole suite connects from
 * 127.0.0.1, so without a reset the fourth signup test in a run fails on a
 * limit the third one consumed — a test failing because of another test is the
 * definition of a flaky suite.
 *
 * Exported here rather than added to `RateLimitStore` on purpose: a shared
 * store would then have to implement "delete every limit for every client",
 * which is not an operation that belongs on a production interface.
 */
export function resetRateLimitsForTests(): void {
  memoryStore.clearAll();
}

export interface RateLimitOptions {
  /** Namespace, so two limiters never collide on the same client key. */
  name: string;
  limit: number;
  windowMs: number;
  /**
   * Derives the client key. Returning `null` skips the limiter entirely —
   * used when the key's input is absent, e.g. a login body with no email.
   */
  keyOf: (req: Request) => string | null;
}

/**
 * Per-route limiter factory (docs/03-backend.md §2).
 *
 * Every limit in docs/04-data-and-api.md §3.4 is applied: the per-route auth,
 * upload, and chat limits at their routers, and the global ceiling in `app.ts`.
 *
 * When both apply to one request the global limiter runs first and the route
 * limiter overwrites its `RateLimit-*` headers. That precedence is deliberate —
 * the stricter budget is the one the client will actually hit, so it is the one
 * worth advertising.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = options.keyOf(req);
    if (key === null) {
      next();
      return;
    }

    store
      .hit(`${options.name}:${key}`, options.windowMs)
      .then((hit) => {
        const remaining = Math.max(0, options.limit - hit.count);

        /*
          Standard headers on every response, not only on rejections. A client
          that can see it has one request left can back off before it is
          refused; one that only learns at the 429 has already failed the
          request it cared about.
        */
        res.setHeader('RateLimit-Limit', String(options.limit));
        res.setHeader('RateLimit-Remaining', String(remaining));
        res.setHeader(
          'RateLimit-Reset',
          String(Math.ceil((hit.resetAt.getTime() - Date.now()) / 1000)),
        );

        if (hit.count > options.limit) {
          const retryAfter = Math.max(1, Math.ceil((hit.resetAt.getTime() - Date.now()) / 1000));
          req.log.warn({ limiter: options.name, key }, 'Rate limit exceeded');
          next(new RateLimitError(retryAfter));
          return;
        }

        next();
      })
      .catch(next);
  };
}

/** Forgives a key after a successful action — a correct sign-in should not
 *  leave its failed attempts counting against the next one. */
export function resetRateLimit(name: string, key: string): Promise<void> {
  return store.reset(`${name}:${key}`);
}

/**
 * `req.ip` respects `trust proxy`, which `app.ts` pins to one hop. Trusting the
 * whole `X-Forwarded-For` chain instead would let a client prepend any address
 * and rotate past every per-IP limit here.
 */
export function ipKey(req: Request): string {
  return req.ip ?? 'unknown';
}

/**
 * `ipKey`, except health probes are exempt.
 *
 * A load balancer polling `/health` every second spends the entire 300/15min
 * budget in five minutes. The budget is per IP, so the casualty is not the
 * probe — it is every real user sharing that egress address, refused by a limit
 * they never approached. Returning `null` uses the documented skip contract
 * rather than a second mechanism.
 */
export function ipKeyExceptHealth(req: Request): string | null {
  return req.path.startsWith('/health') ? null : ipKey(req);
}

/**
 * Keys a limiter by IP *and* email.
 *
 * The pairing is what makes the login limit useful in both directions: per-IP
 * alone lets a botnet spread guesses across addresses, and per-email alone
 * lets one attacker lock out an arbitrary user by failing their sign-in five
 * times. Read from the raw body because limiters run before validation.
 */
export function ipEmailKey(req: Request): string | null {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null) return null;

  const email = (body as { email?: unknown }).email;
  if (typeof email !== 'string' || email.length === 0) return null;

  return `${ipKey(req)}|${email.trim().toLowerCase()}`;
}

/** Keys by email only — for limits meant to protect an address, not a client. */
export function emailKey(req: Request): string | null {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null) return null;

  const email = (body as { email?: unknown }).email;
  if (typeof email !== 'string' || email.length === 0) return null;

  return email.trim().toLowerCase();
}
