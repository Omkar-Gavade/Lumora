import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { refreshCookie } from '../helpers/cookies.js';
import { fakeMailProvider, lastMessageTo, messageCountFor } from '../helpers/mail.js';
import { countRows, db } from '../helpers/database.js';
import { TEST_PASSWORD, uniqueEmail } from '../factories/user.factory.js';
import { expectApiError } from '../utils/contract.js';

const SIGNUP = `${API_PREFIX}/auth/signup`;

describe('POST /auth/signup', () => {
  it('creates the account, issues a session, and returns 201', async () => {
    const email = uniqueEmail();

    const response = await request()
      .post(SIGNUP)
      .send({ displayName: 'Omkar Gavade', email, password: TEST_PASSWORD })
      .expect(201);

    expect(response.body.user).toMatchObject({
      email,
      displayName: 'Omkar Gavade',
      // FR-5: the account is usable immediately; only uploads and chat wait.
      emailVerified: false,
    });
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.expiresIn).toBe(900);
    expect(await countRows('users')).toBe(1);
  });

  it('never returns the refresh token in the body — it exists only in the cookie', async () => {
    const response = await request()
      .post(SIGNUP)
      .send({ displayName: 'A', email: uniqueEmail(), password: TEST_PASSWORD })
      .expect(201);

    expect(JSON.stringify(response.body)).not.toContain('refreshToken');
    expect(refreshCookie(response)?.value).toBeTruthy();
  });

  it('never returns password material', async () => {
    const response = await request()
      .post(SIGNUP)
      .send({ displayName: 'A', email: uniqueEmail(), password: TEST_PASSWORD })
      .expect(201);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenVersion');
  });

  it('stores an argon2id hash, never the password', async () => {
    const email = uniqueEmail();
    await request()
      .post(SIGNUP)
      .send({ displayName: 'A', email, password: TEST_PASSWORD })
      .expect(201);

    const row = await db
      .selectFrom('users')
      .select('password_hash')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();

    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(TEST_PASSWORD);
  });

  it('sends exactly one verification email carrying a usable link', async () => {
    const email = uniqueEmail();
    await request()
      .post(SIGNUP)
      .send({ displayName: 'A', email, password: TEST_PASSWORD })
      .expect(201);

    expect(messageCountFor(email)).toBe(1);

    const message = lastMessageTo(email, 'Verify your Lumora email address');
    // Both parts, always — a message with no text part scores as spam.
    expect(message.text).toContain('/verify-email?token=');
    expect(message.html).toContain('/verify-email?token=');
  });

  it('normalizes the email to lowercase and trims it', async () => {
    const response = await request()
      .post(SIGNUP)
      .send({ displayName: 'A', email: '  MiXeD.Case@Example.COM  ', password: TEST_PASSWORD })
      .expect(201);

    expect(response.body.user.email).toBe('mixed.case@example.com');
  });

  it('rejects a duplicate address with 409 CONFLICT semantics', async () => {
    const email = uniqueEmail();
    await request()
      .post(SIGNUP)
      .send({ displayName: 'A', email, password: TEST_PASSWORD })
      .expect(201);

    const response = await request()
      .post(SIGNUP)
      .send({ displayName: 'B', email, password: TEST_PASSWORD });

    expectApiError(response, 409, ERROR_CODES.EMAIL_TAKEN);
    expect(await countRows('users')).toBe(1);
  });

  it('treats a differently-cased duplicate as the same account', async () => {
    const email = uniqueEmail();
    await request()
      .post(SIGNUP)
      .send({ displayName: 'A', email, password: TEST_PASSWORD })
      .expect(201);

    const response = await request()
      .post(SIGNUP)
      .send({ displayName: 'B', email: email.toUpperCase(), password: TEST_PASSWORD });

    expectApiError(response, 409, ERROR_CODES.EMAIL_TAKEN);
  });

  describe('validation', () => {
    it('reports every invalid field at once with 422', async () => {
      const response = await request()
        .post(SIGNUP)
        .send({ displayName: '', email: 'not-an-email', password: 'short' });

      expectApiError(response, 422, ERROR_CODES.VALIDATION_ERROR);

      const paths = response.body.error.details.fields.map((f: { path: string }) => f.path);
      expect(paths).toContain('displayName');
      expect(paths).toContain('email');
      expect(paths).toContain('password');
    });

    it.each([
      ['too short', 'Ab1cdefghij'],
      ['no uppercase', 'zt7qlmvx4kdw'],
      ['no digit', 'ZtqQLmVxKdwZ'],
    ])('rejects a password that is %s', async (_label, password) => {
      const response = await request()
        .post(SIGNUP)
        .send({ displayName: 'A', email: uniqueEmail(), password });

      expectApiError(response, 422, ERROR_CODES.VALIDATION_ERROR);
      expect(await countRows('users')).toBe(0);
    });

    it('strips unknown keys rather than trusting them', async () => {
      const email = uniqueEmail();
      const response = await request().post(SIGNUP).send({
        displayName: 'A',
        email,
        password: TEST_PASSWORD,
        // Mass-assignment attempt: none of these may reach the insert.
        tokenVersion: 99,
        emailVerifiedAt: new Date().toISOString(),
        id: '00000000-0000-0000-0000-000000000000',
      });

      expect(response.status).toBe(201);
      expect(response.body.user.emailVerified).toBe(false);
      expect(response.body.user.id).not.toBe('00000000-0000-0000-0000-000000000000');

      const row = await db
        .selectFrom('users')
        .select('token_version')
        .where('email', '=', email)
        .executeTakeFirstOrThrow();
      expect(row.token_version).toBe(0);
    });

    it('rejects a malformed JSON body as 400, not 500', async () => {
      const response = await request()
        .post(SIGNUP)
        .set('Content-Type', 'application/json')
        .send('{"displayName":');

      expectApiError(response, 400, ERROR_CODES.BAD_REQUEST);
    });
  });

  describe('when mail delivery fails', () => {
    it('still creates the account and returns 201', async () => {
      // Introduced by real SMTP: a provider outage previously made signup 502
      // *after* the row was committed, so retrying hit EMAIL_TAKEN and the
      // user was stranded with an account they could neither use nor recreate.
      fakeMailProvider.failure = new Error('smtp is down');
      const email = uniqueEmail();

      const response = await request()
        .post(SIGNUP)
        .send({ displayName: 'A', email, password: TEST_PASSWORD });

      expect(response.status).toBe(201);
      expect(await countRows('users')).toBe(1);
      expect(messageCountFor(email)).toBe(0);
    });
  });
});
