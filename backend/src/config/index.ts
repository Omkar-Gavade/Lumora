/**
 * The configuration surface every other module imports from.
 *
 * One entry point means a call site never has to know whether a value came
 * from the environment, a manifest, or a constant — and it means the day a
 * value moves between those, nothing downstream changes.
 */
export { env, isDevelopment, isProduction, isTest, type Env } from './env.js';

export { databaseConfig } from './database.js';

export {
  APP_VERSION,
  JSON_BODY_LIMIT,
  URLENCODED_BODY_LIMIT,
  GLOBAL_RATE_LIMIT,
  GLOBAL_RATE_LIMIT_WINDOW_MS,
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_PATTERN,
  SHUTDOWN_TIMEOUT_MS,
  READINESS_TIMEOUT_MS,
  ARGON2_MEMORY_COST_KIB,
  ARGON2_TIME_COST,
  ARGON2_PARALLELISM,
  OPAQUE_TOKEN_BYTES,
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  LOGIN_FAILURES_BEFORE_LOCKOUT,
  LOGIN_LOCKOUT_BASE_MS,
  LOGIN_LOCKOUT_MAX_MS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  BREACH_CHECK_TIMEOUT_MS,
} from './constants.js';
