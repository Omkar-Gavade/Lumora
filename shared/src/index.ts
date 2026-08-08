/**
 * The single entry point of the contract package.
 *
 * Deliberately a flat re-export rather than sub-path exports: the surface is
 * small, and one import specifier means neither consumer has to know how this
 * package is laid out internally.
 */
export { ERROR_CODES, type ErrorCode } from './constants/error-codes.js';

export {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  RESEND_COOLDOWN_SECONDS,
} from './constants/limits.js';

export type { ApiErrorBody, ApiErrorResponse } from './types/api.js';
export type { UserDto, AuthSessionDto } from './types/auth.js';

export {
  healthResponseSchema,
  readinessResponseSchema,
  dependencyCheckSchema,
  type HealthResponse,
  type ReadinessResponse,
  type DependencyCheck,
} from './schemas/health.schemas.js';

export {
  emailSchema,
  newPasswordSchema,
  currentPasswordSchema,
  displayNameSchema,
  opaqueTokenSchema,
  signupRequestSchema,
  loginRequestSchema,
  forgotPasswordRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
  PASSWORD_RULES,
  type PasswordRule,
  type SignupRequest,
  type LoginRequest,
  type ForgotPasswordRequest,
  type ResetPasswordRequest,
  type VerifyEmailRequest,
} from './schemas/auth.schemas.js';
