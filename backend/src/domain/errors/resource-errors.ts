import { AppError } from './app-error.js';

/**
 * 404 — the resource does not exist, *or* it exists and does not belong to the
 * caller. The two are deliberately indistinguishable from outside.
 *
 * Repositories scope every query by owner (docs/03-backend.md §1), so a
 * cross-tenant read returns no row and arrives here naturally. The security
 * property falls out of the query shape rather than depending on a check
 * someone has to remember to write.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Not found.', details?: unknown) {
    super('NOT_FOUND', 404, message, details ?? null);
  }
}

/**
 * 409 — the request is valid but conflicts with current state: a uniqueness
 * violation, or a write that lost a race.
 */
export class ConflictError extends AppError {
  constructor(message = 'That conflicts with something that already exists.', details?: unknown) {
    super('CONFLICT', 409, message, details ?? null);
  }
}

/**
 * 403 — within the rate limit, but over a plan allowance (storage, file count).
 *
 * Distinct from `RateLimitError` because the remedy is different and the client
 * should treat them differently: a 429 means wait, this means delete something
 * or upgrade. Sending both as 429 makes a permanent condition look transient
 * and invites an infinite retry loop.
 */
export class QuotaExceededError extends AppError {
  constructor(message = 'You have reached your plan limit.', details?: unknown) {
    super('QUOTA_EXCEEDED', 403, message, details ?? null);
  }
}
