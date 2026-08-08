import type { NextFunction, Request, Response } from 'express';
import { EmailNotVerifiedError, UnauthorizedError } from '../../domain/errors/index.js';
import { tokenService } from '../../services/auth/token.service.js';

/**
 * Extracts a bearer token. Returns `null` rather than throwing, so the caller
 * decides whether absence is an error — `authenticate` says yes, an optional
 * variant later may not.
 */
function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;

  // Case-insensitive scheme per RFC 7235, exactly one space.
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * Verifies the access token and attaches `req.actor`.
 *
 * **Performs no database query**, which is the entire reason the access token
 * is a JWT (docs/03-backend.md §3). Everything the request needs — user id,
 * email, verification state, token version — is signed into the token, so the
 * hot path of every authenticated endpoint costs one HMAC verification and no
 * round trip.
 *
 * The `Authorization` header, not a cookie, is what carries it. That is what
 * makes the API CSRF-proof by construction: a cross-origin page cannot set a
 * custom header without the server's CORS approval, whereas a cookie would be
 * attached automatically (docs/04-data-and-api.md §3.1).
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (!token) {
    next(new UnauthorizedError());
    return;
  }

  tokenService
    .verifyAccessToken(token)
    .then((actor) => {
      req.actor = actor;
      // Every log line for this request now carries the user, without a single
      // handler having to remember to add it.
      req.log = req.log.child({ userId: actor.userId });
      next();
    })
    .catch(next);
}

/**
 * Gates an endpoint on a verified email address (FR-5).
 *
 * Separate from `authenticate` rather than a flag on it, because they answer
 * different questions and compose independently — settings needs the first and
 * not the second, uploads need both (docs/02-frontend.md §4).
 *
 * Reads the claim, not the database. The claim is refreshed whenever tokens
 * are reissued, and verification reissues them immediately, so the gate lifts
 * the moment the link is clicked rather than at the next token expiry.
 */
export function requireVerified(req: Request, _res: Response, next: NextFunction): void {
  if (!req.actor) {
    // A programming error: this middleware was mounted without `authenticate`
    // ahead of it. Surfacing it as 401 rather than crashing keeps a
    // misconfigured route closed rather than open.
    next(new UnauthorizedError());
    return;
  }

  if (!req.actor.emailVerified) {
    next(new EmailNotVerifiedError());
    return;
  }

  next();
}
