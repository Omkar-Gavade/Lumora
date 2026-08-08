import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { refreshCookie } from '../helpers/cookies.js';
import {
  TEST_PASSWORD,
  createTestUser,
  lockAccount,
  readLockoutState,
  uniqueEmail,
} from '../factories/user.factory.js';
import { expectApiError } from '../utils/contract.js';

const LOGIN = `${API_PREFIX}/auth/login`;

/** Median rather than mean: one GC pause must not decide a security assertion. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

async function timeLogin(email: string, password: string): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await request().post(LOGIN).send({ email, password });
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

describe('POST /auth/login', () => {
  it('returns a session for correct credentials', async () => {
    const user = await createTestUser();

    const response = await request()
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    expect(response.body.user.id).toBe(user.id);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(response)?.value).toBeTruthy();
  });

  it('accepts a differently-cased address', async () => {
    const user = await createTestUser();

    await request()
      .post(LOGIN)
      .send({ email: user.email.toUpperCase(), password: TEST_PASSWORD })
      .expect(200);
  });

  it('rejects a wrong password', async () => {
    const user = await createTestUser();

    const response = await request()
      .post(LOGIN)
      .send({ email: user.email, password: 'WrongPassword123' });

    expectApiError(response, 401, ERROR_CODES.INVALID_CREDENTIALS);
    expect(refreshCookie(response)).toBeUndefined();
  });

  it('returns an identical error for an account that does not exist', async () => {
    // Splitting these hands an attacker a free account-enumeration oracle,
    // and the distinction is worthless to a user who knows neither.
    const missing = await request()
      .post(LOGIN)
      .send({ email: uniqueEmail('ghost'), password: 'WrongPassword123' });

    const user = await createTestUser();
    const wrongPassword = await request()
      .post(LOGIN)
      .send({ email: user.email, password: 'WrongPassword123' });

    expect(missing.status).toBe(wrongPassword.status);
    expect(missing.body.error.code).toBe(wrongPassword.body.error.code);
    expect(missing.body.error.message).toBe(wrongPassword.body.error.message);
  });

  describe('timing', () => {
    it('takes comparable time whether or not the account exists', async () => {
      const user = await createTestUser();

      const existing: number[] = [];
      const missing: number[] = [];

      // Unique addresses per sample: the login limiter is keyed on IP+email,
      // so reusing one would start returning 429 after five attempts and the
      // measurement would collapse to "how fast is a rejected request".
      for (let i = 0; i < 5; i += 1) {
        existing.push(await timeLogin(user.email, `WrongPassword${String(i)}a`));
        missing.push(await timeLogin(uniqueEmail(`ghost${String(i)}`), `WrongPassword${String(i)}a`));
      }

      const ratio = median(missing) / median(existing);

      /*
        A missing account still runs a full Argon2id verify against a dummy
        hash. Without it, the miss path skips ~50ms of hashing and answers an
        order of magnitude faster — a reliable oracle over the network with no
        error message needed.

        The band is deliberately wide. This asserts "the expensive work still
        happens", not a precise constant, so it cannot fail because CI was
        busy. Removing `verifyDummy` produces a ratio near 0.02 and fails
        loudly.
      */
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(2.5);
    });
  });

  describe('lockout', () => {
    it('counts failures against the account', async () => {
      const user = await createTestUser();

      await request().post(LOGIN).send({ email: user.email, password: 'WrongPassword123' });
      await request().post(LOGIN).send({ email: user.email, password: 'WrongPassword124' });

      expect((await readLockoutState(user.id)).failedLoginCount).toBe(2);
    });

    it('refuses a correct password while locked', async () => {
      const user = await createTestUser();
      await lockAccount(user.id);

      const response = await request()
        .post(LOGIN)
        .send({ email: user.email, password: TEST_PASSWORD });

      expectApiError(response, 429, ERROR_CODES.ACCOUNT_LOCKED);
      expect(response.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('reports a wrong password as invalid credentials while locked, not as locked', async () => {
      // Otherwise the lockout state itself becomes the enumeration oracle the
      // rest of this flow is built to avoid: an attacker who cannot supply the
      // password would still learn the account exists.
      const user = await createTestUser();
      await lockAccount(user.id);

      const response = await request()
        .post(LOGIN)
        .send({ email: user.email, password: 'WrongPassword123' });

      expectApiError(response, 401, ERROR_CODES.INVALID_CREDENTIALS);
    });

    it('clears the counters after a successful sign-in', async () => {
      const user = await createTestUser();
      await request().post(LOGIN).send({ email: user.email, password: 'WrongPassword123' });

      await request().post(LOGIN).send({ email: user.email, password: TEST_PASSWORD }).expect(200);

      const state = await readLockoutState(user.id);
      expect(state.failedLoginCount).toBe(0);
      expect(state.lockedUntil).toBeNull();
    });
  });

  describe('"keep me signed in"', () => {
    it('issues a persistent cookie when remember is true', async () => {
      const user = await createTestUser();

      const response = await request()
        .post(LOGIN)
        .send({ email: user.email, password: TEST_PASSWORD, remember: true })
        .expect(200);

      expect(refreshCookie(response)?.attributes['max-age']).toBeDefined();
    });

    it('issues a session cookie when remember is false', async () => {
      // Persistence, not lifetime: the server-side expiry is the same either
      // way. This only decides whether closing the browser ends the session.
      const user = await createTestUser();

      const response = await request()
        .post(LOGIN)
        .send({ email: user.email, password: TEST_PASSWORD, remember: false })
        .expect(200);

      expect(refreshCookie(response)?.attributes['max-age']).toBeUndefined();
      expect(refreshCookie(response)?.attributes.expires).toBeUndefined();
    });
  });

  describe('validation', () => {
    it('rejects a malformed address with 422', async () => {
      const response = await request().post(LOGIN).send({ email: 'nope', password: 'x' });
      expectApiError(response, 422, ERROR_CODES.VALIDATION_ERROR);
    });

    it('does not apply the new-password policy to sign-in', async () => {
      // Applying it would reject a password set before the rules changed, and
      // would publish the current policy to anyone probing the endpoint.
      const response = await request()
        .post(LOGIN)
        .send({ email: uniqueEmail(), password: 'short' });

      expectApiError(response, 401, ERROR_CODES.INVALID_CREDENTIALS);
    });
  });
});
