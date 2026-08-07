/**
 * Error codes are defined in the shared contract package, not here.
 *
 * docs/03-backend.md §2 lists `error-codes.ts` under `domain/errors/` and notes
 * it is "shared with frontend". Two copies of a list that must match is the
 * bug that list exists to prevent, so the canonical definition lives in
 * `@lumora/shared` and this module re-exports it — the documented import path
 * still resolves, and there is exactly one place to add a code.
 */
export { ERROR_CODES, type ErrorCode } from '@lumora/shared';
