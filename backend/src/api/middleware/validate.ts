import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../../domain/errors/index.js';

interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Zod validation for a route, and **replacement** of the validated input
 * (docs/03-backend.md §3).
 *
 * Replacement is the point, not a detail. Parsed output has unknown keys
 * stripped and values coerced, so a downstream service cannot accidentally
 * read a field the schema never approved — the classic mass-assignment bug,
 * where a client sends `{ email, password, tokenVersion: 99 }` and something
 * later spreads the whole body into an update.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }

      if (schemas.query) {
        /*
          Express 5 exposes `query` as a getter on the prototype, so a plain
          assignment throws. Defining an own property on the instance shadows
          it — which is the supported way to hand a handler parsed values
          rather than the raw parsed-querystring object.
        */
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }

      if (schemas.params) {
        Object.defineProperty(req, 'params', {
          value: schemas.params.parse(req.params),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }

      next();
    } catch (error) {
      /*
        Converted here rather than left for the terminal handler.

        The handler *can* convert a ZodError, and does — but doing it at the
        source means the field paths are attached while the schema that
        produced them is still in scope, and it keeps validation failures from
        being indistinguishable from a service that happened to throw one
        mid-flow.
      */
      next(error instanceof Error && error.name === 'ZodError' ? toValidationError(error) : error);
    }
  };
}

function toValidationError(error: Error): ValidationError {
  // `ZodError` is structurally identified: instanceof breaks when two copies of
  // zod are resolved, which npm workspaces make entirely possible.
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues ?? [];

  return new ValidationError(
    'The submitted data is invalid.',
    issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  );
}
