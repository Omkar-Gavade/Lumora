import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { authenticatedRequest } from '../helpers/auth.js';
import { messageCountFor, verificationTokenFor } from '../helpers/mail.js';
import { createTestUser, createVerifiedUser } from '../factories/user.factory.js';
import { expectApiError, expectNoContent } from '../utils/contract.js';
import { backdateVerificationTokens } from '../factories/token.factory.js';
import { db } from '../helpers/database.js';

const VERIFY = `${API_PREFIX}/auth/verify-email`;
const RESEND = `${API_PREFIX}/auth/resend-verification`;

describe('POST /auth/verify-email', () => {
  it('verifies the address and reissues tokens carrying the updated claim', async () => {
    const user = await createTestUser();
    const token = verificationTokenFor(user.email);

    const response = await request().post(VERIFY).send({ token }).expect(200);

    expect(response.body.user.emailVerified).toBe(true);

    /*
      The reissue is the point (docs/04-data-and-api.md §3.3). Without it the
      client sits behind the verification prompt until its old access token
      expires — up to fifteen minutes — which reads as the link not working.
    */
    expect(response.body.accessToken).not.toBe(user.session.accessToken);

    const me = await authenticatedRequest(response.body.accessToken).get('/auth/me').expect(200);
    expect(me.body.emailVerified).toBe(true);
  });

  it('records the verification timestamp', async () => {
    const user = await createTestUser();
    await request().post(VERIFY).send({ token: verificationTokenFor(user.email) }).expect(200);

    const row = await db
      .selectFrom('users')
      .select('email_verified_at')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();

    expect(row.email_verified_at).toBeInstanceOf(Date);
  });

  it('consumes the token — a second use is rejected', async () => {
    const user = await createTestUser();
    const token = verificationTokenFor(user.email);

    await request().post(VERIFY).send({ token }).expect(200);

    const replay = await request().post(VERIFY).send({ token });
    expectApiError(replay, 400, ERROR_CODES.INVALID_VERIFICATION_TOKEN);
  });

  it('rejects an unknown token with the same error as a consumed one', async () => {
    // One error for expired, consumed, and unknown. Distinguishing them tells
    // whoever holds a stolen link which state it is in, and the remedy —
    // request a new one — is identical for all three.
    const response = await request().post(VERIFY).send({ token: 'not-a-real-token' });
    expectApiError(response, 400, ERROR_CODES.INVALID_VERIFICATION_TOKEN);
  });

  it('rejects a password-reset token presented to the verification endpoint', async () => {
    const user = await createTestUser();
    await request().post(`${API_PREFIX}/auth/forgot-password`).send({ email: user.email }).expect(200);

    // Both purposes share a table; the purpose column is what keeps a reset
    // link from verifying an address.
    const { resetTokenFor } = await import('../helpers/mail.js');
    const response = await request().post(VERIFY).send({ token: resetTokenFor(user.email) });

    expectApiError(response, 400, ERROR_CODES.INVALID_VERIFICATION_TOKEN);
  });

  it('rejects a missing token with 422', async () => {
    const response = await request().post(VERIFY).send({});
    expectApiError(response, 422, ERROR_CODES.VALIDATION_ERROR);
  });
});

describe('POST /auth/resend-verification', () => {
  it('requires authentication', async () => {
    const response = await request().post(RESEND);
    expectApiError(response, 401, ERROR_CODES.UNAUTHORIZED);
  });

  it('sends another email and returns 204', async () => {
    const user = await createTestUser();
    expect(messageCountFor(user.email)).toBe(1);

    // The signup email started the cooldown, so move the issued token's clock
    // back rather than sleeping — a sleep-based test is a slow flaky test.
    await backdateVerificationTokens(user.id, 120_000);

    const response = await authenticatedRequest(user.session.accessToken).post('/auth/resend-verification');

    expectNoContent(response);
    expect(messageCountFor(user.email)).toBe(2);
  });

  it('enforces the 60-second cooldown on the server, not just in the UI', async () => {
    const user = await createTestUser();

    // The signup email was issued moments ago, so the cooldown is live.
    const response = await authenticatedRequest(user.session.accessToken).post('/auth/resend-verification');

    expectApiError(response, 429, ERROR_CODES.RATE_LIMITED);
    expect(response.headers['retry-after']).toBeTruthy();
    expect(messageCountFor(user.email)).toBe(1);
  });

  it('invalidates the previous token when a new one is issued', async () => {
    const user = await createTestUser();
    const firstToken = verificationTokenFor(user.email);

    await backdateVerificationTokens(user.id, 120_000);

    await authenticatedRequest(user.session.accessToken).post('/auth/resend-verification').expect(204);

    // Otherwise every link ever mailed stays live for its full TTL.
    const stale = await request().post(VERIFY).send({ token: firstToken });
    expectApiError(stale, 400, ERROR_CODES.INVALID_VERIFICATION_TOKEN);
  });

  it('refuses to resend for an already-verified address', async () => {
    const user = await createVerifiedUser();

    const response = await authenticatedRequest(user.session.accessToken).post('/auth/resend-verification');
    expectApiError(response, 409, ERROR_CODES.EMAIL_ALREADY_VERIFIED);
  });
});
