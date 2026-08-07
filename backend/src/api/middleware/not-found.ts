import type { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../../domain/errors/index.js';

/**
 * Catches unmatched paths — step 8, immediately before the terminal handler
 * (docs/03-backend.md §3).
 *
 * Delegates to `next()` rather than writing a response, so an unknown route
 * produces the *same* error envelope as every other failure. Express' built-in
 * 404 sends an HTML page, which means a client that always parses JSON breaks
 * on a typo'd URL — and reports it as a parse error rather than as a 404.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Cannot ${req.method} ${req.path}`));
}
