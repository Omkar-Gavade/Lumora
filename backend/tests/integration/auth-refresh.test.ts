import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { API_PREFIX, agent, request } from '../helpers/app.js';
import { asCookieHeader, refreshCookie } from '../helpers/cookies.js';
import { TEST_PASSWORD, createTestUser, loginTestUser } from '../factories/user.factory.js';
import {
  createExpiredRefreshToken,
  createRefreshToken,
  refreshTokensFor,
} from '../factories/token.factory.js';
import { expectApiError } from '../utils/contract.js';

const REFRESH = `${API_PREFIX}/auth/refresh`;

/**
 * Top of the priority list in docs/03-backend.md §9 — "token service (rotation
 * and reuse detection)".
 *
 * These are the tests that would have caught the M2 bug where the family
 * revocation ran inside the transaction and the subsequent `throw` rolled it
 * back: the endpoint answered 401 and revoked nothing, so the stolen token's
 * sibling stayed live while the response claimed otherwise.
 */
describe('POST /auth/refresh', () => {
  it('rotates the token and returns a new access token', async () => {
    const user = await createTestUser();

    const response = await request()
      .post(REFRESH)
      .set('Cookie', asCookieHeader(user.refreshToken))
      .expect(200);

    const rotated = refreshCookie(response)?.value;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(user.refreshToken);
    expect(response.body.accessToken).toEqual(expect.any(String));
  });

  it('keeps the rotated token in the same family, linked to its parent', async () => {
    const user = await createTestUser();
    await request().post(REFRESH).set('Cookie', asCookieHeader(user.refreshToken)).expect(200);

    const rows = await refreshTokensFor(user.id);
    expect(rows).toHaveLength(2);
    // Same lineage — that is what makes a later replay traceable to the whole
    // chain rather than to one orphaned row.
    expect(rows[0]?.familyId).toBe(rows[1]?.familyId);
    expect(rows[0]?.revokedReason).toBe('rotated');
    expect(rows[1]?.revokedReason).toBeNull();
  });

  it('rotates repeatedly for a well-behaved client', async () => {
    const user = await createTestUser();
    const client = agent();

    await client.post(`${API_PREFIX}/auth/login`).send({ email: user.email, password: TEST_PASSWORD }).expect(200);

    // The agent stores each new cookie, the way a browser does. A test that
    // kept resending the original would be testing replay, not rotation.
    for (let i = 0; i < 3; i += 1) {
      await client.post(REFRESH).expect(200);
    }
  });

  it('requires a cookie — a missing one is 401, not 400', async () => {
    // To a client both mean "no session"; a 400 would make the interceptor
    // treat it as a bug rather than as "sign in again".
    const response = await request().post(REFRESH);
    expectApiError(response, 401, ERROR_CODES.UNAUTHORIZED);
  });

  it('rejects an unknown token without revoking anything', async () => {
    const user = await createTestUser();

    const response = await request().post(REFRESH).set('Cookie', asCookieHeader('not-a-real-token'));

    expectApiError(response, 401, ERROR_CODES.TOKEN_INVALID);

    // Garbage must not be treated as an attack, or anyone could sign anyone
    // else out by posting random strings.
    const rows = await refreshTokensFor(user.id);
    expect(rows.every((row) => row.revokedReason === null)).toBe(true);
  });

  it('rejects an expired token', async () => {
    const user = await createTestUser();
    const expired = await createExpiredRefreshToken(user.id);

    const response = await request().post(REFRESH).set('Cookie', asCookieHeader(expired.token));
    expectApiError(response, 401, ERROR_CODES.TOKEN_EXPIRED);
  });

  it('clears the cookie on any failed refresh', async () => {
    // Otherwise a browser holding a revoked token retries it on every page
    // load forever, and each retry is another reuse detection for the same
    // already-handled incident.
    const response = await request().post(REFRESH).set('Cookie', asCookieHeader('garbage'));
    expect(refreshCookie(response)?.value).toBe('');
  });

  describe('reuse detection', () => {
    it('rejects a replayed token and revokes the entire family', async () => {
      const user = await createTestUser();
      const original = user.refreshToken;

      const rotated = await request()
        .post(REFRESH)
        .set('Cookie', asCookieHeader(original))
        .expect(200);
      const successor = refreshCookie(rotated)?.value ?? '';

      // The legitimate client has rotated past `original`, so presenting it
      // means someone captured it.
      const replay = await request().post(REFRESH).set('Cookie', asCookieHeader(original));
      expectApiError(replay, 401, ERROR_CODES.TOKEN_REUSED);

      /*
        The successor must now be dead too. This is the assertion that fails
        if the revocation is rolled back by the throw that follows it — the
        exact M2 defect. Without it, the 401 above passes while nothing was
        actually revoked.
      */
      const successorAttempt = await request().post(REFRESH).set('Cookie', asCookieHeader(successor));
      expect(successorAttempt.status).toBe(401);

      const rows = await refreshTokensFor(user.id);
      expect(rows.some((row) => row.revokedReason === 'reuse_detected')).toBe(true);
      expect(rows.every((row) => row.revokedReason !== null)).toBe(true);
    });

    it('leaves other families untouched — one compromised device does not sign out the rest', async () => {
      const user = await createTestUser();
      const secondSession = await loginTestUser(user.email);

      await request().post(REFRESH).set('Cookie', asCookieHeader(user.refreshToken)).expect(200);
      await request().post(REFRESH).set('Cookie', asCookieHeader(user.refreshToken)).expect(401);

      // A separate sign-in is a separate family, so it survives.
      await request()
        .post(REFRESH)
        .set('Cookie', asCookieHeader(secondSession.refreshToken))
        .expect(200);
    });

    it('treats a token revoked by logout as a replay if presented again', async () => {
      const user = await createTestUser();
      const seeded = await createRefreshToken({ userId: user.id, revokedReason: 'logout' });

      const response = await request().post(REFRESH).set('Cookie', asCookieHeader(seeded.token));
      expectApiError(response, 401, ERROR_CODES.TOKEN_REUSED);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of several simultaneous refreshes succeed', async () => {
      /*
        `SELECT … FOR UPDATE` serializes them. Without the lock both would see
        the token live, both would rotate, and each would revoke the other's
        descendant — the user is signed out by their own browser.

        The client's single-flight promise is the matching half; this is the
        half that has to be correct when the client's is not.
      */
      const user = await createTestUser();

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          request().post(REFRESH).set('Cookie', asCookieHeader(user.refreshToken)),
        ),
      );

      const succeeded = results.filter((response) => response.status === 200);
      expect(succeeded).toHaveLength(1);
      expect(results.filter((response) => response.status === 401)).toHaveLength(5);
    });
  });

  describe('cookie persistence', () => {
    it('keeps a session cookie session-scoped across rotation', async () => {
      // A browser never sends Max-Age back, so without the companion marker
      // the server cannot tell, and would silently upgrade a "don't remember
      // me" session to thirty days on its first refresh.
      const user = await createTestUser();
      const login = await request()
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: user.email, password: TEST_PASSWORD, remember: false })
        .expect(200);

      const token = refreshCookie(login)?.value ?? '';
      const refreshed = await request().post(REFRESH).set('Cookie', asCookieHeader(token)).expect(200);

      expect(refreshCookie(refreshed)?.attributes['max-age']).toBeUndefined();
    });

    it('keeps a persistent cookie persistent across rotation', async () => {
      const user = await createTestUser();
      const login = await request()
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: user.email, password: TEST_PASSWORD, remember: true })
        .expect(200);

      const cookies = login.headers['set-cookie'] as unknown as string[];
      const refreshed = await request().post(REFRESH).set('Cookie', cookies).expect(200);

      expect(refreshCookie(refreshed)?.attributes['max-age']).toBeDefined();
    });
  });
});
