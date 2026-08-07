import type { PoolConfig } from 'pg';
import { env } from './env.js';
import { PACKAGE_MANIFEST } from '../lib/paths.js';

/**
 * Connection pool configuration.
 *
 * Separated from the pool itself so the shape of the configuration is
 * reviewable without reading connection-lifecycle code, and so a test can
 * build a pool with an overridden value without reaching into `db/pool.ts`.
 */
export const databaseConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,

  /**
   * Return idle connections after 30s. Postgres charges a backend process per
   * connection whether or not it is doing anything, and a pool that never
   * shrinks holds that cost through every quiet period.
   */
  idleTimeoutMillis: 30_000,

  /**
   * Fail a checkout after 10s rather than queueing forever. An unbounded wait
   * turns a saturated pool into a pile of requests that all time out at the
   * client instead of one that fails fast and says why.
   */
  connectionTimeoutMillis: 10_000,

  /**
   * Retire connections after 7500 uses. Guards against a slow leak in a
   * server-side session (prepared statements, temp tables) accumulating for
   * the lifetime of the process.
   */
  maxUses: 7_500,

  /**
   * Surfaces in `pg_stat_activity`, so a connection holding a lock can be
   * traced back to this service rather than showing up as an anonymous client.
   */
  application_name: PACKAGE_MANIFEST.name,
};
