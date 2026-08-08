import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { API_PREFIX, agent, request } from '../helpers/app.js';
import { anonymousRequest, authenticatedRequest } from '../helpers/auth.js';
import { TEST_PASSWORD, createTestUser, createVerifiedUser } from '../factories/user.factory.js';
import { createAccessToken, createExpiredToken } from '../factories/token.factory.js';
import { expectApiError } from '../utils/contract.js';

const ME = '/auth/me';

describe('GET /auth/me — the protected-route contract', () => {
  it('returns the current user for a valid token', async () => {
    const user = await createVerifiedUser();

    const response = await authenticatedRequest(user.session.accessToken).get(ME).expect(200);

    expect(response.body).toEqual({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: true,
      createdAt: expect.any(String),
    });
  });

  it('never exposes internal columns', async () => {
    // The DTO is a deliberate projection: adding a column to `users` must not
    // widen the response by default.
    const user = await createVerifiedUser();
    const response = await authenticatedRequest(user.session.accessToken).get(ME).expect(200);

    for (const field of ['passwordHash', 'password_hash', 'tokenVersion', 'failedLoginCount', 'lockedUntil']) {
      expect(response.body).not.toHaveProperty(field);
    }
  });

  it('rejects a request with no credentials', async () => {
    // `anonymousRequest` adds the version prefix itself.
    expectApiError(await anonymousRequest().get(ME), 401, ERROR_CODES.UNAUTHORIZED);
  });

  it.each([
    ['a malformed token', 'not.a.jwt'],
    ['an empty bearer value', ''],
  ])('rejects %s', async (_label, token) => {
    const response = await request().get(`${API_PREFIX}${ME}`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(401);
  });

  it('distinguishes an expired token from an invalid one', async () => {
    // The client's response differs: expiry means refresh and retry once,
    // invalid means sign in again. Collapsing them makes the interceptor
    // either retry forever or give up too early.
    const user = await createVerifiedUser();

    const expired = await request()
      .get(`${API_PREFIX}${ME}`)
      .set('Authorization', `Bearer ${await createExpiredToken(user.id, user.email)}`);
    expectApiError(expired, 401, ERROR_CODES.TOKEN_EXPIRED);

    const tampered = await request()
      .get(`${API_PREFIX}${ME}`)
      .set('Authorization', `Bearer ${await createAccessToken({ userId: user.id, wrongSecret: true })}`);
    expectApiError(tampered, 401, ERROR_CODES.TOKEN_INVALID);
  });

  it('rejects a token of the wrong type', async () => {
    // Guards against a future token kind being replayed as an access token,
    // even if it were somehow signed with the same key.
    const user = await createVerifiedUser();
    const wrongType = await createAccessToken({ userId: user.id, email: user.email, typ: 'refresh' });

    const response = await request().get(`${API_PREFIX}${ME}`).set('Authorization', `Bearer ${wrongType}`);
    expectApiError(response, 401, ERROR_CODES.TOKEN_INVALID);
  });

  it.each([
    ['a foreign issuer', { issuer: 'evil' }],
    ['a foreign audience', { audience: 'another-api' }],
  ])('rejects a token with %s', async (_label, overrides) => {
    const user = await createVerifiedUser();
    const token = await createAccessToken({ userId: user.id, email: user.email, ...overrides });

    const response = await request().get(`${API_PREFIX}${ME}`).set('Authorization', `Bearer ${token}`);
    expectApiError(response, 401, ERROR_CODES.TOKEN_INVALID);
  });

  it('ignores a refresh cookie — a cookie alone never authenticates the API', async () => {
    /*
      This is what makes the API CSRF-proof by construction: every endpoint
      but refresh authenticates with an `Authorization` header, which a
      cross-origin page cannot set without CORS approval.
    */
    const user = await createVerifiedUser();

    const response = await request()
      .get(`${API_PREFIX}${ME}`)
      .set('Cookie', `lumora_rt=${user.refreshToken}`);

    expectApiError(response, 401, ERROR_CODES.UNAUTHORIZED);
  });

  it('accepts a lowercase bearer scheme, per RFC 7235', async () => {
    const user = await createVerifiedUser();
    await request()
      .get(`${API_PREFIX}${ME}`)
      .set('Authorization', `bearer ${user.session.accessToken}`)
      .expect(200);
  });
});

describe('verification gating (FR-5)', () => {
  it('lets an unverified account sign in and read its own profile', async () => {
    /*
      FR-5: hard-blocking sign-in strands users who lose the email, so an
      unverified account keeps the shell and Settings and is blocked only from
      the expensive actions. `requireVerified` therefore gates specific routes
      and never authentication itself.
    */
    const user = await createTestUser();

    const response = await authenticatedRequest(user.session.accessToken).get(ME).expect(200);
    expect(response.body.emailVerified).toBe(false);
  });

  it('carries the verification state in the token claims, not a database lookup', async () => {
    // The access path stays query-free; the claim is refreshed whenever
    // tokens are reissued, and verification reissues them immediately.
    const user = await createVerifiedUser();
    const [, payload] = user.session.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as {
      emailVerified: boolean;
      typ: string;
      sub: string;
    };

    expect(claims.emailVerified).toBe(true);
    expect(claims.typ).toBe('access');
    expect(claims.sub).toBe(user.id);
  });
});

describe('session restoration', () => {
  it('mints a working access token from the refresh cookie alone', async () => {
    /*
      The cold-load path: the access token died with the page, the httpOnly
      refresh cookie did not. This is what lets the token be memory-only —
      the cost of losing it on reload is one silent request.
    */
    const user = await createVerifiedUser();
    const client = agent();

    await client
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    const restored = await client.post(`${API_PREFIX}/auth/refresh`).expect(200);

    await request()
      .get(`${API_PREFIX}${ME}`)
      .set('Authorization', `Bearer ${restored.body.accessToken}`)
      .expect(200);
  });

  it('fails restoration after sign-out', async () => {
    const user = await createVerifiedUser();
    const client = agent();

    await client
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);
    await client.post(`${API_PREFIX}/auth/logout`).expect(204);

    await client.post(`${API_PREFIX}/auth/refresh`).expect(401);
  });
});
