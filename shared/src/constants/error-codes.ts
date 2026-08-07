/**
 * Machine-readable failure codes, shared verbatim by both halves of Lumora.
 *
 * The backend puts one of these in every error response; the frontend maps it
 * to human copy through `constants/messages.ts` (docs/02-frontend.md §7). The
 * backend's own `message` is never rendered directly — that is how internal
 * detail leaks into a UI — so this list, not the message text, is the contract.
 *
 * Codes are transport-agnostic and stable. Renaming one is a breaking change
 * to the frontend, which is exactly why they live here rather than in either
 * application.
 *
 * Only the codes the current milestone can actually produce are listed.
 * Domain codes (`TOKEN_EXPIRED`, `DOCUMENT_NOT_FOUND`, `NO_TEXT_LAYER`, …)
 * arrive with the milestone that raises them.
 */
export const ERROR_CODES = {
  /**
   * The request itself is malformed — unparseable JSON, a truncated body.
   * Distinct from `VALIDATION_ERROR`: this one never had fields to report on.
   */
  BAD_REQUEST: 'BAD_REQUEST',
  /** Request body, query, or params failed schema validation. 422. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Body exceeded the configured limit. 413. */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** No credentials, or credentials that did not verify. 401. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Authenticated, but not permitted to do this. 403. */
  FORBIDDEN: 'FORBIDDEN',
  /** Target does not exist, or does not belong to the caller. 404. */
  NOT_FOUND: 'NOT_FOUND',
  /** State conflict — a uniqueness violation or a concurrent modification. 409. */
  CONFLICT: 'CONFLICT',
  /** Caller exceeded a rate limit. 429. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Caller is within their rate limit but over a plan quota. 403. */
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  /** An upstream dependency failed. 502. */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** Unhandled failure. Never carries detail across the wire. 500. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** A dependency the request needs is not ready. 503. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
