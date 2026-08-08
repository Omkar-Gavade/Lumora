import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
  verifyEmailRequestSchema,
} from '@lumora/shared';
import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { authenticate } from '../middleware/authenticate.js';
import { emailKey, ipEmailKey, ipKey, rateLimit } from '../middleware/rate-limit.js';
import { validate } from '../middleware/validate.js';

const MINUTE = 60 * 1000;
const FIFTEEN_MINUTES = 15 * MINUTE;
const HOUR = 60 * MINUTE;

/**
 * Auth routes.
 *
 * Per-route chain order is `rate-limit → authenticate → validate → controller`
 * (docs/03-backend.md §3). Rate limiting comes **first** deliberately: a
 * limiter that runs after validation still pays for parsing and, on the login
 * route, for an Argon2id verification — which is exactly the expensive work an
 * attacker wants to force.
 *
 * The limits are those in docs/04-data-and-api.md §3.4, and nothing else. The
 * documented global 300/15min ceiling is not mounted here; it belongs to the
 * whole API surface rather than to authentication.
 */
export const authRouter: Router = Router();

/** 3 / hour per IP. Signup is the only endpoint that creates rows for free. */
authRouter.post(
  '/signup',
  rateLimit({ name: 'signup', limit: 3, windowMs: HOUR, keyOf: ipKey }),
  validate({ body: signupRequestSchema }),
  asyncHandler(authController.signup),
);

/**
 * 5 / 15 min per IP+email, on top of the per-account exponential backoff in
 * `authService.login`. The pair is what makes it useful in both directions:
 * per-IP alone lets a botnet spread guesses across addresses, per-email alone
 * lets anyone lock out a chosen user.
 */
authRouter.post(
  '/login',
  rateLimit({ name: 'login', limit: 5, windowMs: FIFTEEN_MINUTES, keyOf: ipEmailKey }),
  validate({ body: loginRequestSchema }),
  asyncHandler(authController.login),
);

/**
 * 30 / 15 min per IP. Higher than login because a legitimate client refreshes
 * on a timer and several tabs may do it at once; still low enough that a stolen
 * cookie cannot be ground against the rotation logic.
 */
authRouter.post(
  '/refresh',
  rateLimit({ name: 'refresh', limit: 30, windowMs: FIFTEEN_MINUTES, keyOf: ipKey }),
  asyncHandler(authController.refresh),
);

/** Unlimited and unauthenticated: signing out must never fail. */
authRouter.post('/logout', asyncHandler(authController.logout));

authRouter.post('/logout-all', authenticate, asyncHandler(authController.logoutAll));

/**
 * Two limiters, both applied. 3/hour per email protects the *recipient* from
 * being mail-bombed; 10/hour per IP stops one client from walking an address
 * list. Either alone leaves the other attack open.
 */
authRouter.post(
  '/forgot-password',
  rateLimit({ name: 'forgot-ip', limit: 10, windowMs: HOUR, keyOf: ipKey }),
  rateLimit({ name: 'forgot-email', limit: 3, windowMs: HOUR, keyOf: emailKey }),
  validate({ body: forgotPasswordRequestSchema }),
  asyncHandler(authController.forgotPassword),
);

authRouter.post(
  '/reset-password',
  rateLimit({ name: 'reset', limit: 10, windowMs: HOUR, keyOf: ipKey }),
  validate({ body: resetPasswordRequestSchema }),
  asyncHandler(authController.resetPassword),
);

authRouter.post(
  '/verify-email',
  rateLimit({ name: 'verify', limit: 20, windowMs: HOUR, keyOf: ipKey }),
  validate({ body: verifyEmailRequestSchema }),
  asyncHandler(authController.verifyEmail),
);

/**
 * The 60-second cooldown is enforced in `verificationService`, keyed to the
 * account rather than the client — a per-IP limiter would not stop one signed-in
 * user mailing themselves from several networks.
 */
authRouter.post(
  '/resend-verification',
  authenticate,
  asyncHandler(authController.resendVerification),
);

authRouter.get('/me', authenticate, asyncHandler(authController.me));
