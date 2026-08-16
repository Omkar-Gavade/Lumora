import type { Insertable, Selectable, Transaction } from 'kysely';
import type { DB, UsersTable } from '../db/schema.js';
import { db } from '../db/pool.js';
import type { User } from '../domain/entities/user.js';

/** Either the pool or an open transaction. Lets any query join a caller's unit of work. */
export type Executor = typeof db | Transaction<DB>;

/**
 * Row → domain. The only place `snake_case` becomes `camelCase`, so a column
 * rename is one edit rather than a search across every service.
 */
function toUser(row: Selectable<UsersTable>): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    emailVerifiedAt: row.email_verified_at,
    tokenVersion: row.token_version,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName: string;
}

/**
 * SQL for the `users` table, and nothing else — no business rules, no HTTP
 * concepts (docs/03-backend.md §1).
 *
 * `users` is the one table with no owner to scope by: it *is* the owner. Every
 * table added after this one takes `userId` in its signatures, so an ownership
 * check cannot be forgotten by the next endpoint.
 */
export const userRepository = {
  async findByEmail(email: string, executor: Executor = db): Promise<User | null> {
    // The column is CITEXT, so this comparison is case-insensitive in the
    // database and does not depend on the caller having normalized first.
    const row = await executor
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();

    return row ? toUser(row) : null;
  },

  async findById(id: string, executor: Executor = db): Promise<User | null> {
    const row = await executor
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? toUser(row) : null;
  },

  async create(input: CreateUserInput, executor: Executor = db): Promise<User> {
    const values: Insertable<UsersTable> = {
      email: input.email,
      password_hash: input.passwordHash,
      display_name: input.displayName,
    };

    const row = await executor
      .insertInto('users')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();

    return toUser(row);
  },

  /**
   * Marks the address verified, and only if it is not already.
   *
   * The `is null` guard makes this idempotent: a link clicked twice, or opened
   * by an email scanner and then by the user, does not move `email_verified_at`
   * forward. Returning the row lets the caller tell "verified now" from
   * "already verified" without a second read.
   */
  async markEmailVerified(userId: string, executor: Executor = db): Promise<User | null> {
    const row = await executor
      .updateTable('users')
      .set({ email_verified_at: new Date().toISOString() })
      .where('id', '=', userId)
      .where('email_verified_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row ? toUser(row) : null;
  },

  /**
   * Sets a new password and bumps `token_version` in one statement.
   *
   * Together, atomically: the bump is what kills access tokens issued before
   * the change, and a password updated without it leaves a window where the
   * old credentials are gone but tokens minted from them still work
   * (docs/04-data-and-api.md §3.3).
   */
  async updatePassword(
    userId: string,
    passwordHash: string,
    executor: Executor = db,
  ): Promise<void> {
    await executor
      .updateTable('users')
      .set((eb) => ({
        password_hash: passwordHash,
        token_version: eb('token_version', '+', 1),
        failed_login_count: 0,
        locked_until: null,
      }))
      .where('id', '=', userId)
      .execute();
  },

  /**
   * Updates the display name (docs/00-product.md FR-34).
   *
   * Returns `null` when no row matched, so a caller cannot mistake "the account
   * is gone" for a successful no-op.
   */
  async updateDisplayName(
    userId: string,
    displayName: string,
    executor: Executor = db,
  ): Promise<User | null> {
    const row = await executor
      .updateTable('users')
      .set({ display_name: displayName })
      .where('id', '=', userId)
      .returningAll()
      .executeTakeFirst();

    return row ? toUser(row) : null;
  },

  /**
   * Hard-deletes the account (FR-36: "cascades to all documents, vectors,
   * conversations").
   *
   * A real DELETE rather than a soft-delete flag. A `deleted_at` column would
   * mean every query in the system has to remember to exclude it, and the one
   * that forgets serves a deleted user's documents. The cascade is declared on
   * the foreign keys, so the database enforces "everything" rather than a list
   * maintained by hand here.
   */
  async deleteById(userId: string, executor: Executor = db): Promise<void> {
    await executor.deleteFrom('users').where('id', '=', userId).execute();
  },

  /** Global sign-out: invalidates every outstanding access token at once. */
  async incrementTokenVersion(userId: string, executor: Executor = db): Promise<number> {
    const row = await executor
      .updateTable('users')
      .set((eb) => ({ token_version: eb('token_version', '+', 1) }))
      .where('id', '=', userId)
      .returning('token_version')
      .executeTakeFirstOrThrow();

    return row.token_version;
  },

  /**
   * Records a failed sign-in and applies the lockout window.
   *
   * The counter is incremented in SQL rather than read-modify-written in the
   * service: concurrent attempts against the same account would otherwise both
   * read the same value and write the same increment, so five parallel guesses
   * would count as one.
   */
  async registerFailedLogin(
    userId: string,
    lockedUntil: Date | null,
    executor: Executor = db,
  ): Promise<void> {
    await executor
      .updateTable('users')
      .set((eb) => ({
        failed_login_count: eb('failed_login_count', '+', 1),
        locked_until: lockedUntil ? lockedUntil.toISOString() : null,
      }))
      .where('id', '=', userId)
      .execute();
  },

  /** Clears the lockout state after a successful sign-in. */
  async clearLoginFailures(userId: string, executor: Executor = db): Promise<void> {
    await executor
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null })
      .where('id', '=', userId)
      // Skips a write on the overwhelmingly common case of a clean account.
      .where((eb) => eb.or([eb('failed_login_count', '>', 0), eb('locked_until', 'is not', null)]))
      .execute();
  },
};
