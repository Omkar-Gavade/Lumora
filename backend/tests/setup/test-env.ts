/**
 * Maps `TEST_*` variables onto the names `src/config/env.ts` validates, and
 * refuses to run if the target looks like a development database.
 *
 * **This module must not import anything from `src/`.** It runs before the
 * application module graph, and `src/config` reads `process.env` at import
 * time — an import here would load config with the *unmapped* environment and
 * freeze the wrong values for the whole run.
 *
 * The `TEST_` prefix is the point, not ceremony. Without it, a `DATABASE_URL`
 * exported in a developer's shell — or present in CI for a deploy step — is
 * silently inherited, and the first `TRUNCATE users CASCADE` runs against real
 * data. Requiring a differently-named variable means the suite cannot
 * accidentally connect to anything; it has to be told explicitly.
 *
 * Exported as a function rather than run on import because two entry points
 * need it: the Vitest `setupFile` (per test file) and `global-setup` (once,
 * before any worker exists).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Minimal `.env` reader.
 *
 * dotenv would work, but it is a `src` dependency and this module is
 * deliberately dependency-free so nothing can pull `src/config` in ahead of
 * the mapping. The format is trivial: `KEY=value`, `#` comments, optional
 * surrounding quotes.
 */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    values[line.slice(0, separator).trim()] = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return values;
}

/** `TEST_X` → `X`. The left column is what a developer sets. */
const MAPPINGS: [source: string, target: string][] = [
  ['TEST_DATABASE_URL', 'DATABASE_URL'],
  ['TEST_JWT_ACCESS_SECRET', 'JWT_ACCESS_SECRET'],
  ['TEST_MAIL_DRIVER', 'MAIL_DRIVER'],
  ['TEST_LOG_LEVEL', 'LOG_LEVEL'],
  ['TEST_APP_URL', 'APP_URL'],
  ['TEST_CORS_ORIGINS', 'CORS_ORIGINS'],
];

function fail(message: string): never {
  throw new Error(`[test env] ${message}`);
}

/**
 * Extracts the database name, so the guards compare targets rather than whole
 * URLs — the same database reached as `localhost` and as `127.0.0.1` is still
 * the same database.
 */
function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    fail(`not a valid connection string: ${url}`);
  }
}

/**
 * Marks the mapping as done, in the *environment* rather than in a module
 * variable.
 *
 * A module flag is not enough: `global-setup` runs in Vitest's main process
 * and the tests run in forked workers, which inherit `process.env` but not
 * module state. Without a sentinel the worker re-runs the guards — and by then
 * `DATABASE_URL` has legitimately been set to the test database, so the
 * "these must differ" check fires on the mapping's own output and every test
 * file fails with a conflict that does not exist.
 */
const SENTINEL = 'LUMORA_TEST_ENV_LOADED';

export function loadTestEnv(): void {
  // Idempotent across both module reloads and process boundaries.
  if (process.env[SENTINEL] === '1') return;

  const fileValues = readEnvFile(join(packageRoot, '.env.test'));

  /** Real environment wins, so CI can override without editing the file. */
  const fromTestEnv = (key: string): string | undefined => process.env[key] ?? fileValues[key];

  const testDatabaseUrl = fromTestEnv('TEST_DATABASE_URL');
  if (!testDatabaseUrl) {
    fail(
      'TEST_DATABASE_URL is not set. Copy backend/.env.test.example to backend/.env.test.\n' +
        'The suite refuses to fall back to DATABASE_URL — that is how a test run ends up truncating a development database.',
    );
  }

  const testDatabaseName = databaseNameOf(testDatabaseUrl);

  /*
    Two independent guards, because either alone has a hole.

    The name check catches the common mistake of copying the development URL.
    The equality check catches the case where someone genuinely named their
    development database `lumora_test` — unlikely, but the failure mode is
    destroying real data, so it is worth two lines.
  */
  if (!/(^|_)test$/.test(testDatabaseName)) {
    fail(
      `refusing to run: the test database is named "${testDatabaseName}", which does not end in "_test".\n` +
        'The suite truncates tables between tests; the name is the last line of defence.',
    );
  }

  const developmentDatabaseUrl = process.env.DATABASE_URL;
  if (developmentDatabaseUrl && databaseNameOf(developmentDatabaseUrl) === testDatabaseName) {
    fail(
      `refusing to run: TEST_DATABASE_URL points at "${testDatabaseName}", the same database as DATABASE_URL.`,
    );
  }

  for (const [source, target] of MAPPINGS) {
    const value = fromTestEnv(source);
    if (value !== undefined) process.env[target] = value;
  }

  /*
    Forced, not mapped. These are the same in every test environment, and a run
    that reaches a real provider is a run that is not deterministic — the
    breach check in particular would make signup tests depend on a third
    party's uptime.
  */
/*
  Supplied here rather than left to `backend/.env`, because `global-setup`
  runs migrations in a *child process* that inherits only what is set on
  `process.env`. On a developer machine the file fills these in and the gap is
  invisible; in CI there is no `.env`, the child refuses to start, and the
  whole suite fails with "CORS_ORIGINS: expected string, received undefined" —
  a configuration error wearing the costume of a test failure.

  Values are deliberately inert: nothing in the suite sends mail or serves a
  browser request, so these only have to satisfy the schema.
*/
process.env.APP_URL ??= 'http://localhost:5173';
process.env.CORS_ORIGINS ??= 'http://localhost:5173';
  process.env.NODE_ENV = 'test';
  process.env.MAIL_DRIVER ??= 'console';
  process.env.PASSWORD_BREACH_CHECK = 'false';

  /*
    No background worker in the suite.

    A poller claiming jobs on its own one-second schedule turns every queue
    assertion into a race: a test that enqueues a job and then asserts it is
    `pending` fails whenever the loop happens to get there first. Tests drive
    the worker explicitly via `runOnce`/`drain`, which is also the only way to
    observe claim, heartbeat, failure, and dead-lettering in isolation.
  */
  process.env.WORKER_ENABLED = 'false';

  /*
    Deterministic providers, forced rather than mapped.

    The fake embedding provider returns the same vector for the same text on
    every run, which is what lets a test assert that re-running the pipeline
    writes the *same* vectors rather than merely writing some. A real provider
    would make the suite cost money, depend on a third party's uptime, and be
    unable to express idempotency at all.

    The fake vector store is in-memory for the same reason: ingestion must be
    verifiable without a second service running.
  */
  process.env.EMBEDDING_PROVIDER = 'fake';
  process.env.VECTOR_STORE = 'fake';
  /*
    The chat provider too. A suite that called a real model would cost money
    per run, depend on a third party's uptime, and produce a different answer
    every time — which makes citation mapping, budgeting, and persistence
    unassertable.
  */
  process.env.LLM_PROVIDER = 'fake';

  // Last, so a throw above leaves the sentinel unset and the next process
  // re-runs the guards rather than inheriting a half-applied environment.
  process.env[SENTINEL] = '1';
}
