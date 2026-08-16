import { Router } from 'express';
import {
  changePasswordRequestSchema,
  deleteAccountRequestSchema,
  updateProfileRequestSchema,
} from '@lumora/shared';
import * as userController from '../controllers/user.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { authenticate } from '../middleware/authenticate.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validate } from '../middleware/validate.js';

const HOUR = 60 * 60 * 1000;

export const userRouter = Router();

/**
 * Account self-service (docs/04-data-and-api.md §2.2).
 *
 * `authenticate` is applied to the whole router rather than per route. A
 * per-route guard is one forgotten line away from a public account endpoint,
 * and every path here operates on the caller's own account without exception —
 * so the safe default belongs at the mount point.
 *
 * Deliberately **not** behind `requireVerified`. docs/02-frontend.md §215:
 * "`VerifiedRoute` sits inside `AppLayout` so an unverified user still gets the
 * app shell and settings — they can change their password and sign out."
 * Locking these behind verification would strand a user who mistyped their
 * address with no way to secure or remove the account.
 */
userRouter.use(authenticate);

userRouter.get('/me', asyncHandler(userController.me));

userRouter.patch(
  '/me',
  validate({ body: updateProfileRequestSchema }),
  asyncHandler(userController.updateMe),
);

/**
 * Rate-limited per user, not per IP.
 *
 * Both of these verify a password, which makes them credential-guessing
 * surfaces reachable with a stolen access token. Keying by user is what bounds
 * that: an attacker holding one session cannot spread attempts across
 * addresses, and legitimate users sharing an office NAT do not share a budget.
 */
userRouter.post(
  '/me/password',
  rateLimit({
    name: 'change-password',
    limit: 10,
    windowMs: HOUR,
    keyOf: (req) => req.actor?.userId ?? null,
  }),
  validate({ body: changePasswordRequestSchema }),
  asyncHandler(userController.changePassword),
);

userRouter.delete(
  '/me',
  rateLimit({
    name: 'delete-account',
    limit: 5,
    windowMs: HOUR,
    keyOf: (req) => req.actor?.userId ?? null,
  }),
  validate({ body: deleteAccountRequestSchema }),
  asyncHandler(userController.deleteMe),
);

userRouter.get('/me/usage', asyncHandler(userController.usage));
