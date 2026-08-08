import { describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { tokenService } from '../../src/services/auth/token.service.js';
import { TokenExpiredError, TokenInvalidError } from '../../src/domain/errors/index.js';
import { createAccessToken } from '../factories/token.factory.js';
import type { User } from '../../src/domain/entities/user.js';

/**
 * The stateless half of the token service — no database, so it lives in the
 * unit project. Rotation and reuse detection need real rows and are covered in
 * `integration/auth-refresh.test.ts`.
 */
const user: User = {
  id: '019fdf6b-e260-782c-907d-0e984539dffc',
  email: 'omkar@example.com',
  passwordHash: '$argon2id$irrelevant',
  displayName: 'Omkar Gavade',
  emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  tokenVersion: 3,
  failedLoginCount: 0,
  lockedUntil: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('issueAccessToken', () => {
  it('signs the documented claim set', async () => {
    const { token, expiresIn } = await tokenService.issueAccessToken(user);
    const claims = decodeJwt(token);

    // docs/04-data-and-api.md §3.1.
    expect(claims.sub).toBe(user.id);
    expect(claims.email).toBe(user.email);
    expect(claims.emailVerified).toBe(true);
    expect(claims.tokenVersion).toBe(3);
    expect(claims.typ).toBe('access');
    expect(claims.iss).toBe('lumora');
    expect(claims.aud).toBe('lumora-api');
    expect(claims.jti).toEqual(expect.any(String));
    expect(expiresIn).toBe(900);
  });

  it('expires in fifteen minutes — the lifetime *is* the revocation window', async () => {
    const { token } = await tokenService.issueAccessToken(user);
    const claims = decodeJwt(token);

    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(900);
  });

  it('reports an unverified address as unverified', async () => {
    const { token } = await tokenService.issueAccessToken({ ...user, emailVerifiedAt: null });
    expect(decodeJwt(token).emailVerified).toBe(false);
  });

  it('carries no password material', async () => {
    const { token } = await tokenService.issueAccessToken(user);
    const claims = decodeJwt(token);

    // A JWT is signed, not encrypted — anyone holding it can read every claim.
    expect(JSON.stringify(claims)).not.toContain('argon2');
    expect(claims).not.toHaveProperty('passwordHash');
  });

  it('gives every token a unique id', async () => {
    const [first, second] = await Promise.all([
      tokenService.issueAccessToken(user),
      tokenService.issueAccessToken(user),
    ]);

    expect(decodeJwt(first.token).jti).not.toBe(decodeJwt(second.token).jti);
  });
});

describe('verifyAccessToken', () => {
  it('returns the actor for a valid token', async () => {
    const { token } = await tokenService.issueAccessToken(user);

    await expect(tokenService.verifyAccessToken(token)).resolves.toEqual({
      userId: user.id,
      email: user.email,
      emailVerified: true,
      tokenVersion: 3,
    });
  });

  it('rejects an expired token with a distinct error', async () => {
    // Expiry is separated from every other failure because the client's
    // response differs: refresh and retry, versus sign in again.
    const token = await createAccessToken({ expiresInSeconds: -60 });
    await expect(tokenService.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('rejects a token signed with the wrong key', async () => {
    const token = await createAccessToken({ wrongSecret: true });
    await expect(tokenService.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it('rejects a token of the wrong type', async () => {
    const token = await createAccessToken({ typ: 'refresh' });
    await expect(tokenService.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it.each([
    ['a foreign issuer', { issuer: 'evil' }],
    ['a foreign audience', { audience: 'other-api' }],
  ])('rejects %s', async (_label, overrides) => {
    const token = await createAccessToken(overrides);
    await expect(tokenService.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it.each([['garbage'], [''], ['a.b.c']])('rejects the malformed token %j', async (token) => {
    await expect(tokenService.verifyAccessToken(token)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it('rejects a token whose payload was edited', async () => {
    // The signature is what makes the claims trustworthy; editing the payload
    // and re-encoding must not survive verification.
    const { token } = await tokenService.issueAccessToken({ ...user, emailVerifiedAt: null });
    const [header, payload, signature] = token.split('.');

    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<string, unknown>;
    claims.emailVerified = true;
    const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

    await expect(
      tokenService.verifyAccessToken(`${header ?? ''}.${forged}.${signature ?? ''}`),
    ).rejects.toBeInstanceOf(TokenInvalidError);
  });
});
