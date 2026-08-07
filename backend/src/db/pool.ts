import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { databaseConfig, READINESS_TIMEOUT_MS } from '../config/index.js';
import { logger } from '../lib/logger.js';
import type { DB } from './schema.js';

/**
 * `pg` types every `BIGINT` as a string by default, because a 64-bit integer
 * does not fit in a JavaScript number. That default is right — but it means
 * `COUNT(*)` comes back as `"3"`, and `size_bytes` arrives as a string.
 *
 * Parsed to `number` here for the two types where Lumora's values are provably
 * inside `Number.MAX_SAFE_INTEGER` (9 petabytes): row counts and byte sizes.
 * `cost_micros` (docs/04-data-and-api.md §1.1) stays a string when it arrives
 * in M3 — integer money is exactly the case where silent precision loss is
 * unacceptable, and its column type is declared accordingly.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export const pool = new pg.Pool(databaseConfig);

/**
 * A pool error is emitted for *idle* clients — a connection dropped by the
 * server, a network blip, a database restart. Without a listener, `pg` treats
 * it as an unhandled `error` event and takes the process down. The pool
 * recovers on its own; the correct response is to record it, not to die.
 */
pool.on('error', (error) => {
  logger.error({ err: error }, 'Idle database client errored');
});

/**
 * The query builder. Everything that touches Postgres goes through this —
 * Kysely makes string concatenation awkward by design, which is most of why
 * parameterization is not something anyone has to remember
 * (docs/04-data-and-api.md §4).
 */
export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

export interface DatabaseHealth {
  ok: boolean;
  latencyMs: number;
  message?: string;
}

/** A short, non-revealing summary of a failure, always non-empty. */
function describe(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'connection failed';
}

/**
 * The readiness probe's database check.
 *
 * `SELECT 1` and nothing more: the question is "can this process get a
 * connection and get an answer", and any real query would also be testing
 * whatever that query touches. It is raced against a timeout because a probe
 * that hangs is a probe that never reports — the failure mode it exists to
 * catch is precisely the one where the database accepts the connection and
 * then never responds.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${String(READINESS_TIMEOUT_MS)}ms`)),
        READINESS_TIMEOUT_MS,
      );
    });

    await Promise.race([sql`select 1`.execute(db), timeout]);
    return { ok: true, latencyMs: elapsedMs() };
  } catch (error) {
    // The real error goes to the log; the probe response gets a short,
    // non-revealing summary. A readiness endpoint is usually unauthenticated.
    logger.error({ err: error }, 'Database health check failed');
    return {
      ok: false,
      latencyMs: elapsedMs(),
      // A connection severed by the server surfaces as an Error with an empty
      // message, which would put `"message":""` in the probe response — a field
      // that is present, useless, and looks like a bug in the probe.
      message: describe(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies connectivity at boot.
 *
 * Called by `server.ts` before it listens, so a database misconfiguration
 * shows up as a process that refuses to start with a clear reason — not as a
 * healthy-looking service that 500s on its first real request.
 */
export async function connectDatabase(): Promise<void> {
  const health = await checkDatabaseHealth();
  if (!health.ok) {
    throw new Error(`Database is unreachable: ${health.message ?? 'unknown error'}`);
  }
  logger.info({ latencyMs: health.latencyMs, poolMax: databaseConfig.max }, 'Database connected');
}

/** Closes every pooled connection. Part of graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  await db.destroy();
  logger.info({}, 'Database pool closed');
}
