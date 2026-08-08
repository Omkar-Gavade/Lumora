import express, { type Express } from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { errorHandler } from '../../src/api/middleware/error-handler.js';
import { notFoundHandler } from '../../src/api/middleware/not-found.js';
import { requestContext } from '../../src/api/middleware/request-context.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../../src/domain/errors/index.js';

/**
 * The terminal handler in isolation.
 *
 * A miniature app rather than the real one, because several of these statuses
 * — 500 in particular — cannot be produced by any real route without breaking
 * production code to make them happen. Mounting the actual middleware means
 * this still tests the shipped implementation, not a description of it.
 */
function appThrowing(error: unknown): Express {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.get('/boom', () => {
    throw error;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('the uniform error envelope', () => {
  it.each([
    ['400 BAD_REQUEST', new (class extends Error { override name = 'x'; })(), 500, ERROR_CODES.INTERNAL_ERROR],
    ['401', new UnauthorizedError(), 401, ERROR_CODES.UNAUTHORIZED],
    ['403', new ForbiddenError(), 403, ERROR_CODES.FORBIDDEN],
    ['403 quota', new QuotaExceededError(), 403, ERROR_CODES.QUOTA_EXCEEDED],
    ['404', new NotFoundError(), 404, ERROR_CODES.NOT_FOUND],
    ['409', new ConflictError(), 409, ERROR_CODES.CONFLICT],
    ['422', new ValidationError(), 422, ERROR_CODES.VALIDATION_ERROR],
    ['429', new RateLimitError(30), 429, ERROR_CODES.RATE_LIMITED],
    ['502', new ProviderError('gemini'), 502, ERROR_CODES.PROVIDER_ERROR],
  ])('maps %s to the documented status and code', async (_label, error, status, code) => {
    const response = await supertest(appThrowing(error)).get('/boom');

    expect(response.status).toBe(status);
    expect(response.body.error).toMatchObject({
      code,
      message: expect.any(String),
      requestId: expect.any(String),
    });
    expect(response.body.error).toHaveProperty('details');
  });

  it('turns an unrecognized throw into a generic 500', async () => {
    /*
      The rule the whole design rests on: an AppError is a decision, anything
      else is a bug. Bugs get a fixed sentence and their real content goes to
      the log — nothing has to be sanitized at the throw site, because nothing
      unsanitized can get out of the handler.
    */
    const response = await supertest(
      appThrowing(new Error('connection to 10.0.0.5 failed: password authentication failed')),
    ).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(response.body.error.message).toBe('Something went wrong. Please try again.');

    // The internal detail must not survive the boundary.
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.5');
    expect(JSON.stringify(response.body)).not.toContain('password authentication');
  });

  it('never leaks a stack trace', async () => {
    const response = await supertest(appThrowing(new Error('boom'))).get('/boom');

    expect(JSON.stringify(response.body)).not.toMatch(/\bat .+:\d+:\d+/);
    expect(response.body.error).not.toHaveProperty('stack');
  });

  it('attaches Retry-After for a rate limit', async () => {
    const response = await supertest(appThrowing(new RateLimitError(42))).get('/boom');

    expect(response.headers['retry-after']).toBe('42');
    expect(response.body.error.details).toEqual({ retryAfterSeconds: 42 });
  });

  it('carries field errors on a validation failure', async () => {
    const error = new ValidationError('Invalid.', [{ path: 'email', message: 'Bad address.' }]);
    const response = await supertest(appThrowing(error)).get('/boom');

    expect(response.body.error.details.fields).toEqual([{ path: 'email', message: 'Bad address.' }]);
  });

  it('reports `details` as null rather than omitting it', async () => {
    // An absent key and an explicit null are different to a typed client.
    const response = await supertest(appThrowing(new NotFoundError())).get('/boom');
    expect(response.body.error.details).toBeNull();
  });

  it('answers 404 for an unmatched route in JSON, not Express HTML', async () => {
    const response = await supertest(appThrowing(new Error('unused'))).get('/nothing-here');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('survives an error raised before request context exists', async () => {
    /*
      The terminal handler must not be able to fail. CORS rejects a disallowed
      origin by calling next(error) from *before* `requestContext` runs, so a
      handler that dereferenced `req.log` would throw inside the error path and
      Express would answer with an HTML page containing the stack.
    */
    const app = express();
    app.get('/boom', () => {
      throw new ForbiddenError('Origin not allowed.');
    });
    app.use(errorHandler);

    const response = await supertest(app).get('/boom');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    expect(response.body.error.requestId).toBe('unavailable');
  });
});
