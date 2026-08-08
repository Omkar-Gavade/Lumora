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

/**
 * 401 — sign-in failed.
 *
 * One error for "no such account" and "wrong password", with one message. The
 * caller learns only that the pair did not work, which is all a legitimate
 * user needs and all an attacker should get.
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Email or password is incorrect.');
  }
}

/**
 * 409 — signup hit an address that already exists.
 *
 * This *does* disclose that an address is registered, and it is the one place
 * that is accepted: signup cannot explain its own failure otherwise, and the
 * person supplying the address is asserting they own it. Every other endpoint
 * — login, forgot-password — is enumeration-safe, so this single disclosure
 * cannot be used to test a list without also creating accounts, which the
 * per-IP signup limit already caps at three an hour.
 */
export class EmailTakenError extends AppError {
  constructor() {
    super('EMAIL_TAKEN', 409, 'An account with that email already exists.');
  }
}

/**
 * 429 — too many failed sign-ins for this account.
 *
 * Deliberately raised *after* the password check rather than before: an
 * attacker who can distinguish "locked" from "wrong password" without knowing
 * the password has learned the account exists.
 */
export class AccountLockedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('ACCOUNT_LOCKED', 429, 'Too many failed attempts. Try again shortly.', {
      retryAfterSeconds,
    });
  }
}

/**
 * 401 — the access token expired.
 *
 * A distinct code from `TOKEN_INVALID` because the client's response differs:
 * expiry means refresh and retry once, invalid means sign in again. Collapsing
 * them makes the interceptor either retry forever or give up too early.
 */
export class TokenExpiredError extends AppError {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Your session has expired.');
  }
}

/** 401 — malformed, wrongly signed, or the wrong token type. */
export class TokenInvalidError extends AppError {
  constructor(cause?: unknown) {
    super('TOKEN_INVALID', 401, 'Your session is no longer valid.', null, cause);
  }
}

/**
 * 401 — a refresh token was replayed after it had been rotated away.
 *
 * The legitimate client has already rotated past this token, so whoever
 * presented it captured it. The entire family is revoked before this is thrown
 * (docs/04-data-and-api.md §3.2): an indefinite silent session becomes one
 * that dies the moment either party uses a token twice.
 */
export class TokenReusedError extends AppError {
  constructor() {
    super(
      'TOKEN_REUSED',
      401,
      'Your session was ended for security reasons. Please sign in again.',
    );
  }
}

/**
 * 403 — the action needs a verified address.
 *
 * FR-5: unverified users sign in and get the shell, and are blocked only from
 * uploading and chat. So this gates specific routes, never authentication.
 */
export class EmailNotVerifiedError extends AppError {
  constructor() {
    super('EMAIL_NOT_VERIFIED', 403, 'Verify your email address to use this feature.');
  }
}

/** 409 — resend requested for an address that is already verified. */
export class EmailAlreadyVerifiedError extends AppError {
  constructor() {
    super('EMAIL_ALREADY_VERIFIED', 409, 'That email address is already verified.');
  }
}

/**
 * 400 — a verification or reset link is expired, already used, or unknown.
 *
 * One error for all three. Distinguishing "expired" from "already used" tells
 * a holder of a stolen link which state it is in, and the remedy — request a
 * new one — is the same either way.
 */
export class InvalidVerificationTokenError extends AppError {
  constructor() {
    super(
      'INVALID_VERIFICATION_TOKEN',
      400,
      'This link is invalid or has expired. Request a new one.',
    );
  }
}

/**
 * 422 — the chosen password appears in a public breach corpus.
 *
 * Not a policy failure but a factual one: this exact string is already in the
 * wordlists every credential-stuffing tool uses, so its length and character
 * mix are irrelevant.
 */
export class PasswordBreachedError extends AppError {
  constructor() {
    super(
      'PASSWORD_BREACHED',
      422,
      'That password has appeared in a public data breach. Please choose a different one.',
    );
  }
}
