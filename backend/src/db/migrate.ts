import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { closeDatabase, db } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Forward-only migration runner (docs/04-data-and-api.md §1.2).
 *
 * **No down-migrations.** In practice they are written once, never executed,
 * never tested, and give false confidence at the exact moment confidence
 * matters. Rolling back means writing a new forward migration — which is a
 * change you can review, test, and apply the same way as every other.
 *
 * Files are `NNNN_name.sql`, applied in numeric order, each inside its own
 * transaction. Per-file transactions rather than one big one: a failure leaves
 * every migration before it applied and recorded, so a re-run resumes instead
 * of replaying work that already succeeded.
 */

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/**
 * Namespace for the advisory lock. Arbitrary but fixed — any two processes
 * using this runner must agree on it, and nothing else in Postgres may reuse
 * it. Advisory locks are held for the session and released automatically if
 * the connection dies, so a killed runner cannot leave the lock stuck.
 */
const MIGRATION_LOCK_ID = 4_812_055;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

interface MigrationFile {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);

  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const filename of files) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new Error(
        `Migration "${filename}" does not match NNNN_lower_snake_case.sql. ` +
          'Ordering depends on the numeric prefix, so an unparseable name is a hard error.',
      );
    }

    const [, version, name] = match;
    // The regex guarantees both groups, but `noUncheckedIndexedAccess` does
    // not know that.
    if (version === undefined || name === undefined) continue;

    const content = await readFile(new URL(filename, MIGRATIONS_DIR), 'utf8');
    migrations.push({
      version,
      name,
      checksum: createHash('sha256').update(content).digest('hex'),
      sql: content,
    });
  }

  const duplicate = migrations.find(
    (migration, index) => migrations.findIndex((m) => m.version === migration.version) !== index,
  );
  if (duplicate) {
    throw new Error(`Duplicate migration version ${duplicate.version}.`);
  }

  return migrations;
}

/**
 * Created by the runner, not by a migration — a migrations table cannot be
 * bootstrapped by the mechanism that reads it.
 */
async function ensureMigrationsTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}

async function readApplied(): Promise<Map<string, { name: string; checksum: string }>> {
  const rows = await db
    .selectFrom('schema_migrations')
    .select(['version', 'name', 'checksum'])
    .orderBy('version')
    .execute();

  return new Map(rows.map((row) => [row.version, { name: row.name, checksum: row.checksum }]));
}

/**
 * An applied migration whose file has since changed means the database and the
 * repository disagree about what was run — and every environment applied a
 * different thing. Refusing here is the whole reason the checksum is stored.
 */
function assertUnchanged(
  migrations: MigrationFile[],
  applied: Map<string, { name: string; checksum: string }>,
): void {
  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (record && record.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.version}_${migration.name} has been modified since it was applied. ` +
          'Applied migrations are immutable — add a new forward migration instead.',
      );
    }
  }
}

async function up(): Promise<void> {
  await ensureMigrationsTable();

  /*
    Serialize runners. Two deployments starting at once would otherwise both
    read the same pending list and both try to apply it; the second fails
    somewhere mid-file, having partially duplicated the first. The lock is
    taken after the table exists so that `CREATE TABLE IF NOT EXISTS` is the
    only unserialized statement, and it is idempotent.
  */
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`.execute(db);

  try {
    const migrations = await loadMigrations();
    const applied = await readApplied();
    assertUnchanged(migrations, applied);

    const pending = migrations.filter((migration) => !applied.has(migration.version));

    if (pending.length === 0) {
      logger.info({ applied: applied.size }, 'No pending migrations');
      return;
    }

    logger.info({ pending: pending.length }, 'Applying migrations');

    for (const migration of pending) {
      const startedAt = process.hrtime.bigint();

      await db.transaction().execute(async (trx) => {
        // The file is repository content, not user input — `sql.raw` is the
        // only way to execute arbitrary DDL, and parameterizing DDL is not a
        // thing Postgres supports.
        await sql.raw(migration.sql).execute(trx);

        await trx
          .insertInto('schema_migrations')
          .values({
            version: migration.version,
            name: migration.name,
            checksum: migration.checksum,
            duration_ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
          })
          .execute();
      });

      logger.info(
        {
          version: migration.version,
          migration: migration.name,
          durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        },
        'Migration applied',
      );
    }

    logger.info({ count: pending.length }, 'Migrations complete');
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`.execute(db);
  }
}

async function status(): Promise<void> {
  await ensureMigrationsTable();

  const migrations = await loadMigrations();
  const applied = await readApplied();

  for (const migration of migrations) {
    const record = applied.get(migration.version);
    const state = !record
      ? 'pending'
      : record.checksum === migration.checksum
        ? 'applied'
        : 'MODIFIED';
    logger.info(
      { version: migration.version, migration: migration.name, state },
      'Migration status',
    );
  }

  const orphaned = [...applied.keys()].filter(
    (version) => !migrations.some((migration) => migration.version === version),
  );
  if (orphaned.length > 0) {
    // Recorded but no longer on disk: someone deleted a migration file. The
    // database still carries its effects.
    logger.warn({ versions: orphaned }, 'Applied migrations have no file on disk');
  }
}

const COMMANDS = { up, status } as const;
type Command = keyof typeof COMMANDS;

function isCommand(value: string): value is Command {
  return value in COMMANDS;
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? 'up';

  if (!isCommand(requested)) {
    throw new Error(
      `Unknown command "${requested}". Expected one of: ${Object.keys(COMMANDS).join(', ')}.`,
    );
  }

  try {
    await COMMANDS[requested]();
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Migration run failed');
  // Non-zero so a deploy pipeline stops here rather than starting a service
  // against a schema that is not what the code expects.
  process.exitCode = 1;
});
