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
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_PATTERN,
  SHUTDOWN_TIMEOUT_MS,
  READINESS_TIMEOUT_MS,
} from './constants.js';
