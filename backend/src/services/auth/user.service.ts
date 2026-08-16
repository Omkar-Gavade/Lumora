import type { UserDto } from '@lumora/shared';
import { db } from '../../db/pool.js';
import { env } from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { UnauthorizedError, ValidationError } from '../../domain/errors/index.js';
import { mailProvider } from '../../providers/mail/mail.factory.js';
import { passwordChangedEmail } from '../../providers/mail/templates/auth.templates.js';
import { refreshTokenRepository } from '../../repositories/refresh-token.repository.js';
import { userRepository } from '../../repositories/user.repository.js';
import { toUserDto } from '../../domain/entities/user.js';
import { passwordService } from './password.service.js';

/**
 * Account self-service (docs/04-data-and-api.md §2.2).
 *
 * Separate from `auth.service.ts` deliberately. Authentication is about
 * *establishing* identity — signup, login, refresh, reset — and every one of
 * those methods is reachable without being signed in. Everything here operates
 * on an already-authenticated actor and mutates the account itself. Merging
 * them would put the unauthenticated and authenticated surfaces in one file
 * and make "is this endpoint public?" a question you answer by reading rather
 * than by location.
 */
export const userService = {
  async getProfile(userId: string): Promise<UserDto> {
    const user = await userRepository.findById(userId);
    // The access token verified, so the row must exist. If it does not, the
    // account was deleted mid-session and the token outlived its subject.
    if (!user) throw new UnauthorizedError();
    return toUserDto(user);
  },

  /**
   * Updates the profile. Display name only.
   *
   * docs/00-product.md FR-34: "Profile: display name, email (read-only in
   * Phase 1), change password." Email is deliberately not editable here — it is
   * the login identifier and the verification anchor, so changing it needs a
   * re-verification flow that Phase 1 does not have. Accepting it silently and
   * ignoring it would be worse than rejecting it.
   */
  async updateProfile(userId: string, displayName: string): Promise<UserDto> {
    const updated = await userRepository.updateDisplayName(userId, displayName);
    if (!updated) throw new UnauthorizedError();

    logger.info({ userId }, 'Profile updated');
    return toUserDto(updated);
  },

  /**
   * Changes the password (docs §2.2: "requires current password, revokes other
   * sessions").
   *
   * The current-password check is what makes this different from a reset: a
   * reset proves control of the mailbox, this proves knowledge of the existing
   * credential. Without it, an unattended logged-in browser is a full account
   * takeover rather than a session hijack.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) throw new UnauthorizedError();

    if (!(await passwordService.verify(user.passwordHash, currentPassword))) {
      /*
        `UnauthorizedError`, not a validation error on the field. The caller is
        authenticated, so this is a failed credential check rather than a
        malformed request — and 401 keeps it in the same bucket as every other
        wrong-password outcome in the system.
      */
      throw new UnauthorizedError('Your current password is incorrect.');
    }

    /*
      Breach-checked, like signup and reset. The check runs *after* the current
      password is verified so an attacker with a session cannot use this
      endpoint as a free breach oracle for arbitrary strings.
    */
    await passwordService.assertNotBreached(newPassword);

    if (await passwordService.verify(user.passwordHash, newPassword)) {
      throw new ValidationError('Your new password must be different from your current one.');
    }

    const passwordHash = await passwordService.hash(newPassword);

    await db.transaction().execute(async (trx) => {
      // `updatePassword` bumps `token_version` in the same statement, which is
      // what kills outstanding *access* tokens — they are self-contained and
      // cannot be revoked individually.
      await userRepository.updatePassword(userId, passwordHash, trx);
      await refreshTokenRepository.revokeAllForUser(userId, 'password_change', trx);
    });

    logger.info({ userId }, 'Password changed; all sessions revoked');

    /*
      Notification is best-effort and never fails the change.

      Its purpose is detection, not delivery: a user who did not do this needs
      to find out. Rolling back a completed password change because SMTP was
      briefly down would leave the account on the credential the user was
      trying to replace.
    */
    try {
      await mailProvider.send(
        passwordChangedEmail({
          to: user.email,
          displayName: user.displayName,
          supportUrl: `${env.APP_URL}/forgot-password`,
        }),
      );
    } catch (error) {
      logger.error({ err: error, userId }, 'Password-changed notification failed to send');
    }
  },

  /**
   * Deletes the account (docs §2.2: "requires password, cascades everything";
   * FR-36: "cascades to all documents, vectors, conversations").
   *
   * Password-gated for the same reason the change is: an unattended session
   * must not be able to destroy the account.
   */
  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) throw new UnauthorizedError();

    if (!(await passwordService.verify(user.passwordHash, password))) {
      throw new UnauthorizedError('That password is incorrect.');
    }

    /*
      Vectors first, then the row.

      Chroma is not in the database transaction and cannot be rolled back, so
      the ordering decides which way an interrupted delete fails. Dropping the
      collection first can leave a live account whose vectors are gone — which
      is visible, recoverable by reindexing, and fails safe. The reverse leaves
      orphaned vectors for a user who no longer exists, with nothing left in
      Postgres to identify them by: an unreachable copy of deleted content,
      which is the outcome FR-36 exists to prevent.
    */
    await deleteUserVectors(userId);

    // Postgres cascades documents, chunks, conversations, messages, citations,
    // jobs, and refresh tokens via the FKs declared in the migrations. The
    // cascade is the documented policy; re-deleting each table here would be a
    // second, divergent definition of what "everything" means.
    await userRepository.deleteById(userId);

    logger.info({ userId }, 'Account deleted');
  },
};

/**
 * Drops the user's vector collection.
 *
 * Failures are logged and swallowed: a Chroma outage must not leave a user
 * unable to delete their account, and the collection is per-user and
 * unreachable once the row is gone. The residue is an operational cleanup
 * problem, not a privacy one that blocking would solve.
 */
async function deleteUserVectors(userId: string): Promise<void> {
  const { vectorStore } = await import('../../providers/vector/vector.factory.js');
  const { collectionFor } = await import('../../providers/vector/vector-store.interface.js');

  try {
    await vectorStore.deleteCollection(collectionFor(userId, env.CHROMA_COLLECTION_PREFIX));
  } catch (error) {
    logger.error({ err: error, userId }, 'Vector collection delete failed during account deletion');
  }
}
