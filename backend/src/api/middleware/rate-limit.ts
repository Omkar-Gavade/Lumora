import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RateLimitError } from '../../domain/errors/index.js';
import { MemoryRateLimitStore } from '../../lib/rate-limit/memory.store.js';
import type { RateLimitStore } from '../../lib/rate-limit/store.interface.js';

/** Single process, single store (docs/04-data-and-api.md §3.4). */
const store: RateLimitStore = new MemoryRateLimitStore();

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
 * Only the auth limits from docs/04-data-and-api.md §3.4 are applied. The
 * global 300/15min ceiling is documented but not mounted — it belongs with the
 * rest of the API surface rather than with authentication.
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
