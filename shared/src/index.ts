/**
 * The single entry point of the contract package.
 *
 * Deliberately a flat re-export rather than sub-path exports: the surface is
 * small, and one import specifier means neither consumer has to know how this
 * package is laid out internally.
 */
export { ERROR_CODES, type ErrorCode } from './constants/error-codes.js';

export type { ApiErrorBody, ApiErrorResponse } from './types/api.js';

export {
  healthResponseSchema,
  readinessResponseSchema,
  dependencyCheckSchema,
  type HealthResponse,
  type ReadinessResponse,
  type DependencyCheck,
} from './schemas/health.schemas.js';
