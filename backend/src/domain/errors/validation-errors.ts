import type { z } from 'zod';
import { AppError } from './app-error.js';

/**
 * 400 — the request could not be read at all: unparseable JSON, a body that
 * was aborted mid-transfer, an encoding nothing can decode.
 *
 * Separate from `ValidationError` because the distinction is real and useful to
 * a client. A 422 says "these fields are wrong" and can be rendered next to
 * inputs; a 400 says "I could not read what you sent" and has no fields to
 * point at. Collapsing the two leaves a form trying to highlight nothing.
 */
export class BadRequestError extends AppError {
  constructor(message = 'The request could not be read.', details?: unknown, cause?: unknown) {
    super('BAD_REQUEST', 400, message, details ?? null, cause);
  }
}

/**
 * 413 — the body exceeded its limit.
 *
 * Deliberately its own status rather than a generic failure: "too big" is
 * actionable — send less, or split the upload — and a client that receives a
 * 500 instead will retry the same oversized payload forever.
 */
export class PayloadTooLargeError extends AppError {
  constructor(message = 'The request body is too large.', details?: unknown) {
    super('PAYLOAD_TOO_LARGE', 413, message, details ?? null);
  }
}

/** One field's complaint, in the shape the frontend's forms consume. */
export interface FieldError {
  /** Dotted path — `email`, `items.0.name`. Empty string for a whole-body error. */
  path: string;
  message: string;
}

/**
 * 422 — the request was understood and rejected by a schema.
 *
 * 422 rather than 400: 400 is a malformed request, and a well-formed JSON body
 * that fails a business rule is not malformed. The distinction matters to a
 * client deciding whether to show field errors or to report a bug.
 *
 * `details` carries the field list, and this is the one error class whose
 * details are meant to be rendered. Every other failure's details are
 * diagnostic.
 */
export class ValidationError extends AppError {
  constructor(message = 'The submitted data is invalid.', fields: FieldError[] = []) {
    super('VALIDATION_ERROR', 422, message, fields.length > 0 ? { fields } : null);
  }

  /**
   * Builds one from a Zod failure.
   *
   * Lives here rather than in the error handler so that a service validating
   * something mid-flow produces byte-identical output to the `validate`
   * middleware. A client that has to handle two shapes of validation error
   * from the same API will handle one of them badly.
   */
  static fromZodError(error: z.ZodError, message?: string): ValidationError {
    const fields = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return new ValidationError(message ?? 'The submitted data is invalid.', fields);
  }
}
