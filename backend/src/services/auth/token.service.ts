import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../../config/index.js';
import type { Actor, User } from '../../domain/entities/user.js';
import {
  TokenExpiredError,
  TokenInvalidError,
  TokenReusedError,
} from '../../domain/errors/index.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { db } from '../../db/pool.js';
import { refreshTokenRepository } from '../../repositories/refresh-token.repository.js';
import { userRepository } from '../../repositories/user.repository.js';

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ALGORITHM = 'HS256';
const ISSUER = 'lumora';
const AUDIENCE = 'lumora-api';

/** The claims Lumora adds beyond the registered JWT set. */
interface AccessClaims {
  email: string;
  emailVerified: boolean;
  tokenVersion: number;
  /** Guards against a future token type being replayed as an access token. */
  typ: 'access';
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  /** The raw refresh token. Goes into a cookie and is never returned in a body. */
  refreshToken: string;
}

export interface SessionContext {
  userAgent: string | null;
  ipAddress: string | null;
}

/**
 * Access-token minting and refresh-token lifecycle.
 *
 * The two halves are deliberately asymmetric (docs/04-data-and-api.md §3.1):
 * the access token is a stateless JWT so the hot path never touches the
 * database, and the refresh token is opaque and server-stored so it *can* be
 * revoked. Making both stateless would leave nothing revocable; making both
 * stateful would put a query on every request.
 */
export const tokenService = {
  async issueAccessToken(user: User): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = env.JWT_ACCESS_TTL_SECONDS;

    const token = await new SignJWT({
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      tokenVersion: user.tokenVersion,
      typ: 'access',
    } satisfies AccessClaims)
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${String(expiresIn)}s`)
      // A unique id per token. Nothing consults it yet; it is what a future
      // deny-list or an audit trail would key on, and it costs 16 bytes.
      .setJti(randomUUID())
      .sign(secret);

    return { token, expiresIn };
  },

  /**
   * Verifies an access token from claims alone — no database round trip.
   *
   * That is the entire justification for a stateless access token, so adding a
   * lookup here would quietly undo the design. `token_version` is enforced at
   * refresh instead: a bumped version means the next refresh fails, and any
   * access token minted before the bump dies on its own within its TTL.
   */
  async verifyAccessToken(token: string): Promise<Actor> {
    try {
      const { payload } = await jwtVerify<AccessClaims>(token, secret, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
      });

      // A refresh or reset token presented here must not authenticate, even if
      // it were somehow signed with the same key.
      if (payload.typ !== 'access') throw new TokenInvalidError();

      if (typeof payload.sub !== 'string') throw new TokenInvalidError();

      return {
        userId: payload.sub,
        email: payload.email,
        emailVerified: payload.emailVerified,
        tokenVersion: payload.tokenVersion,
      };
    } catch (error) {
      // Expiry is separated from every other failure because the client's
      // response differs: refresh and retry, versus sign in again.
      if (error instanceof joseErrors.JWTExpired) throw new TokenExpiredError();
      if (error instanceof TokenInvalidError) throw error;
      throw new TokenInvalidError(error);
    }
  },

  /**
   * Starts a new refresh lineage. Called on signup, login, and after email
   * verification, where fresh claims are needed.
   */
  async startSession(user: User, context: SessionContext): Promise<IssuedSession> {
    const refreshToken = generateOpaqueToken();

    await refreshTokenRepository.issue({
      userId: user.id,
      tokenHash: hashOpaqueToken(refreshToken),
      // A new family per sign-in, so revoking one compromised session does not
      // sign the user out of their other devices.
      familyId: randomUUID(),
      parentId: null,
      expiresAt: refreshExpiry(),
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });

    const access = await this.issueAccessToken(user);
    return { accessToken: access.token, expiresIn: access.expiresIn, refreshToken };
  },

  /**
   * Rotates a refresh token, detecting replay.
   *
   * The whole operation is one transaction, and the presented row is loaded
   * `FOR UPDATE`. Both matter:
   *
   * - **The lock** serializes concurrent refreshes of the same token. Without
   *   it two tabs racing would each see the token live, each rotate, and each
   *   revoke the other's descendant — the user is signed out by their own
   *   browser. The client's single-flight promise (docs/02-frontend.md §6.1) is
   *   the matching half; this is the half that has to be correct when the
   *   client's is not.
   * - **The transaction** means the revoke-old / insert-new pair cannot half
   *   apply. A crash between them would otherwise leave a session with no live
   *   token, or two.
   *
   * A token that is already revoked was captured and replayed: the legitimate
   * client has rotated past it. The response is to revoke the entire family
   * (docs/04-data-and-api.md §3.2).
   */
  async rotate(presentedToken: string, context: SessionContext): Promise<IssuedSession> {
    const presentedHash = hashOpaqueToken(presentedToken);

    /*
      The transaction **returns** a verdict rather than throwing one.

      This is not a style preference; throwing here was a real security bug.
      A rejection propagating out of `db.transaction().execute()` rolls the
      transaction back — including the family revocation performed a line
      earlier. Reuse detection therefore logged the event, answered 401, and
      silently undid the revocation, leaving the attacker's sibling token
      live. The 401 made it look like it had worked.

      Writes that must survive a rejected request have to commit first, so the
      outcome is returned, the transaction commits, and the error is raised
      outside it.
    */
    type RotationOutcome =
      | { kind: 'ok'; session: IssuedSession }
      | { kind: 'unknown' }
      | { kind: 'reused'; userId: string; familyId: string }
      | { kind: 'expired' };

    const outcome = await db.transaction().execute<RotationOutcome>(async (trx) => {
      const existing = await refreshTokenRepository.findByHashForUpdate(presentedHash, trx);

      // Unknown token. Not a replay — there is no family to revoke, and
      // treating garbage as an attack would let anyone sign anyone else out by
      // posting random strings.
      if (!existing) return { kind: 'unknown' };

      if (existing.revokedAt !== null) {
        await refreshTokenRepository.revokeFamily(existing.familyId, 'reuse_detected', trx);
        return { kind: 'reused', userId: existing.userId, familyId: existing.familyId };
      }

      if (existing.expiresAt.getTime() <= Date.now()) {
        await refreshTokenRepository.revoke(existing.id, 'logout', trx);
        return { kind: 'expired' };
      }

      const user = await userRepository.findById(existing.userId, trx);
      // The row cascades on user delete, so this is a torn state rather than a
      // normal one; refuse rather than mint a token for a ghost.
      if (!user) return { kind: 'unknown' };

      /*
        No `token_version` comparison here, deliberately.

        A global sign-out or a password change revokes every refresh row *and*
        bumps the version in one transaction (`revokeAllSessions`). So a row
        that is still live was necessarily issued after the last bump — the
        revoked check above already covers the case, and a second check
        comparing versions would be asserting something the transaction
        guarantees.

        This is the other half of the "revocation without a per-request lookup"
        contract: access tokens minted before a bump die on their own within
        their 15 minutes, and the refresh that would have renewed them is gone.
      */
      await refreshTokenRepository.revoke(existing.id, 'rotated', trx);

      const refreshToken = generateOpaqueToken();
      await refreshTokenRepository.issue(
        {
          userId: user.id,
          tokenHash: hashOpaqueToken(refreshToken),
          // Same family, new link in the chain — this is what makes the
          // lineage traceable when a replay is detected later.
          familyId: existing.familyId,
          parentId: existing.id,
          expiresAt: refreshExpiry(),
          userAgent: context.userAgent,
          ipAddress: context.ipAddress,
        },
        trx,
      );

      const access = await tokenService.issueAccessToken(user);
      return {
        kind: 'ok',
        session: { accessToken: access.token, expiresIn: access.expiresIn, refreshToken },
      };
    });

    // Raised only after the transaction has committed, so the revocations
    // above are durable.
    switch (outcome.kind) {
      case 'ok':
        return outcome.session;
      case 'reused':
        logger.warn(
          { userId: outcome.userId, familyId: outcome.familyId },
          'Refresh token reuse detected — family revoked',
        );
        throw new TokenReusedError();
      case 'expired':
        throw new TokenExpiredError();
      case 'unknown':
        throw new TokenInvalidError();
    }
  },

  /** Ends one session. The other devices keep theirs. */
  async revokeSession(presentedToken: string): Promise<void> {
    const record = await db
      .selectFrom('refresh_tokens')
      .select(['id', 'revoked_at'])
      .where('token_hash', '=', hashOpaqueToken(presentedToken))
      .executeTakeFirst();

    // Logout is idempotent and never reports failure: a client clearing a
    // token it already lost should still end up signed out, and telling a
    // caller whether a token existed is an oracle.
    if (record?.revoked_at === null) {
      await refreshTokenRepository.revoke(record.id, 'logout');
    }
  },

  /**
   * Ends every session and invalidates outstanding access tokens.
   *
   * The version bump is what reaches the stateless half — revoking refresh
   * rows alone would leave up to 15 minutes of usable access tokens.
   */
  async revokeAllSessions(userId: string, reason: 'logout' | 'password_change'): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await refreshTokenRepository.revokeAllForUser(userId, reason, trx);
      await userRepository.incrementTokenVersion(userId, trx);
    });
  },
};

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
