import { EMAIL_VERIFICATION_TTL_MS, PASSWORD_RESET_TTL_MS, env } from '../../config/index.js';
import { RESEND_COOLDOWN_SECONDS } from '@lumora/shared';
import type { VerificationPurpose } from '../../db/schema.js';
import type { User } from '../../domain/entities/user.js';
import { InvalidVerificationTokenError, RateLimitError } from '../../domain/errors/index.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../lib/crypto.js';
import { db } from '../../db/pool.js';
import { verificationTokenRepository } from '../../repositories/verification-token.repository.js';
import { mailProvider } from '../../providers/mail/mail.factory.js';
import {
  passwordResetEmail,
  verificationEmail,
} from '../../providers/mail/templates/auth.templates.js';
import type { Executor } from '../../repositories/user.repository.js';

const TTL_BY_PURPOSE: Record<VerificationPurpose, number> = {
  email_verification: EMAIL_VERIFICATION_TTL_MS,
  password_reset: PASSWORD_RESET_TTL_MS,
};

/**
 * Single-use emailed links, for both verification and password reset.
 *
 * One service because the mechanics are identical — issue a high-entropy
 * secret, store only its hash, consume it exactly once — and a second copy of
 * "consume exactly once" is the copy that gets the race wrong.
 */
export const verificationService = {
  /**
   * Issues a token and returns the raw value.
   *
   * Any outstanding token for the same purpose is consumed first. Without
   * that, every reset link ever mailed stays live for its full hour, so
   * someone who recovers an older email still has a working takeover.
   */
  async issue(user: User, purpose: VerificationPurpose, executor: Executor = db): Promise<string> {
    await verificationTokenRepository.consumePendingForUser(user.id, purpose, executor);

    const token = generateOpaqueToken();
    await verificationTokenRepository.issue(
      {
        userId: user.id,
        tokenHash: hashOpaqueToken(token),
        purpose,
        expiresAt: new Date(Date.now() + TTL_BY_PURPOSE[purpose]),
      },
      executor,
    );

    return token;
  },

  /**
   * Consumes a token and returns the user id it belonged to.
   *
   * Expiry, prior consumption, and an unknown hash all produce the same error.
   * Distinguishing them tells whoever holds a stolen link which state it is
   * in, and the remedy — request a new one — is identical for all three.
   */
  async consume(
    token: string,
    purpose: VerificationPurpose,
    executor: Executor = db,
  ): Promise<string> {
    const record = await verificationTokenRepository.consume(
      hashOpaqueToken(token),
      purpose,
      executor,
    );

    if (!record) throw new InvalidVerificationTokenError();
    return record.userId;
  },

  /**
   * Enforces the resend cooldown on the server.
   *
   * The client shows a 60-second countdown, and that is a courtesy to the
   * user, not a control — anyone can call the endpoint directly. Without this,
   * the resend button is an open relay for mailing arbitrary addresses at
   * whatever rate an attacker likes, which burns sending reputation and is
   * indistinguishable from being used as a spam cannon.
   */
  async assertCooldownElapsed(
    userId: string,
    purpose: VerificationPurpose,
    executor: Executor = db,
  ): Promise<void> {
    const latest = await verificationTokenRepository.findLatestPending(userId, purpose, executor);
    if (!latest) return;

    const elapsedSeconds = (Date.now() - latest.createdAt.getTime()) / 1000;
    if (elapsedSeconds >= RESEND_COOLDOWN_SECONDS) return;

    throw new RateLimitError(Math.ceil(RESEND_COOLDOWN_SECONDS - elapsedSeconds));
  },

  /**
   * Mails a verification link.
   *
   * Sending is awaited rather than fired and forgotten: a failure has to reach
   * the caller, because an account created with no email sent is an account
   * the user cannot verify and will not report as broken — they will just
   * assume the email is slow.
   */
  async sendVerificationEmail(user: User, token: string): Promise<void> {
    const url = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
    await mailProvider.send(
      verificationEmail({
        to: user.email,
        displayName: user.displayName,
        url,
        expiresInHours: EMAIL_VERIFICATION_TTL_MS / (60 * 60 * 1000),
      }),
    );
  },

  async sendPasswordResetEmail(user: User, token: string): Promise<void> {
    const url = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await mailProvider.send(
      passwordResetEmail({
        to: user.email,
        displayName: user.displayName,
        url,
        expiresInMinutes: PASSWORD_RESET_TTL_MS / (60 * 1000),
      }),
    );
  },
};
