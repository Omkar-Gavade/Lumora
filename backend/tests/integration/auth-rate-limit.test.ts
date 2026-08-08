import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { TEST_PASSWORD, createTestUser, uniqueEmail } from '../factories/user.factory.js';
import { expectApiError } from '../utils/contract.js';

/**
 * The limits in docs/04-data-and-api.md §3.4.
 *
 * Every counter is reset in `beforeEach`, so each test starts from zero — the
 * limiters are keyed partly by IP and the whole suite connects from
 * 127.0.0.1, which would otherwise make the fourth signup test in a run fail
 * on a limit the third one consumed.
 */
describe('rate limiting', () => {
  it('caps signup at 3 per hour per IP', async () => {
    const attempt = () =>
      request()
        .post(`${API_PREFIX}/auth/signup`)
        .send({ displayName: 'A', email: uniqueEmail(), password: TEST_PASSWORD });

    expect((await attempt()).status).toBe(201);
    expect((await attempt()).status).toBe(201);
    expect((await attempt()).status).toBe(201);

    // Signup is the only endpoint that creates rows for free.
    expectApiError(await attempt(), 429, ERROR_CODES.RATE_LIMITED);
  });

  it('caps login at 5 per 15 minutes per IP and email', async () => {
    const user = await createTestUser();
    const attempt = () =>
      request().post(`${API_PREFIX}/auth/login`).send({ email: user.email, password: 'Wrong1Password' });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(401);
    }

    expectApiError(await attempt(), 429, ERROR_CODES.RATE_LIMITED);
  });

  it('keys the login limit on the pair, so one address cannot lock out another', async () => {
    /*
      Per-IP alone would let a botnet spread guesses across addresses; per-email
      alone would let anyone lock a chosen user out by failing their sign-in
      five times. The pair is what makes it useful in both directions.
    */
    const victim = await createTestUser();
    const other = await createTestUser();

    for (let i = 0; i < 6; i += 1) {
      await request().post(`${API_PREFIX}/auth/login`).send({ email: victim.email, password: 'Wrong1Password' });
    }

    // The other account, from the same IP, is unaffected.
    await request()
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: other.email, password: TEST_PASSWORD })
      .expect(200);
  });

  it('caps forgot-password at 3 per hour per email address', async () => {
    // Protects the *recipient* from being mail-bombed.
    const user = await createTestUser();
    const attempt = () =>
      request().post(`${API_PREFIX}/auth/forgot-password`).send({ email: user.email });

    for (let i = 0; i < 3; i += 1) {
      expect((await attempt()).status).toBe(200);
    }

    expectApiError(await attempt(), 429, ERROR_CODES.RATE_LIMITED);
  });

  it('caps refresh at 30 per 15 minutes per IP', async () => {
    // Higher than login because a legitimate client refreshes on a timer and
    // several tabs may do it at once.
    const results: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const response = await request().post(`${API_PREFIX}/auth/refresh`);
      results.push(response.status);
    }

    expect(results.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(results.at(-1)).toBe(429);
  });

  it('advertises the limit on every response, not only on rejections', async () => {
    // A client that can see it has one request left backs off; one that only
    // learns at the 429 has already failed the request it cared about.
    const response = await request()
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: uniqueEmail(), password: 'Wrong1Password' });

    expect(response.headers['ratelimit-limit']).toBe('5');
    expect(response.headers['ratelimit-remaining']).toBe('4');
    expect(Number(response.headers['ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('sends Retry-After when it rejects', async () => {
    // A 429 without it tells a client it is too fast but not by how much, so
    // it guesses — usually immediately, usually wrong.
    const email = uniqueEmail();
    for (let i = 0; i < 5; i += 1) {
      await request().post(`${API_PREFIX}/auth/login`).send({ email, password: 'Wrong1Password' });
    }

    const rejected = await request().post(`${API_PREFIX}/auth/login`).send({ email, password: 'Wrong1Password' });

    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('runs before the expensive work, so a limited request costs no hashing', async () => {
    /*
      The limiter is first in the chain deliberately: running it after
      validation would still pay for parsing and, on login, for an Argon2id
      verification — exactly the work an attacker wants to force.

      Asserted by timing: a rejected request must be far faster than the ~50ms
      a real verify costs.
    */
    const email = uniqueEmail();
    for (let i = 0; i < 5; i += 1) {
      await request().post(`${API_PREFIX}/auth/login`).send({ email, password: 'Wrong1Password' });
    }

    const startedAt = process.hrtime.bigint();
    await request().post(`${API_PREFIX}/auth/login`).send({ email, password: 'Wrong1Password' });
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

    expect(durationMs).toBeLessThan(25);
  });
});
