import type { ApiErrorResponse } from '@lumora/shared';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  AppError,
  BadRequestError,
  PayloadTooLargeError,
  RateLimitError,
  ValidationError,
  isAppError,
} from '../../domain/errors/index.js';
import { logger, type Logger } from '../../lib/logger.js';

/*
  The terminal error handler (docs/03-backend.md §4).

  The rule the whole design rests on: an `AppError` is a decision, anything
  else is a bug. Decisions keep their status, code, and message. Bugs get
  500 / `INTERNAL_ERROR` / a fixed generic sentence, and their real content
  goes to the log against the request id. Nothing has to be sanitized at the
  throw site, because nothing unsanitized can get out of here.

  A plain block comment rather than JSDoc: this describes the module, and a
  doc comment here would bind to whichever declaration happens to follow it.
*/

/**
 * The shape `body-parser` throws. It sets `type` to a stable identifier and
 * `expose: true` to mark the message as safe for the client — the message is
 * still not forwarded, because it can echo a fragment of the offending body.
 */
interface BodyParserError {
  type: string;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  if (!(error instanceof Error)) return false;
  const { type } = error as { type?: unknown };
  // `entity.*` covers parse, size, and encoding failures; `request.aborted` is
  // a client hang-up mid-body. Both are the caller's side of the exchange.
  return typeof type === 'string' && (type.startsWith('entity.') || type.startsWith('request.'));
}

/**
 * Maps a body-parser failure to the right status.
 *
 * These are thrown by `express.json()` *before* any route or Zod schema runs,
 * so the documented "anything unrecognized → 500" rule catches them by
 * default — and reports the client's malformed JSON as our internal failure.
 * That is wrong twice over: it misattributes the fault, and it logs a 5xx with
 * a stack for every bad request, which buries the 5xxs that are real.
 */
function fromBodyParserError(error: BodyParserError): AppError {
  switch (error.type) {
    case 'entity.too.large':
      return new PayloadTooLargeError();
    case 'entity.parse.failed':
      return new BadRequestError('The request body is not valid JSON.', null, error);
    case 'encoding.unsupported':
      return new BadRequestError('Unsupported content encoding.', null, error);
    case 'request.aborted':
      return new BadRequestError('The request was aborted before it finished.', null, error);
    default:
      return new BadRequestError('The request could not be read.', null, error);
  }
}

function normalize(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (isBodyParserError(error)) return fromBodyParserError(error);

  /*
    A Zod failure that reached here was thrown by a service parsing something
    mid-flow, not by the `validate` middleware (which raises ValidationError
    itself). Converting it here means both paths produce the identical body —
    a client should never have to handle two shapes of validation error from
    one API.
  */
  if (error instanceof z.ZodError) return ValidationError.fromZodError(error);

  // A bug. The message is discarded on purpose; `cause` carries the original
  // into the log.
  return new AppError(
    'INTERNAL_ERROR',
    500,
    'Something went wrong. Please try again.',
    null,
    error,
  );
}

/**
 * Reads the request context defensively.
 *
 * `requestContext` runs early, but *not* first — helmet and CORS precede it,
 * and CORS rejects a disallowed origin by calling `next(error)`. That error
 * arrives here on a request that never got a logger or an id, and a terminal
 * handler that dereferences `req.log` throws inside the error path: Express
 * then falls back to its own handler and returns an HTML page containing the
 * stack trace. The last line of defense must not be able to fail.
 *
 * The cast is deliberate. `express.d.ts` declares these as always present,
 * which is true for every handler downstream of `requestContext` and is the
 * right type for them; it is only untrue here, in the one place that can be
 * reached from outside the chain.
 */
function contextOf(req: Request): { log: Logger; requestId: string } {
  const partial = req as Partial<Pick<Request, 'log' | 'requestId'>>;
  return {
    log: partial.log ?? logger,
    requestId: partial.requestId ?? 'unavailable',
  };
}

/**
 * `_next` is unused and must stay. Express identifies error middleware by
 * arity: a three-parameter function is an ordinary handler, so deleting the
 * fourth parameter does not cause an error — it silently stops this from ever
 * running, and every failure becomes Express' default HTML 500.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appError = normalize(error);
  const { log, requestId } = contextOf(req);

  /*
    A response already on the wire cannot be replaced with an error body —
    headers are sent, and possibly a partial payload. Destroying the socket is
    the only honest signal left; it surfaces to the client as a broken
    response rather than as a truncated one that parses. This becomes load
    bearing in M5, where SSE streams fail mid-flight.
  */
  if (res.headersSent) {
    log.error({ err: error, code: appError.code }, 'Error after response started');
    req.destroy();
    return;
  }

  /*
    5xx means we broke; 4xx means the caller did. Only the first deserves a
    stack and a `cause` in the log — logging a full stack for every 404 buries
    the failures that matter under the ones that do not.
  */
  if (appError.httpStatus >= 500) {
    log.error(
      {
        err: appError.cause ?? appError,
        code: appError.code,
        status: appError.httpStatus,
        stack: appError.stack,
      },
      'Unhandled failure',
    );
  } else {
    log.warn(
      { code: appError.code, status: appError.httpStatus, message: appError.message },
      'Request rejected',
    );
  }

  // A 429 without Retry-After tells a client it is too fast but not by how
  // much, so it guesses — usually immediately, usually wrong.
  if (appError instanceof RateLimitError) {
    res.setHeader('Retry-After', String(appError.retryAfterSeconds));
  }

  const body: ApiErrorResponse = {
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details ?? null,
      requestId,
    },
  };

  res.status(appError.httpStatus).json(body);
}
