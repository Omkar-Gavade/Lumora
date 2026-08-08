import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import { env } from '../../src/config/index.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../src/lib/crypto.js';
import { refreshTokenRepository } from '../../src/repositories/refresh-token.repository.js';
import { db } from '../helpers/database.js';
import type { RevokedReason } from '../../src/db/schema.js';

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

/**
 * Mints an access token with arbitrary claims and lifetime.
 *
 * Signed with the **real** secret and the real issuer/audience, so tokens the
 * factory produces are indistinguishable from production ones except in the
 * single dimension a test is varying. A hand-rolled fake JWT would be rejected
 * by signature and every test would pass for the wrong reason.
 */
export async function createAccessToken(options: {
  userId?: string;
  email?: string;
  emailVerified?: boolean;
  tokenVersion?: number;
  /** Seconds from now. Negative produces an already-expired token. */
  expiresInSeconds?: number;
  /** Overrides `typ`, for the "a refresh token must not authenticate" case. */
  typ?: string;
  /** Signs with the wrong key, for the tampered-token case. */
  wrongSecret?: boolean;
  issuer?: string;
  audience?: string;
} = {}): Promise<string> {
  const expiresInSeconds = options.expiresInSeconds ?? 900;
  const issuedAt = Math.floor(Date.now() / 1000);

  return new SignJWT({
    email: options.email ?? 'someone@example.com',
    emailVerified: options.emailVerified ?? true,
    tokenVersion: options.tokenVersion ?? 0,
    typ: options.typ ?? 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(options.userId ?? randomUUID())
    .setIssuer(options.issuer ?? 'lumora')
    .setAudience(options.audience ?? 'lumora-api')
    .setIssuedAt(issuedAt)
    // Absolute rather than relative, so a negative value yields a token that
    // is already expired at the moment it is created — no waiting, no timers.
    .setExpirationTime(issuedAt + expiresInSeconds)
    .setJti(randomUUID())
    .sign(options.wrongSecret ? new TextEncoder().encode('a'.repeat(48)) : secret);
}

/** An access token that expired a minute ago. */
export function createExpiredToken(userId: string, email: string): Promise<string> {
  return createAccessToken({ userId, email, expiresInSeconds: -60 });
}

export interface SeededRefreshToken {
  /** The raw value, as it would appear in the cookie. */
  token: string;
  id: string;
  familyId: string;
}

/**
 * Writes a refresh token row directly, with full control over expiry,
 * revocation, and family.
 *
 * The one place a direct insert is right: these are states the API cannot be
 * driven into within a test. An expired refresh token would need a 30-day
 * wait, and a token belonging to an unrelated family cannot be produced by
 * rotating a real one. Everything else still goes through the public API.
 */
export async function createRefreshToken(options: {
  userId: string;
  familyId?: string;
  parentId?: string | null;
  /** Seconds from now. Negative produces an already-expired token. */
  expiresInSeconds?: number;
  revokedReason?: RevokedReason;
}): Promise<SeededRefreshToken> {
  const token = generateOpaqueToken();
  const familyId = options.familyId ?? randomUUID();

  const record = await refreshTokenRepository.issue({
    userId: options.userId,
    tokenHash: hashOpaqueToken(token),
    familyId,
    parentId: options.parentId ?? null,
    expiresAt: new Date(Date.now() + (options.expiresInSeconds ?? 30 * 24 * 3600) * 1000),
    userAgent: 'vitest',
    ipAddress: '127.0.0.1',
  });

  if (options.revokedReason) {
    await refreshTokenRepository.revoke(record.id, options.revokedReason, db);
  }

  return { token, id: record.id, familyId };
}

/** An already-expired refresh token. */
export function createExpiredRefreshToken(userId: string): Promise<SeededRefreshToken> {
  return createRefreshToken({ userId, expiresInSeconds: -60 });
}

/** Every refresh row for a user, so revocation can be asserted on. */
export async function refreshTokensFor(
  userId: string,
): Promise<{ id: string; familyId: string; revokedReason: RevokedReason | null }[]> {
  const rows = await db
    .selectFrom('refresh_tokens')
    .select(['id', 'family_id', 'revoked_reason'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    familyId: row.family_id,
    revokedReason: row.revoked_reason,
  }));
}

/**
 * Moves a verification token's `created_at` backwards, to simulate elapsed
 * time without sleeping.
 *
 * Raw SQL because the column is typed `never` on update — `created_at` is
 * immutable by design, and loosening the schema so a test could write to it
 * would weaken production types to suit the suite. Reaching around it here,
 * once, in a clearly-named helper, is the smaller cost.
 *
 * The alternative is a 60-second sleep per cooldown test, which is how a
 * suite stops being run.
 */
export async function backdateVerificationTokens(userId: string, byMs: number): Promise<void> {
  const when = new Date(Date.now() - byMs).toISOString();
  await sql`
    UPDATE verification_tokens
    SET created_at = ${when}::timestamptz
    WHERE user_id = ${userId}::uuid
  `.execute(db);
}

/** Current `token_version`, for asserting that a global sign-out bumped it. */
export async function tokenVersionOf(userId: string): Promise<number> {
  const row = await db
    .selectFrom('users')
    .select('token_version')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();

  return row.token_version;
}
