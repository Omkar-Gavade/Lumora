import { sql } from 'kysely';
import { closeDatabase, db } from '../../src/db/pool.js';
import type { DB } from '../../src/db/schema.js';
import type { Transaction } from 'kysely';

/**
 * Tables the suite owns, in no particular order — `CASCADE` handles the
 * dependency graph, and listing children explicitly would go stale the moment
 * a foreign key is added.
 *
 * `schema_migrations` is deliberately absent: truncating it would make the
 * next run re-apply every migration against a schema that already has them.
 */
const OWNED_TABLES = ['users'] as const;

/**
 * Wipes application data between tests.
 *
 * **This is a documented deviation.** docs/03-backend.md §9 specifies "each
 * test wrapped in a transaction rolled back afterward, so tests are isolated
 * without truncation between them". That works — and `withTransaction` below
 * implements it — for anything where the executor can be injected.
 *
 * It cannot work for a supertest flow. The request runs through the real
 * Express app into the module-level `db` pool, on a different connection from
 * the one the test would have opened; the transaction would be invisible to
 * the code under test, and rolling it back would roll back nothing. Making it
 * work needs an `AsyncLocalStorage`-backed executor in production code, which
 * is changing production to suit tests.
 *
 * Truncation is the honest alternative, and the docs' objection to it was
 * cost. On one table with a cascade to two children and a few rows, `TRUNCATE`
 * is sub-millisecond — it deallocates pages rather than scanning rows. The
 * cost the doc was avoiding is not present at this size.
 *
 * `RESTART IDENTITY` is omitted because every primary key is a uuidv7; there
 * are no sequences to reset.
 */
export async function resetDatabase(): Promise<void> {
  await sql.raw(`TRUNCATE TABLE ${OWNED_TABLES.join(', ')} CASCADE`).execute(db);
}

/**
 * Runs a callback inside a transaction that is **always** rolled back — the
 * isolation strategy docs/03-backend.md §9 specifies.
 *
 * Use it for repository and service tests, where the `Executor` parameter can
 * be threaded through. Nothing it writes survives, so tests leave no residue
 * and need no cleanup of their own.
 *
 * The rollback is forced by throwing a sentinel: Kysely commits on a normal
 * return, and there is no "commit: never" option. The sentinel is caught here
 * so the test sees the callback's value rather than an error.
 */
class RollbackSignal<T> extends Error {
  constructor(readonly result: T) {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}

export async function withTransaction<T>(
  callback: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  try {
    await db.transaction().execute(async (trx) => {
      // The callback's value rides out on the signal, so there is no mutable
      // binding to assert is populated afterwards.
      throw new RollbackSignal(await callback(trx));
    });
  } catch (error) {
    if (error instanceof RollbackSignal) return error.result as T;
    throw error;
  }

  // Unreachable: the transaction body always throws.
  throw new Error('withTransaction: transaction committed unexpectedly');
}

/** Row counts, for asserting that a flow wrote what it claimed to. */
export async function countRows(table: 'users' | 'refresh_tokens' | 'verification_tokens'): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();

  return row.count;
}

/** Closes the pool so Vitest can exit. */
export async function closeTestDatabase(): Promise<void> {
  await closeDatabase();
}

export { db };
