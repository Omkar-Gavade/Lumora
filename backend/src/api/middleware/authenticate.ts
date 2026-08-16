import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../domain/errors/index.js';
import { userRepository } from '../../repositories/user.repository.js';
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
    .then(async (actor) => {
      /*
        `token_version` is compared against the database here, not inside
        `verifyAccessToken`.

        The split is deliberate: token verification is a cryptographic question
        and stays pure and unit-testable, while "is this session still valid"
        is a stateful one and belongs where state access already lives.

        Without this comparison the column does nothing at all. Two documented
        behaviours depended on it and were silently ineffective:
        docs/04-data-and-api.md §2.1 (`logout-all` "bumps `token_version`") and
        §3.3 (a reset must "bump `token_version` so existing access tokens die
        too"). The claim was issued, carried, and copied onto the actor — never
        checked — so a stolen access token survived every "sign out everywhere"
        and every password reset for the rest of its 15-minute life.

        The cost is one indexed primary-key lookup per authenticated request.
        That is the price of revocation actually revoking; a 15-minute TTL
        bounds the window but does not close it, and the product tells users
        their sessions were ended.
      */
      const current = await userRepository.findById(actor.userId);
      if (current?.tokenVersion !== actor.tokenVersion) {
        throw new UnauthorizedError();
      }

      req.actor = actor;
      // Every log line for this request now carries the user, without a single
      // handler having to remember to add it.
      req.log = req.log.child({ userId: actor.userId });
      next();
    })
    .catch(next);
}

/*
  `requireVerified` used to live here and is gone.

  It gated documents, search, and conversations on a confirmed email address.
  Removed because it answered a question no endpoint was asking: verification
  proves an address receives mail, and every route it guarded is already scoped
  to `req.actor.userId` in the repository layer, which is what actually keeps
  one account out of another's data. The gate's only observable effect was a
  registration flow that ended in a shell the new account could not use.

  Nothing about authentication changed with it. The access token is still
  signature-checked, expiry-checked, `typ`-checked, and — the part that matters
  most — `token_version`-checked against the stored value, so a password change
  still revokes every outstanding session. Verification remains available as a
  user action; it is simply no longer a prerequisite for using the product.
*/
