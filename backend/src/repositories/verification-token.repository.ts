import type { Selectable } from 'kysely';
import type { VerificationPurpose, VerificationTokensTable } from '../db/schema.js';
import { db } from '../db/pool.js';
import type { Executor } from './user.repository.js';

export interface VerificationTokenRecord {
  id: string;
  userId: string;
  purpose: VerificationPurpose;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

function toRecord(row: Selectable<VerificationTokensTable>): VerificationTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

/**
 * SQL for `verification_tokens` — email verification and password reset share
 * one table because they share one mechanism: a hashed single-use secret with
 * a TTL. Two tables would be two copies of the same consume-once logic, and
 * the second copy is the one that gets it wrong.
 */
export const verificationTokenRepository = {
  async issue(
    input: {
      userId: string;
      tokenHash: string;
      purpose: VerificationPurpose;
      expiresAt: Date;
    },
    executor: Executor = db,
  ): Promise<VerificationTokenRecord> {
    const row = await executor
      .insertInto('verification_tokens')
      .values({
        user_id: input.userId,
        token_hash: input.tokenHash,
        purpose: input.purpose,
        expires_at: input.expiresAt.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toRecord(row);
  },

  /**
   * Consumes a token in a single atomic statement.
   *
   * **This is a conditional UPDATE … RETURNING, not a read-then-write, and the
   * difference is the whole security property** (docs/04-data-and-api.md
   * §3.3). Reading the row, checking `consumed_at`, then updating leaves a
   * window in which two concurrent requests both read `null` and both proceed
   * — a reset link usable twice. Making the `is null` check part of the write
   * means Postgres serializes it: exactly one caller gets a row back, and
   * everyone else gets nothing.
   *
   * Expiry is checked in the same statement for the same reason.
   */
  async consume(
    tokenHash: string,
    purpose: VerificationPurpose,
    executor: Executor = db,
  ): Promise<VerificationTokenRecord | null> {
    const now = new Date();

    const row = await executor
      .updateTable('verification_tokens')
      // The column's insert type is a string and its select type is a Date, so
      // the two sides of this statement are written differently on purpose.
      .set({ consumed_at: now.toISOString() })
      .where('token_hash', '=', tokenHash)
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', now)
      .returningAll()
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  },

  /**
   * Invalidates outstanding tokens for one purpose before issuing a new one.
   *
   * Requesting a second reset link must kill the first: otherwise every link
   * ever mailed stays live for its full hour, and an attacker who obtains an
   * old one still has a working account takeover.
   */
  async consumePendingForUser(
    userId: string,
    purpose: VerificationPurpose,
    executor: Executor = db,
  ): Promise<number> {
    const result = await executor
      .updateTable('verification_tokens')
      .set({ consumed_at: new Date().toISOString() })
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  },

  /**
   * The most recent unconsumed token for a purpose, used to enforce the resend
   * cooldown server-side. The client's countdown is a courtesy; this is the
   * control.
   */
  async findLatestPending(
    userId: string,
    purpose: VerificationPurpose,
    executor: Executor = db,
  ): Promise<VerificationTokenRecord | null> {
    const row = await executor
      .selectFrom('verification_tokens')
      .selectAll()
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  },
};
