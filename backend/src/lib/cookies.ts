import type { CookieOptions, Response } from 'express';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH, env, isProduction } from '../config/index.js';

/**
 * The refresh cookie (docs/04-data-and-api.md §3.1).
 *
 * Every flag here is load-bearing:
 *
 * `httpOnly` — JavaScript cannot read it. This is the whole reason the refresh
 *   token travels as a cookie while the access token does not: an XSS can read
 *   an in-memory access token that happens to be live, but it cannot exfiltrate
 *   the credential that mints new ones.
 *
 * `sameSite: 'strict'` — never sent on a cross-site request, which eliminates
 *   CSRF on the refresh endpoint outright rather than mitigating it. Works
 *   across `:5173 → :4000` because same-site is scoped to the registrable
 *   domain, not the port; and across `app.lumora.com → api.lumora.com` for the
 *   same reason.
 *
 * `path` — scoped to the auth routes, so the cookie is not attached to every
 *   ordinary API call. Every other endpoint authenticates with an
 *   `Authorization` header, which is what makes the rest of the API
 *   CSRF-immune by construction.
 *
 * `secure` — off in development because a Secure cookie is simply not sent over
 *   plain HTTP, and localhost has no TLS. Forced on in production.
 */
function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    path: REFRESH_COOKIE_PATH,
  };
}

/**
 * Companion flag recording that the user asked to stay signed in.
 *
 * A browser sends back only a cookie's name and value — never its `Max-Age`.
 * So on rotation the server cannot tell whether the refresh cookie it is
 * replacing was persistent or session-scoped, and guessing "persistent" would
 * quietly upgrade a *don't* remember me session to thirty days on its first
 * refresh, defeating the checkbox entirely.
 *
 * This carries no secret — only the choice — and is set with exactly the same
 * persistence as the token cookie. When `remember` is false it is not set at
 * all, so its absence is the signal. That works in both directions: a
 * session-scoped pair leaves no marker to find, and a persistent pair carries
 * one for as long as the token itself lives.
 */
const REMEMBER_COOKIE_NAME = `${REFRESH_COOKIE_NAME}_r`;

/**
 * `remember` decides persistence, not lifetime.
 *
 * The token's server-side expiry is `REFRESH_TOKEN_TTL_DAYS` either way — this
 * only chooses whether the browser keeps the cookie after it closes. Tying the
 * *token's* lifetime to a checkbox would mean a user who unticks it holds a
 * short-lived credential the server still considers valid for 30 days, which
 * is a revocation gap dressed up as a preference.
 */
export function setRefreshCookie(res: Response, token: string, remember: boolean): void {
  const options = baseOptions();
  const maxAge = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  const persistence = remember ? { maxAge } : {};

  res.cookie(REFRESH_COOKIE_NAME, token, { ...options, ...persistence });

  if (remember) {
    res.cookie(REMEMBER_COOKIE_NAME, '1', { ...options, ...persistence });
  } else {
    // Clear any marker left by a previous "remember me" session on this
    // browser, or the next rotation would read a stale choice.
    res.clearCookie(REMEMBER_COOKIE_NAME, options);
  }
}

/**
 * Clears both cookies.
 *
 * The flags must match those they were set with — a browser matches on name,
 * domain, and path, so clearing with a different path silently leaves the
 * original in place and the user stays signed in after logging out.
 */
export function clearRefreshCookie(res: Response): void {
  const options = baseOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options);
  res.clearCookie(REMEMBER_COOKIE_NAME, options);
}

export function readRefreshCookie(cookies: Record<string, unknown>): string | undefined {
  const value = cookies[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the recorded choice, so rotation preserves it. */
export function readRememberPreference(cookies: Record<string, unknown>): boolean {
  return cookies[REMEMBER_COOKIE_NAME] === '1';
}
