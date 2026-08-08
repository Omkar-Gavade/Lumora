import { describe, expect, it } from 'vitest';
import { API_PREFIX, request } from '../helpers/app.js';
import { parseSetCookies, refreshCookie } from '../helpers/cookies.js';
import { TEST_PASSWORD, createTestUser, uniqueEmail } from '../factories/user.factory.js';

const SIGNUP = `${API_PREFIX}/auth/signup`;
const LOGIN = `${API_PREFIX}/auth/login`;

/**
 * The properties that must never regress silently.
 *
 * Each of these is a specific attack the design defends against
 * (docs/04-data-and-api.md §3.1, §4), and each would keep every functional
 * test passing if it were removed — which is exactly why they need tests of
 * their own.
 */
describe('refresh cookie flags', () => {
  it('is httpOnly, so an XSS cannot read the credential that mints tokens', async () => {
    const user = await createTestUser();
    const response = await request()
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    expect(refreshCookie(response)?.attributes.httponly).toBe(true);
  });

  it('is SameSite=Strict, which eliminates CSRF on refresh outright', async () => {
    const user = await createTestUser();
    const response = await request()
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    expect(String(refreshCookie(response)?.attributes.samesite).toLowerCase()).toBe('strict');
  });

  it('is path-scoped to the auth routes, so it is not attached to ordinary API calls', async () => {
    const user = await createTestUser();
    const response = await request()
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    expect(refreshCookie(response)?.attributes.path).toBe('/api/v1/auth');
  });

  it('omits Secure outside production, because a Secure cookie is not sent over plain HTTP', async () => {
    // The suite runs with NODE_ENV=test. Asserting the *test* behaviour here
    // rather than claiming to prove the production flag: `secure: isProduction`
    // is a one-line expression, and a test that lied about which branch it
    // exercised would be worse than none.
    const user = await createTestUser();
    const response = await request()
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    expect(refreshCookie(response)?.attributes.secure).toBeUndefined();
  });

  it('carries the persistence marker with the same flags as the token cookie', async () => {
    const user = await createTestUser();
    const response = await request()
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD, remember: true })
      .expect(200);

    const marker = parseSetCookies(response).find((cookie) => cookie.name === 'lumora_rt_r');
    expect(marker?.attributes.httponly).toBe(true);
    expect(marker?.attributes.path).toBe('/api/v1/auth');
  });

  it('never places the token anywhere JavaScript can reach', async () => {
    const user = await createTestUser();
    const response = await request()
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    const token = refreshCookie(response)?.value ?? '';
    expect(token).not.toBe('');
    // The one place it may appear is the Set-Cookie header.
    expect(JSON.stringify(response.body)).not.toContain(token);
  });
});

describe('account enumeration resistance', () => {
  it('signup is the only endpoint that discloses an address is registered', async () => {
    /*
      That single disclosure is accepted: signup cannot explain its own
      failure otherwise, and the person supplying the address is asserting
      they own it. It is bounded by the per-IP limit of three an hour, so it
      cannot be used to test a list without also creating accounts.
    */
    const user = await createTestUser();

    const taken = await request()
      .post(SIGNUP)
      .send({ displayName: 'B', email: user.email, password: TEST_PASSWORD });
    expect(taken.status).toBe(409);

    // Every other endpoint answers identically for known and unknown.
    const knownLogin = await request().post(LOGIN).send({ email: user.email, password: 'Wrong1Password' });
    const unknownLogin = await request().post(LOGIN).send({ email: uniqueEmail('ghost'), password: 'Wrong1Password' });
    expect(knownLogin.status).toBe(unknownLogin.status);
    expect(knownLogin.body.error.code).toBe(unknownLogin.body.error.code);

    const knownForgot = await request().post(`${API_PREFIX}/auth/forgot-password`).send({ email: user.email });
    const unknownForgot = await request().post(`${API_PREFIX}/auth/forgot-password`).send({ email: uniqueEmail('ghost') });
    expect(knownForgot.status).toBe(unknownForgot.status);
    expect(knownForgot.body).toEqual(unknownForgot.body);
  });
});

describe('security headers', () => {
  it('does not advertise the framework', async () => {
    const response = await request().get('/health').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sends a CSP that denies everything — the API returns JSON only', async () => {
    const response = await request().get('/health').expect(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('sets a referrer policy and nosniff', async () => {
    const response = await request().get('/health').expect(200);
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS', () => {
  it('allows a configured origin with credentials', async () => {
    const response = await request()
      .get('/health')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects an unlisted origin with the JSON envelope, not an HTML 500', async () => {
    // The rejection has to reach the terminal handler with a request id
    // attached — which is only true because request context is established
    // before CORS runs.
    const response = await request().get('/health').set('Origin', 'https://evil.example');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.requestId).toMatch(/^req_/);
  });

  it('never echoes a wildcard', async () => {
    const response = await request().get('/health').set('Origin', 'http://localhost:5173');
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('request body limits', () => {
  it('rejects an oversized body with 413, not 500', async () => {
    // A client that receives a 500 retries the same oversized payload forever.
    const response = await request()
      .post(LOGIN)
      .set('Content-Type', 'application/json')
      .send(`{"email":"a@b.com","password":"${'x'.repeat(2 * 1024 * 1024)}"}`);

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
