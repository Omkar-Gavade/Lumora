import type { Response } from 'supertest';
import { REFRESH_COOKIE_NAME } from '../../src/config/index.js';

export interface ParsedCookie {
  name: string;
  value: string;
  /** Lowercased attribute names → value, or `true` for valueless flags. */
  attributes: Record<string, string | true>;
}

/**
 * Parses `Set-Cookie` headers.
 *
 * Hand-written because the assertions here are about the *attributes* —
 * `HttpOnly`, `SameSite`, `Path`, `Max-Age` — and every cookie library throws
 * those away, returning only name and value. Those flags are the security
 * property being tested (docs/04-data-and-api.md §3.1), so they cannot be the
 * part that gets discarded.
 */
export function parseSetCookies(response: Response): ParsedCookie[] {
  const header = response.headers['set-cookie'];
  const raw: string[] = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];

  return raw.map((entry) => {
    const [pair, ...rest] = entry.split(';');
    const separator = (pair ?? '').indexOf('=');

    const attributes: Record<string, string | true> = {};
    for (const part of rest) {
      const trimmed = part.trim();
      const equals = trimmed.indexOf('=');
      if (equals === -1) attributes[trimmed.toLowerCase()] = true;
      else attributes[trimmed.slice(0, equals).toLowerCase()] = trimmed.slice(equals + 1);
    }

    return {
      name: (pair ?? '').slice(0, separator),
      value: (pair ?? '').slice(separator + 1),
      attributes,
    };
  });
}

export function findCookie(response: Response, name: string): ParsedCookie | undefined {
  return parseSetCookies(response).find((cookie) => cookie.name === name);
}

/** The refresh cookie, by the name production actually uses. */
export function refreshCookie(response: Response): ParsedCookie | undefined {
  return findCookie(response, REFRESH_COOKIE_NAME);
}

/**
 * The refresh token value, for tests that need to replay a specific one.
 *
 * Returns the raw value rather than a `Cookie` header so a test can decide
 * whether to present it as the current session or as a captured replay.
 */
export function refreshTokenFrom(response: Response): string {
  const cookie = refreshCookie(response);
  if (cookie === undefined || cookie.value.length === 0) {
    throw new Error('No refresh cookie on the response — the request did not establish a session.');
  }
  return cookie.value;
}

/** Formats a raw token as a `Cookie` request header. */
export function asCookieHeader(token: string): string {
  return `${REFRESH_COOKIE_NAME}=${token}`;
}

/**
 * True when the response clears the cookie rather than setting one.
 *
 * Express clears by re-sending the name with an empty value and an expiry in
 * the past, so "cleared" is not the same as "absent" — logout must actively
 * clear it, and a test that only checks for absence would pass against a
 * handler that forgot to.
 */
export function clearsRefreshCookie(response: Response): boolean {
  const cookie = refreshCookie(response);
  return cookie?.value === '';
}
