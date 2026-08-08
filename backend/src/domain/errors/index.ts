/**
 * Every deliberate failure the application can raise, from one import.
 *
 * Services throw from this module and nothing else — the terminal handler's
 * guarantee (docs/03-backend.md §4) is that anything reaching it which is *not*
 * one of these is a bug and gets a generic 500.
 */
export { AppError, InternalServerError, isAppError } from './app-error.js';
export { ERROR_CODES, type ErrorCode } from './error-codes.js';

export {
  UnauthorizedError,
  ForbiddenError,
  InvalidCredentialsError,
  EmailTakenError,
  AccountLockedError,
  TokenExpiredError,
  TokenInvalidError,
  TokenReusedError,
  EmailNotVerifiedError,
  EmailAlreadyVerifiedError,
  InvalidVerificationTokenError,
  PasswordBreachedError,
} from './auth-errors.js';
export { NotFoundError, ConflictError, QuotaExceededError } from './resource-errors.js';
export {
  BadRequestError,
  PayloadTooLargeError,
  ValidationError,
  type FieldError,
} from './validation-errors.js';
export { RateLimitError, ProviderError, ServiceUnavailableError } from './system-errors.js';
