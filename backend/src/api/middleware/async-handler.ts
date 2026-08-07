import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** A handler that may return a promise. */
type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void> | void;

/**
 * Routes a rejected promise into the terminal error handler
 * (docs/03-backend.md §4).
 *
 * Express 5 does forward rejections from async handlers on its own, so this is
 * not strictly load-bearing there. It stays for two reasons: it is the seam
 * that keeps the behavior explicit at every route rather than dependent on a
 * framework version, and it makes the handler's promise *typed* — without it,
 * `no-misused-promises` has to be disabled at every `router.get`, and turning
 * that rule off is how a genuinely floating promise gets in.
 */
export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
