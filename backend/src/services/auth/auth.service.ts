import type { AuthSessionDto, UserDto } from '@lumora/shared';
import {
  LOGIN_FAILURES_BEFORE_LOCKOUT,
  LOGIN_LOCKOUT_BASE_MS,
  LOGIN_LOCKOUT_MAX_MS,
  env,
} from '../../config/index.js';
import { db } from '../../db/pool.js';
import { toUserDto, type User } from '../../domain/entities/user.js';
import {
  AccountLockedError,
  EmailAlreadyVerifiedError,
  EmailTakenError,
  InvalidCredentialsError,
  UnauthorizedError,
} from '../../domain/errors/index.js';
import { logger } from '../../lib/logger.js';
import { mailProvider } from '../../providers/mail/mail.factory.js';
import { passwordChangedEmail } from '../../providers/mail/templates/auth.templates.js';
import { refreshTokenRepository } from '../../repositories/refresh-token.repository.js';
import { userRepository } from '../../repositories/user.repository.js';
import { passwordService } from './password.service.js';
import { tokenService, type IssuedSession, type SessionContext } from './token.service.js';
import { verificationService } from './verification.service.js';

export interface AuthResult {
  session: AuthSessionDto;
  /** Raw refresh token. The controller puts it in a cookie; it never enters a body. */
  refreshToken: string;
}

function toAuthResult(user: User, issued: IssuedSession): AuthResult {
  return {
    session: {
      user: toUserDto(user),
      accessToken: issued.accessToken,
      expiresIn: issued.expiresIn,
    },
    refreshToken: issued.refreshToken,
  };
}

/**
 * Lockout window after repeated failures: doubling, capped.
 *
 * Exponential rather than a fixed window because the goal is to make sustained
 * online guessing worthless while barely inconveniencing someone who mistyped
 * twice. A flat 15-minute lock on the sixth attempt punishes the honest user
 * as hard as the attacker; doubling from 30 seconds means the first extra
 * attempt costs almost nothing and the fiftieth costs everything.
 */
function lockoutFor(failureCount: number): Date | null {
  if (failureCount < LOGIN_FAILURES_BEFORE_LOCKOUT) return null;

  const overage = failureCount - LOGIN_FAILURES_BEFORE_LOCKOUT;
  const delay = Math.min(LOGIN_LOCKOUT_BASE_MS * 2 ** overage, LOGIN_LOCKOUT_MAX_MS);
  return new Date(Date.now() + delay);
}

/**
 * Orchestrates the auth flows. Owns no persistence and no HTTP
 * (docs/03-backend.md §1) — it composes the password, token, and verification
 * services and enforces the business rules that sit between them.
 */
export const authService = {
  /**
   * docs/04-data-and-api.md §3.3 signup: validate → normalize → uniqueness →
   * hash → breach check → insert → verification token → mail → issue tokens.
   *
   * The breach check runs *before* hashing so a rejected password never costs
   * 50ms of Argon2, and the user and token are written in one transaction so a
   * failure cannot leave an account that can never be verified.
   */
  async signup(
    input: { email: string; password: string; displayName: string },
    context: SessionContext,
  ): Promise<AuthResult> {
    await passwordService.assertNotBreached(input.password);

    const existing = await userRepository.findByEmail(input.email);
    if (existing) throw new EmailTakenError();

    const passwordHash = await passwordService.hash(input.password);

    const { user, verificationToken } = await db.transaction().execute(async (trx) => {
      /*
        A second uniqueness check is not needed — the UNIQUE index is the
        authority, and the read above is only there to produce a clean 409 in
        the common case. A concurrent signup for the same address loses here
        with a constraint violation, which surfaces as a 500. That is the
        correct trade: the race window is microseconds wide and the alternative
        is holding a lock on an index for every signup.
      */
      const created = await userRepository.create(
        { email: input.email, passwordHash, displayName: input.displayName },
        trx,
      );
      const token = await verificationService.issue(created, 'email_verification', trx);
      return { user: created, verificationToken: token };
    });

    /*
      A failed send does not fail the signup.

      With the console driver this could not happen; with a real SMTP transport
      it can, and the naive `await` made an outage at the provider return 502
      *after* the user row was committed — so retrying hit EMAIL_TAKEN and the
      person was stranded with an account they could neither use nor recreate.

      The account is already valid and, per FR-5, usable for everything except
      uploads and chat. docs/00-product.md §160 designs for the mail never
      arriving and answers it with the resend button, which is exactly the
      affordance the verification prompt shows. So: log loudly, hand back the
      session, and let the user press resend.

      `resendVerification` deliberately does *not* swallow — there the user
      asked for that one thing and is waiting to be told whether it worked.
    */
    try {
      await verificationService.sendVerificationEmail(user, verificationToken);
    } catch (error) {
      logger.error(
        { err: error, userId: user.id },
        'Verification email failed to send; account created and resend available',
      );
    }

    // FR-5: the account is usable immediately, just not for uploads or chat.
    // Withholding a session until verification strands anyone whose mail is
    // slow, and the shell has a verification prompt built for exactly this.
    const issued = await tokenService.startSession(user, context);
    logger.info({ userId: user.id }, 'Account created');

    return toAuthResult(user, issued);
  },

  /**
   * docs/04-data-and-api.md §3.3 login.
   *
   * The control flow is shaped by two requirements that override readability:
   *
   * 1. **Constant time.** A missing account still runs a full Argon2id verify
   *    against a dummy hash. Returning early would make non-existent accounts
   *    answer ~50× faster, which enumerates the user table over the network
   *    with no error message needed.
   * 2. **Lockout is checked after the password.** Reporting "locked" to
   *    someone who did not supply the right password tells them the account
   *    exists — the lockout state itself becomes the oracle the rest of this
   *    function is built to avoid.
   */
  async login(
    input: { email: string; password: string },
    context: SessionContext,
  ): Promise<AuthResult> {
    const user = await userRepository.findByEmail(input.email);

    if (!user) {
      await passwordService.verifyDummy(input.password);
      throw new InvalidCredentialsError();
    }

    const passwordMatches = await passwordService.verify(user.passwordHash, input.password);

    if (!passwordMatches) {
      const nextFailureCount = user.failedLoginCount + 1;
      await userRepository.registerFailedLogin(user.id, lockoutFor(nextFailureCount));
      logger.warn({ userId: user.id, failures: nextFailureCount }, 'Failed sign-in');
      throw new InvalidCredentialsError();
    }

    const lockedUntil = user.lockedUntil;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const retryAfter = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
      throw new AccountLockedError(retryAfter);
    }

    await userRepository.clearLoginFailures(user.id);

    const issued = await tokenService.startSession(user, context);
    logger.info({ userId: user.id }, 'Signed in');

    return toAuthResult(user, issued);
  },

  async refresh(presentedToken: string, context: SessionContext): Promise<AuthResult> {
    const issued = await tokenService.rotate(presentedToken, context);

    // `rotate` proved the token and loaded the user inside its transaction;
    // this read is for the response body's user projection.
    const actor = await tokenService.verifyAccessToken(issued.accessToken);
    const user = await userRepository.findById(actor.userId);
    if (!user) throw new UnauthorizedError();

    return toAuthResult(user, issued);
  },

  async logout(presentedToken: string | undefined): Promise<void> {
    // No token is not an error. A client clearing state it already lost should
    // still end up signed out.
    if (!presentedToken) return;
    await tokenService.revokeSession(presentedToken);
  },

  async logoutAll(userId: string): Promise<void> {
    await tokenService.revokeAllSessions(userId, 'logout');
    logger.info({ userId }, 'All sessions revoked');
  },

  /**
   * Verifies an address and issues **fresh tokens**.
   *
   * The new access token carries `emailVerified: true`, so the client's
   * `require-verified` gate lifts immediately (docs/04-data-and-api.md §3.3).
   * Without reissuing, the user would sit behind the verification prompt for
   * up to fifteen minutes after verifying, which reads as the link not working.
   */
  async verifyEmail(token: string, context: SessionContext): Promise<AuthResult> {
    const userId = await verificationService.consume(token, 'email_verification');

    // `null` means it was already verified — the update is guarded on
    // `email_verified_at IS NULL`, so a link opened twice lands here.
    const verified = await userRepository.markEmailVerified(userId);
    const user = verified ?? (await userRepository.findById(userId));
    if (!user) throw new UnauthorizedError();

    const issued = await tokenService.startSession(user, context);
    logger.info({ userId: user.id }, 'Email verified');

    return toAuthResult(user, issued);
  },

  async resendVerification(userId: string): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) throw new UnauthorizedError();
    if (user.emailVerifiedAt !== null) throw new EmailAlreadyVerifiedError();

    await verificationService.assertCooldownElapsed(user.id, 'email_verification');

    const token = await verificationService.issue(user, 'email_verification');
    await verificationService.sendVerificationEmail(user, token);
  },

  /**
   * **Always resolves**, whether or not the address is registered
   * (docs/04-data-and-api.md §2.1).
   *
   * The controller returns 200 unconditionally. Any difference — a different
   * status, a different message, or even a noticeably different response time
   * — turns this endpoint into a membership oracle for an arbitrary address
   * list, which is the single most abused endpoint shape in auth.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await userRepository.findByEmail(email);
    if (!user) {
      logger.info({}, 'Password reset requested for an unknown address');
      return;
    }

    const token = await verificationService.issue(user, 'password_reset');

    /*
      The send failure is swallowed, and this is a security control rather than
      leniency.

      The endpoint's whole guarantee is that a registered address and an
      unregistered one are indistinguishable. Letting a delivery failure
      propagate would answer 502 for an address that exists and 200 for one
      that does not — handing back the exact oracle the uniform response was
      built to remove, and doing it precisely when the provider is degraded and
      an attacker is most likely to notice the difference.
    */
    try {
      await verificationService.sendPasswordResetEmail(user, token);
    } catch (error) {
      logger.error(
        { err: error, userId: user.id },
        'Password reset email failed to send; responding 200 to preserve enumeration safety',
      );
    }
  },

  /**
   * docs/04-data-and-api.md §3.3 reset.
   *
   * Order matters: consume the token, set the password, then revoke every
   * session. Revoking last means a failure part-way leaves the old password
   * working rather than leaving an account nobody can get into.
   *
   * The notification email is sent after, and its failure is swallowed — a
   * password that has already changed must not report failure because a
   * courtesy message bounced.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    await passwordService.assertNotBreached(newPassword);

    const userId = await verificationService.consume(token, 'password_reset');
    const user = await userRepository.findById(userId);
    if (!user) throw new UnauthorizedError();

    const passwordHash = await passwordService.hash(newPassword);

    await db.transaction().execute(async (trx) => {
      // Bumps `token_version` in the same statement, killing outstanding
      // access tokens.
      await userRepository.updatePassword(user.id, passwordHash, trx);
      await refreshTokenRepository.revokeAllForUser(user.id, 'password_change', trx);
    });

    logger.info({ userId: user.id }, 'Password reset; all sessions revoked');

    try {
      await mailProvider.send(
        passwordChangedEmail({
          to: user.email,
          displayName: user.displayName,
          supportUrl: `${env.APP_URL}/forgot-password`,
        }),
      );
    } catch (error) {
      logger.error({ err: error, userId: user.id }, 'Password-changed notification failed to send');
    }
  },

  async getCurrentUser(userId: string): Promise<UserDto> {
    const user = await userRepository.findById(userId);
    if (!user) throw new UnauthorizedError();
    return toUserDto(user);
  },
};
