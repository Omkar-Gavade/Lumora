import { AppError } from './app-error.js';

/**
 * Failures that originate outside the domain — a limiter, or a dependency.
 *
 * docs/03-backend.md §2 names four error files; these two fit none of them, so
 * they get their own rather than being wedged into `resource-errors.ts` where
 * nobody would look for them.
 */

/**
 * 429 — too many requests.
 *
 * `retryAfterSeconds` is surfaced as a header by the terminal handler as well
 * as in the body. A 429 without `Retry-After` tells a client it is going too
 * fast but not how much to slow down, so it guesses — usually wrong, usually
 * immediately.
 */
export class RateLimitError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Too many requests. Please slow down.',
  ) {
    super('RATE_LIMITED', 429, message, { retryAfterSeconds });
  }
}

/**
 * 502 — an upstream dependency failed: the model provider, the embedding API,
 * the vector store.
 *
 * The provider's own message is passed as `cause`, never as `message`. Upstream
 * errors routinely echo request contents and internal endpoints, and forwarding
 * one verbatim hands both to whoever triggered it.
 */
export class ProviderError extends AppError {
  constructor(
    readonly provider: string,
    message = 'An upstream service failed. Please try again.',
    cause?: unknown,
  ) {
    super('PROVIDER_ERROR', 502, message, { provider }, cause);
  }
}

/**
 * 503 — a dependency this request needs is not currently available.
 *
 * Separate from `ProviderError` by who should act: a 502 means the upstream
 * misbehaved and the caller may retry, a 503 means this service knows it
 * cannot serve right now. Readiness failures are 503.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable.', details?: unknown, cause?: unknown) {
    super('SERVICE_UNAVAILABLE', 503, message, details ?? null, cause);
  }
}
