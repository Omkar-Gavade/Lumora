import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { authenticatedRequest } from '../helpers/auth.js';
import { asCookieHeader, clearsRefreshCookie } from '../helpers/cookies.js';
import { createTestUser, loginTestUser } from '../factories/user.factory.js';
import { refreshTokensFor, tokenVersionOf } from '../factories/token.factory.js';
import { expectApiError, expectNoContent } from '../utils/contract.js';

const LOGOUT = `${API_PREFIX}/auth/logout`;
const LOGOUT_ALL = `${API_PREFIX}/auth/logout-all`;
const REFRESH = `${API_PREFIX}/auth/refresh`;

describe('POST /auth/logout', () => {
  it('revokes the presented token and clears the cookie', async () => {
    const user = await createTestUser();

    const response = await request().post(LOGOUT).set('Cookie', asCookieHeader(user.refreshToken));

    expectNoContent(response);
    expect(clearsRefreshCookie(response)).toBe(true);

    await request().post(REFRESH).set('Cookie', asCookieHeader(user.refreshToken)).expect(401);
  });

  it('leaves other sessions signed in', async () => {
    const user = await createTestUser();
    const other = await loginTestUser(user.email);

    await request().post(LOGOUT).set('Cookie', asCookieHeader(user.refreshToken)).expect(204);

    // Signing out of one device must not sign out the rest.
    await request().post(REFRESH).set('Cookie', asCookieHeader(other.refreshToken)).expect(200);
  });

  it('succeeds with no cookie at all', async () => {
    // A client clearing state it already lost should still end up signed out,
    // and reporting whether a token existed would be an oracle.
    expectNoContent(await request().post(LOGOUT));
  });

  it('is idempotent', async () => {
    const user = await createTestUser();

    await request().post(LOGOUT).set('Cookie', asCookieHeader(user.refreshToken)).expect(204);
    await request().post(LOGOUT).set('Cookie', asCookieHeader(user.refreshToken)).expect(204);
  });

  it('needs no authentication — signing out must never fail', async () => {
    expectNoContent(await request().post(LOGOUT).set('Authorization', 'Bearer garbage'));
  });
});

describe('POST /auth/logout-all', () => {
  it('requires authentication', async () => {
    expectApiError(await request().post(LOGOUT_ALL), 401, ERROR_CODES.UNAUTHORIZED);
  });

  it('revokes every session and bumps the token version', async () => {
    const user = await createTestUser();
    const second = await loginTestUser(user.email);
    const versionBefore = await tokenVersionOf(user.id);

    const response = await authenticatedRequest(user.session.accessToken).post('/auth/logout-all');
    expectNoContent(response);

    /*
      The version bump is what reaches the stateless half. Revoking refresh
      rows alone would leave up to fifteen minutes of usable access tokens,
      which is exactly what "sign out everywhere" must not mean.
    */
    expect(await tokenVersionOf(user.id)).toBe(versionBefore + 1);

    const rows = await refreshTokensFor(user.id);
    expect(rows.every((row) => row.revokedReason === 'logout')).toBe(true);

    await request().post(REFRESH).set('Cookie', asCookieHeader(user.refreshToken)).expect(401);
    await request().post(REFRESH).set('Cookie', asCookieHeader(second.refreshToken)).expect(401);
  });

  it('clears the caller’s own cookie', async () => {
    const user = await createTestUser();

    const response = await authenticatedRequest(user.session.accessToken)
      .post('/auth/logout-all')
      .set('Cookie', asCookieHeader(user.refreshToken));

    expect(clearsRefreshCookie(response)).toBe(true);
  });
});
