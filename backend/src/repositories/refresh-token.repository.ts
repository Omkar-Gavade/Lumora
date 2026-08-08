import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { RefreshTokensTable, RevokedReason } from '../db/schema.js';
import { db } from '../db/pool.js';
import type { Executor } from './user.repository.js';

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  parentId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: RevokedReason | null;
  createdAt: Date;
}

function toRecord(row: Selectable<RefreshTokensTable>): RefreshTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    parentId: row.parent_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    createdAt: row.created_at,
  };
}

export interface IssueRefreshTokenInput {
  userId: string;
  tokenHash: string;
  familyId: string;
  parentId: string | null;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}

/**
 * SQL for `refresh_tokens`.
 *
 * The table is append-only in practice: rotation inserts a new row and revokes
 * the old one rather than mutating it. That history is what makes reuse
 * detection possible at all — a token that was deleted on rotation cannot
 * later be recognized as a replay, only as "unknown", which is
 * indistinguishable from garbage and triggers no family revocation.
 */
export const refreshTokenRepository = {
  async issue(input: IssueRefreshTokenInput, executor: Executor = db): Promise<RefreshTokenRecord> {
    const row = await executor
      .insertInto('refresh_tokens')
      .values({
        user_id: input.userId,
        token_hash: input.tokenHash,
        family_id: input.familyId,
        parent_id: input.parentId,
        expires_at: input.expiresAt.toISOString(),
        user_agent: input.userAgent,
        ip_address: input.ipAddress,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toRecord(row);
  },

  /**
   * Loads a token by hash **and takes a row lock**.
   *
   * `FOR UPDATE` is the whole reason this exists separately from a plain read.
   * Two refreshes arriving together with the same token would otherwise both
   * see it unrevoked, both rotate, and cross-revoke each other's descendants —
   * the user is signed out by their own tab (docs/04-data-and-api.md §3.2).
   * The lock serializes them, so the second sees the first's revocation and is
   * correctly treated as a replay.
   *
   * Must be called inside a transaction; a lock taken outside one is released
   * immediately and buys nothing.
   */
  async findByHashForUpdate(
    tokenHash: string,
    executor: Executor,
  ): Promise<RefreshTokenRecord | null> {
    const row = await executor
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  },

  /**
   * Revokes one token, and only if it is still live.
   *
   * The `is null` guard makes this a conditional update rather than a
   * read-then-write, so a concurrent revocation cannot be overwritten with a
   * different reason — `reuse_detected` must never be downgraded to `rotated`.
   */
  async revoke(id: string, reason: RevokedReason, executor: Executor = db): Promise<void> {
    await executor
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();
  },

  /**
   * Revokes an entire rotation lineage — the response to a detected replay.
   *
   * Every descendant dies, including the one the legitimate client is holding.
   * That is intended: once a token has demonstrably leaked, there is no way to
   * tell the thief's branch from the owner's, so both re-authenticate.
   */
  async revokeFamily(
    familyId: string,
    reason: RevokedReason,
    executor: Executor = db,
  ): Promise<number> {
    const result = await executor
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  },

  /** Every live session for a user — sign-out-everywhere and password change. */
  async revokeAllForUser(
    userId: string,
    reason: RevokedReason,
    executor: Executor = db,
  ): Promise<number> {
    const result = await executor
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  },

  /**
   * Deletes rows that are long past use.
   *
   * Retained well beyond expiry on purpose: a replay of a token that expired
   * yesterday should still be recognizable as a replay, not as an unknown
   * token. Deleting on expiry would blind reuse detection exactly when an
   * attacker is most likely to try a stale capture.
   */
  async deleteExpiredBefore(cutoff: Date, executor: Executor = db): Promise<number> {
    const result = await executor
      .deleteFrom('refresh_tokens')
      .where('expires_at', '<', sql<Date>`${cutoff.toISOString()}::timestamptz`)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  },
};
