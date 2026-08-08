import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { asCookieHeader } from '../helpers/cookies.js';
import { fakeMailProvider, lastMessageTo, messageCountFor, resetTokenFor } from '../helpers/mail.js';
import {
  TEST_PASSWORD,
  createTestUser,
  lockAccount,
  readLockoutState,
  uniqueEmail,
} from '../factories/user.factory.js';
import { refreshTokensFor, tokenVersionOf } from '../factories/token.factory.js';
import { expectApiError, expectNoContent } from '../utils/contract.js';

const FORGOT = `${API_PREFIX}/auth/forgot-password`;
const RESET = `${API_PREFIX}/auth/reset-password`;
const LOGIN = `${API_PREFIX}/auth/login`;
const NEW_PASSWORD = 'Qw9zRt2mXp5V';

describe('POST /auth/forgot-password', () => {
  it('returns 200 and mails a link for a registered address', async () => {
    const user = await createTestUser();

    await request().post(FORGOT).send({ email: user.email }).expect(200);

    const message = lastMessageTo(user.email, 'Reset your Lumora password');
    expect(message.text).toContain('/reset-password?token=');
  });

  it('returns an identical 200 for an unregistered address, and mails nothing', async () => {
    const ghost = uniqueEmail('ghost');

    const response = await request().post(FORGOT).send({ email: ghost }).expect(200);

    expect(response.body).toEqual({ ok: true });
    expect(messageCountFor(ghost)).toBe(0);
  });

  it('answers identically whether or not the account exists', async () => {
    // Any observable difference — status, body, or a notably different
    // response time — turns this into a membership oracle for an arbitrary
    // address list, which is the most abused endpoint shape in auth.
    const user = await createTestUser();

    const known = await request().post(FORGOT).send({ email: user.email });
    const unknown = await request().post(FORGOT).send({ email: uniqueEmail('ghost') });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it('still returns 200 when mail delivery fails', async () => {
    /*
      Introduced by real SMTP: letting the failure propagate would answer 502
      for a registered address and 200 for an unregistered one — handing back
      the exact oracle this endpoint exists to remove, precisely when the
      provider is degraded and an attacker is most likely to be watching.
    */
    const user = await createTestUser();
    fakeMailProvider.failure = new Error('smtp is down');

    const response = await request().post(FORGOT).send({ email: user.email });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('invalidates a previously issued reset link', async () => {
    const user = await createTestUser();
    await request().post(FORGOT).send({ email: user.email }).expect(200);
    const firstToken = resetTokenFor(user.email);

    await request().post(FORGOT).send({ email: user.email }).expect(200);

    // Otherwise every link ever mailed stays live for its full hour, so
    // recovering an older email is still a working takeover.
    const stale = await request().post(RESET).send({ token: firstToken, password: NEW_PASSWORD });
    expectApiError(stale, 400, ERROR_CODES.INVALID_VERIFICATION_TOKEN);
  });

  it('rejects a malformed address with 422', async () => {
    expectApiError(await request().post(FORGOT).send({ email: 'nope' }), 422, ERROR_CODES.VALIDATION_ERROR);
  });
});

describe('POST /auth/reset-password', () => {
  async function requestReset(email: string): Promise<string> {
    await request().post(FORGOT).send({ email }).expect(200);
    return resetTokenFor(email);
  }

  it('sets the new password and returns 204', async () => {
    const user = await createTestUser();
    const token = await requestReset(user.email);

    expectNoContent(await request().post(RESET).send({ token, password: NEW_PASSWORD }));

    await request().post(LOGIN).send({ email: user.email, password: NEW_PASSWORD }).expect(200);
  });

  it('invalidates the old password', async () => {
    const user = await createTestUser();
    const token = await requestReset(user.email);
    await request().post(RESET).send({ token, password: NEW_PASSWORD }).expect(204);

    const response = await request().post(LOGIN).send({ email: user.email, password: TEST_PASSWORD });
    expectApiError(response, 401, ERROR_CODES.INVALID_CREDENTIALS);
  });

  it('revokes every session and bumps the token version', async () => {
    const user = await createTestUser();
    const versionBefore = await tokenVersionOf(user.id);
    const token = await requestReset(user.email);

    await request().post(RESET).send({ token, password: NEW_PASSWORD }).expect(204);

    expect(await tokenVersionOf(user.id)).toBe(versionBefore + 1);

    const rows = await refreshTokensFor(user.id);
    expect(rows.every((row) => row.revokedReason === 'password_change')).toBe(true);

    await request()
      .post(`${API_PREFIX}/auth/refresh`)
      .set('Cookie', asCookieHeader(user.refreshToken))
      .expect(401);
  });

  it('clears the lockout state, so a locked-out user can recover', async () => {
    const user = await createTestUser();
    await lockAccount(user.id);
    const token = await requestReset(user.email);

    await request().post(RESET).send({ token, password: NEW_PASSWORD }).expect(204);

    const state = await readLockoutState(user.id);
    expect(state.failedLoginCount).toBe(0);
    expect(state.lockedUntil).toBeNull();
  });

  it('notifies the account that the password changed', async () => {
    // The only signal a user gets that their account was taken over by
    // someone with access to their inbox.
    const user = await createTestUser();
    const token = await requestReset(user.email);

    await request().post(RESET).send({ token, password: NEW_PASSWORD }).expect(204);

    const notice = lastMessageTo(user.email, 'Your Lumora password was changed');
    expect(notice.text).toContain('signed out');
  });

  it('still succeeds when the notification email fails to send', async () => {
    // A password that has already changed must not report failure because a
    // courtesy message bounced.
    const user = await createTestUser();
    const token = await requestReset(user.email);
    fakeMailProvider.failure = new Error('smtp is down');

    await request().post(RESET).send({ token, password: NEW_PASSWORD }).expect(204);
    await request().post(LOGIN).send({ email: user.email, password: NEW_PASSWORD }).expect(200);
  });

  it('consumes the token — a second use is rejected', async () => {
    const user = await createTestUser();
    const token = await requestReset(user.email);
    await request().post(RESET).send({ token, password: NEW_PASSWORD }).expect(204);

    const replay = await request().post(RESET).send({ token, password: 'Another1Password' });
    expectApiError(replay, 400, ERROR_CODES.INVALID_VERIFICATION_TOKEN);
  });

  it('rejects an unknown token', async () => {
    const response = await request().post(RESET).send({ token: 'nope', password: NEW_PASSWORD });
    expectApiError(response, 400, ERROR_CODES.INVALID_VERIFICATION_TOKEN);
  });

  it('rejects a verification token presented to the reset endpoint', async () => {
    const user = await createTestUser();
    const { verificationTokenFor } = await import('../helpers/mail.js');

    const response = await request()
      .post(RESET)
      .send({ token: verificationTokenFor(user.email), password: NEW_PASSWORD });

    expectApiError(response, 400, ERROR_CODES.INVALID_VERIFICATION_TOKEN);
  });

  it('enforces the password policy on the new password', async () => {
    const user = await createTestUser();
    const token = await requestReset(user.email);

    const response = await request().post(RESET).send({ token, password: 'weak' });
    expectApiError(response, 422, ERROR_CODES.VALIDATION_ERROR);

    // The token must survive a rejected attempt, or a typo costs a new email.
    await request().post(RESET).send({ token, password: NEW_PASSWORD }).expect(204);
  });
});
