import { AppError } from './app-error.js';

/**
 * 401 — the caller is not authenticated, or the credentials presented did not
 * verify.
 *
 * The default message says nothing about *which* half failed. "No such user"
 * versus "wrong password" is a free account-enumeration oracle, and the
 * distinction is worthless to a legitimate user who knows neither.
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.', details?: unknown, cause?: unknown) {
    super('UNAUTHORIZED', 401, message, details ?? null, cause);
  }
}

/**
 * 403 — authenticated, and not allowed.
 *
 * Reserved for cases where the caller may legitimately know the resource
 * exists. **Resource ownership failures use `NotFoundError`, not this**: a 403
 * on someone else's document id confirms the id is real, which is exactly the
 * information an IDOR probe is looking for.
 */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.', details?: unknown) {
    super('FORBIDDEN', 403, message, details ?? null);
  }
}
