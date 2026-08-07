import type { ErrorCode } from '../constants/error-codes.js';

/**
 * The one and only failure envelope (docs/03-backend.md §4).
 *
 * Every non-2xx response from the API has this shape, whatever produced it —
 * a validation failure, a missing row, or an unhandled throw. A uniform shape
 * is what lets the frontend's API client normalize errors in one place instead
 * of sniffing each endpoint's idea of what went wrong.
 *
 * Successful responses are envelope-free (docs/04-data-and-api.md §2): the
 * resource is the body. An envelope on success costs every consumer a `.data`
 * unwrap and buys nothing, because HTTP already carries the status.
 */
export interface ApiErrorBody {
  code: ErrorCode;
  /** Safe to show a user. Never a stack trace, never a provider message. */
  message: string;
  /** Field-level detail for validation failures; `null` otherwise. */
  details: unknown;
  /** Echoes the request id, so a user-reported failure is traceable in logs. */
  requestId: string;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}
