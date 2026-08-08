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
 * Domain codes for documents and chat arrive with the milestone that raises
 * them.
 */
export const ERROR_CODES = {
  // ── Generic ────────────────────────────────────────────────────────────────
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

  // ── Authentication ─────────────────────────────────────────────────────────
  /**
   * Wrong email, wrong password, or no such account — deliberately one code.
   * Splitting it into "no such user" and "bad password" hands an attacker a
   * free account-enumeration oracle and tells a legitimate user nothing they
   * can act on (docs/04-data-and-api.md §3.3).
   */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /**
   * Signup hit an existing address. Returned only from signup, where the
   * address was supplied by someone who is asserting they own it — the leak is
   * unavoidable if the product is to explain why signup failed at all.
   */
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /** Too many failed sign-ins; the account is temporarily locked. */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  /** The access token is expired. The client should refresh, then retry once. */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** The token is malformed, wrongly signed, or of the wrong type. */
  TOKEN_INVALID: 'TOKEN_INVALID',
  /**
   * A refresh token was presented that had already been rotated away. The
   * family is revoked and the client must sign in again
   * (docs/04-data-and-api.md §3.2).
   */
  TOKEN_REUSED: 'TOKEN_REUSED',
  /** The action requires a verified email address (FR-5). */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  /** The email address is already verified — resending would be pointless. */
  EMAIL_ALREADY_VERIFIED: 'EMAIL_ALREADY_VERIFIED',
  /** A verification or reset link is expired, consumed, or unrecognized. */
  INVALID_VERIFICATION_TOKEN: 'INVALID_VERIFICATION_TOKEN',
  /** The chosen password appears in a public breach corpus. */
  PASSWORD_BREACHED: 'PASSWORD_BREACHED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
