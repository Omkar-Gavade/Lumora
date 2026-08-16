import type { Request, Response } from 'express';
import type {
ChangePasswordRequest,
DeleteAccountRequest,
UpdateProfileRequest,
} from '@lumora/shared';
import type { Actor } from '../../domain/entities/user.js';
import { UnauthorizedError } from '../../domain/errors/index.js';
import { clearRefreshCookie } from '../../lib/cookies.js';
import { documentService } from '../../services/documents/document.service.js';
import { userService } from '../../services/auth/user.service.js';

/**
 * Account self-service (docs/04-data-and-api.md §2.2).
 *
 * Every handler takes its user id from `req.actor`, never from a route
 * parameter or the body. That is what makes these endpoints structurally
 * incapable of IDOR: there is no id in the request for an attacker to change.
 */
function requireActor(req: Request): Actor {
if (!req.actor) throw new UnauthorizedError();
return req.actor;
}

export async function me(req: Request, res: Response): Promise<void> {
  res.status(200).json(await userService.getProfile(requireActor(req).userId));
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateProfileRequest;
  res.status(200).json(await userService.updateProfile(requireActor(req).userId, body.displayName));
}

/**
 * 204, with the refresh cookie cleared.
 *
 * The change revokes every refresh family server-side, so the cookie in this
 * browser is already dead. Leaving it in place would send the client into a
 * refresh attempt that fails with a reuse-shaped error on the next request —
 * clearing it makes the outcome an ordinary sign-out instead of a security
 * warning about the user's own action.
 */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const body = req.body as ChangePasswordRequest;
  await userService.changePassword(
    requireActor(req).userId,
    body.currentPassword,
    body.newPassword,
  );

  clearRefreshCookie(res);
  res.status(204).send();
}

export async function deleteMe(req: Request, res: Response): Promise<void> {
  const body = req.body as DeleteAccountRequest;
  await userService.deleteAccount(requireActor(req).userId, body.password);

  clearRefreshCookie(res);
  res.status(204).send();
}

/**
 * FR-37 / the sidebar meter. Delegates to the documents service rather than
 * duplicating the aggregate — `GET /documents/usage` already serves exactly
 * this, and two implementations of one number will eventually disagree.
 */
export async function usage(req: Request, res: Response): Promise<void> {
  res.status(200).json(await documentService.usageFor(requireActor(req).userId));
}
