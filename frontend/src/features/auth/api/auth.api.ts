import type { AuthSessionDto, UserDto } from '@lumora/shared';
import { request, setAccessToken } from '@/lib/api/client';

/**
 * Typed request functions, one per endpoint (docs/02-frontend.md §6, Tier 2).
 *
 * Pure async functions with no React dependency, so they are testable without
 * a renderer. Each one that establishes a session also parks the access token
 * in the client — the caller should never have to remember to, and forgetting
 * once produces a signed-in user whose next request is anonymous.
 */

function adopt(session: AuthSessionDto): AuthSessionDto {
  setAccessToken(session.accessToken);
  return session;
}

export async function signup(input: {
  displayName: string;
  email: string;
  password: string;
}): Promise<AuthSessionDto> {
  return adopt(
    await request<AuthSessionDto>('/auth/signup', {
      method: 'POST',
      body: input,
      anonymous: true,
    }),
  );
}

export async function login(input: {
  email: string;
  password: string;
  remember: boolean;
}): Promise<AuthSessionDto> {
  return adopt(
    await request<AuthSessionDto>('/auth/login', {
      method: 'POST',
      body: input,
      anonymous: true,
    }),
  );
}

/**
 * Never throws. Signing out must succeed from the user's point of view even if
 * the request fails — the local session is cleared either way, and a client
 * that refuses to log out because the network blipped is worse than one that
 * leaves a token to expire on its own.
 */
export async function logout(): Promise<void> {
  try {
    await request<undefined>('/auth/logout', { method: 'POST' });
  } catch {
    // Intentionally swallowed; see above.
  } finally {
    setAccessToken(null);
  }
}

/**
 * In-flight verification attempts, keyed by token.
 *
 * Verification is **single-use and destructive**: the server consumes the
 * token atomically, so a second request for the same one legitimately fails.
 * That makes any duplicate call a bug, and duplicates are easy to produce —
 * React StrictMode invokes effects twice in development, a user can open the
 * emailed link in two tabs, and corporate mail scanners routinely fetch links
 * before the human ever clicks.
 *
 * Sharing one promise per token means the request happens once and every
 * caller sees the same outcome. Same shape as the single-flight refresh in
 * `lib/api/client.ts`, and for the same reason.
 */
const verificationAttempts = new Map<string, Promise<AuthSessionDto>>();

export async function verifyEmail(token: string): Promise<AuthSessionDto> {
  let attempt = verificationAttempts.get(token);

  if (!attempt) {
    attempt = request<AuthSessionDto>('/auth/verify-email', {
      method: 'POST',
      body: { token },
      anonymous: true,
    }).then(adopt);

    verificationAttempts.set(token, attempt);

    // A failed attempt is not retained: an expired token should not be
    // permanently cached as a rejection when the user requests a new link.
    attempt.catch(() => verificationAttempts.delete(token));
  }

  return attempt;
}

export async function resendVerification(): Promise<void> {
  await request<undefined>('/auth/resend-verification', { method: 'POST' });
}

/** Always resolves for any syntactically valid address — see the endpoint. */
export async function forgotPassword(email: string): Promise<void> {
  await request<undefined>('/auth/forgot-password', {
    method: 'POST',
    body: { email },
    anonymous: true,
  });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await request<undefined>('/auth/reset-password', {
    method: 'POST',
    body: { token, password },
    anonymous: true,
  });
}

export async function getCurrentUser(): Promise<UserDto> {
  return request<UserDto>('/auth/me');
}
