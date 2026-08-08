import type {
  ForgotPasswordRequest,
  LoginRequest,
  ResetPasswordRequest,
  SignupRequest,
  VerifyEmailRequest,
} from '@lumora/shared';
import type { Request, Response } from 'express';
import type { Actor } from '../../domain/entities/user.js';
import { UnauthorizedError } from '../../domain/errors/index.js';
import {
  clearRefreshCookie,
  readRefreshCookie,
  readRememberPreference,
  setRefreshCookie,
} from '../../lib/cookies.js';
import { authService, type AuthResult } from '../../services/auth/auth.service.js';
import type { SessionContext } from '../../services/auth/token.service.js';

/**
 * Controllers read validated input, call one service, and map the result to an
 * HTTP response — no business rules, no SQL (docs/03-backend.md §1).
 *
 * The one HTTP-shaped responsibility they *do* own is the refresh cookie: it
 * is a transport detail, so the service returns a raw token and this layer
 * decides how it travels. That is what keeps `authService` testable without a
 * `Response`.
 *
 * Standalone functions rather than methods on an object, matching
 * `health.controller.ts`. Route files pass these by reference, and a detached
 * method carries a `this` that is no longer bound to anything.
 */

/**
 * Captured for the `refresh_tokens` audit columns.
 *
 * Both values are attacker-controlled and are stored, never trusted. The
 * user-agent is truncated because it is an unbounded header being written to a
 * `TEXT` column on every sign-in.
 */
function sessionContext(req: Request): SessionContext {
  const userAgent = req.get('user-agent');
  return {
    userAgent: userAgent ? userAgent.slice(0, 512) : null,
    ipAddress: req.ip ?? null,
  };
}

/** The single place a session becomes a response. */
function respondWithSession(
  res: Response,
  result: AuthResult,
  status: number,
  remember: boolean,
): void {
  setRefreshCookie(res, result.refreshToken, remember);
  // `result.session` carries the access token and the user DTO. The refresh
  // token is deliberately not in it — it exists only in the cookie above.
  res.status(status).json(result.session);
}

function requireActor(req: Request): Actor {
  if (!req.actor) throw new UnauthorizedError();
  return req.actor;
}

export async function signup(req: Request, res: Response): Promise<void> {
  const body = req.body as SignupRequest;

  const result = await authService.signup(
    { email: body.email, password: body.password, displayName: body.displayName },
    sessionContext(req),
  );

  // 201: a user was created (docs/04-data-and-api.md §2.1).
  respondWithSession(res, result, 201, true);
}

export async function login(req: Request, res: Response): Promise<void> {
  const body = req.body as LoginRequest;

  const result = await authService.login(
    { email: body.email, password: body.password },
    sessionContext(req),
  );

  respondWithSession(res, result, 200, body.remember);
}

/**
 * Rotates the refresh cookie and returns a fresh access token.
 *
 * A missing cookie is a 401, not a 400. To a client the two are the same
 * situation — no session — and answering 400 would make the interceptor treat
 * it as a bug rather than as "sign in again".
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  const presented = readRefreshCookie(req.cookies);
  if (!presented) throw new UnauthorizedError();

  let result: AuthResult;
  try {
    result = await authService.refresh(presented, sessionContext(req));
  } catch (error) {
    /*
      Any failed refresh clears the cookie.

      Without this, a browser holding a revoked or replayed token retries it on
      every page load forever — and each retry against a revoked token is
      another reuse detection, which floods the security log with events that
      are all the same already-handled incident.
    */
    clearRefreshCookie(res);
    throw error;
  }

  // Persistence is preserved across rotation: a session cookie stays a session
  // cookie rather than silently becoming a 30-day one.
  respondWithSession(res, result, 200, readRememberPreference(req.cookies));
}

/** 204. Revokes the presented token only; other devices keep their sessions. */
export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(readRefreshCookie(req.cookies));
  clearRefreshCookie(res);
  res.status(204).end();
}

/** 204. Revokes every family and bumps `token_version`. */
export async function logoutAll(req: Request, res: Response): Promise<void> {
  await authService.logoutAll(requireActor(req).userId);
  clearRefreshCookie(res);
  res.status(204).end();
}

/**
 * Verifies an address and issues fresh tokens, so the client's verified gate
 * lifts immediately rather than at the next token expiry.
 */
export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const body = req.body as VerifyEmailRequest;
  const result = await authService.verifyEmail(body.token, sessionContext(req));
  respondWithSession(res, result, 200, true);
}

export async function resendVerification(req: Request, res: Response): Promise<void> {
  await authService.resendVerification(requireActor(req).userId);
  res.status(204).end();
}

/**
 * **Always 200**, whether or not the address is registered
 * (docs/04-data-and-api.md §2.1). Any observable difference turns this into a
 * membership oracle for an arbitrary address list.
 */
export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const body = req.body as ForgotPasswordRequest;
  await authService.forgotPassword(body.email);
  res.status(200).json({ ok: true });
}

/**
 * 204, and the cookie is cleared: the reset revoked every session including
 * whichever one made this request.
 */
export async function resetPassword(req: Request, res: Response): Promise<void> {
  const body = req.body as ResetPasswordRequest;
  await authService.resetPassword(body.token, body.password);
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await authService.getCurrentUser(requireActor(req).userId);
  res.status(200).json(user);
}
