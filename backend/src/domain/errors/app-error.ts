import type { ErrorCode } from './error-codes.js';

/**
 * The base every deliberate failure in Lumora extends (docs/03-backend.md §4).
 *
 * The contract that makes this worth having: **if it is an `AppError`, the
 * message is safe to show a user and the status is intentional.** Anything the
 * terminal handler receives that is *not* an `AppError` is by definition a bug
 * — it gets a 500 and a generic message, and its real content goes only to the
 * log. That single distinction is what stops internal detail leaking, without
 * requiring anyone to remember to sanitize at each throw site.
 *
 * `cause` is separate from `details` for the same reason. `details` crosses the
 * wire; `cause` never does. Keeping them as distinct fields means the choice is
 * made when the error is constructed, by the person who knows which is which,
 * rather than by a serializer guessing later.
 */
export class AppError extends Error {
  /**
   * Distinguishes deliberate failures from bugs at the boundary. An
   * `instanceof` check would work in-process, but fails across realms — a
   * different copy of this module in a test harness, or a subclass rebuilt by
   * a serializer — and silently downgrades a 404 to a 500 when it does.
   */
  readonly isAppError = true as const;

  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    /** Field errors and similar. Serialized to the client. */
    readonly details?: unknown,
    /** The underlying failure. Logged, never serialized. */
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    // Without this the stack starts inside this constructor rather than at the
    // throw site, which makes every subclass's stack point at the same file.
    Error.captureStackTrace(this, new.target);
  }
}

/**
 * Narrows an unknown caught value. Structural rather than `instanceof`, for
 * the reason given on `isAppError`.
 */
export function isAppError(error: unknown): error is AppError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isAppError?: unknown }).isAppError === true
  );
}

/**
 * An explicit internal failure — something the code knows went wrong but has
 * no better classification for.
 *
 * Distinct from an unhandled throw only in that it is deliberate. The message
 * sent to the client is fixed and generic either way; the `cause` is what makes
 * it debuggable.
 */
export class InternalServerError extends AppError {
  constructor(message = 'Something went wrong. Please try again.', cause?: unknown) {
    super('INTERNAL_ERROR', 500, message, null, cause);
  }
}
