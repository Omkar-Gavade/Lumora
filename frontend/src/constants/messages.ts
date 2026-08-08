import { ERROR_CODES, type ErrorCode } from '@lumora/shared';
import { ApiError } from '@/lib/api/errors';

/**
 * Backend error code → user-facing copy (docs/02-frontend.md §7).
 *
 * **The backend's own `message` is never rendered directly.** It is written for
 * an engineer reading a log, it is not translated, and rendering it is how
 * internal phrasing leaks into a product's voice. The code is the contract; the
 * words are the frontend's.
 */
const MESSAGES: Partial<Record<ErrorCode, string>> = {
  [ERROR_CODES.INVALID_CREDENTIALS]: 'Email or password is incorrect.',
  [ERROR_CODES.EMAIL_TAKEN]: 'An account with that email already exists.',
  [ERROR_CODES.ACCOUNT_LOCKED]:
    'Too many failed attempts. Please wait a moment before trying again.',
  [ERROR_CODES.RATE_LIMITED]: 'Too many attempts. Please wait a moment and try again.',
  [ERROR_CODES.PASSWORD_BREACHED]:
    'That password has appeared in a public data breach. Please choose a different one.',
  [ERROR_CODES.INVALID_VERIFICATION_TOKEN]:
    'This link is invalid or has expired. Request a new one.',
  [ERROR_CODES.EMAIL_ALREADY_VERIFIED]: 'That email address is already verified.',
  [ERROR_CODES.EMAIL_NOT_VERIFIED]: 'Verify your email address to use this feature.',
  [ERROR_CODES.TOKEN_REUSED]:
    'Your session was ended for security reasons. Please sign in again.',
  [ERROR_CODES.TOKEN_EXPIRED]: 'Your session has expired. Please sign in again.',
  [ERROR_CODES.TOKEN_INVALID]: 'Your session is no longer valid. Please sign in again.',
  [ERROR_CODES.VALIDATION_ERROR]: 'Please check the highlighted fields and try again.',
  [ERROR_CODES.SERVICE_UNAVAILABLE]:
    'Could not reach the server. Check your connection and try again.',
};

const FALLBACK = 'Something went wrong. Please try again.';

/**
 * The single translation point for any thrown value.
 *
 * Takes `unknown` rather than `ApiError` on purpose: a `catch` block receives
 * whatever was thrown, and forcing every call site to narrow first is how one
 * of them ends up rendering `[object Object]`.
 */
export function messageForError(error: unknown): string {
  if (!(error instanceof ApiError)) return FALLBACK;
  return MESSAGES[error.code] ?? FALLBACK;
}
