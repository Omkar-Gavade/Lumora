import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadTestEnv } from './test-env.js';

const run = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Runs **once** before the whole suite: creates the test database if it is
 * missing, then migrates it.
 *
 * Once, not per file, because migrations are the slowest part of standing the
 * suite up and the schema is identical for every test. Per-file migration
 * would also have several workers racing the same advisory lock, which turns a
 * 200ms step into a serialized queue.
 *
 * Creating the database automatically is what makes `npm test` work on a clean
 * checkout with no manual step — a suite that requires a README ritual before
 * it runs is a suite that stops being run.
 */

function connectionParts(url: string): { adminUrl: string; databaseName: string } {
  const parsed = new URL(url);
  const databaseName = parsed.pathname.replace(/^\//, '');

  // `postgres` is guaranteed to exist and is not the database being created,
  // so it is safe to connect to while issuing CREATE DATABASE.
  parsed.pathname = '/postgres';
  return { adminUrl: parsed.toString(), databaseName };
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const { adminUrl, databaseName } = connectionParts(url);
  const admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      /*
        CREATE DATABASE cannot be parameterized — Postgres does not accept a
        bind parameter for an identifier. The name is quoted instead, and it
        came from a URL the suite already refused to run unless it ended in
        `_test`, so it is not attacker-controlled.
      */
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

export async function setup(): Promise<void> {
  // Runs in Vitest's own context, before any worker and therefore before the
  // `setupFiles` mapping — so the guards and `.env.test` read have to happen
  // here too. `loadTestEnv` is idempotent.
  loadTestEnv();

  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('[global-setup] TEST_DATABASE_URL is not set. See backend/.env.test.example.');
  }

  await ensureDatabaseExists(url);

  // The migration runner in a child process with DATABASE_URL pointed at the
  // test database. Running it in-process would import `src/config` here and
  // pin the wrong environment for everything that follows.
  await run('npx', ['tsx', 'src/db/migrate.ts', 'up'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  });
}
