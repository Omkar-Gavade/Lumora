import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolConfig } from 'pg';
import { env } from './env.js';
import { PACKAGE_ROOT, PACKAGE_MANIFEST } from '../lib/paths.js';

/**
 * TLS for the database connection.
 *
 * Supabase runs a **private** CA: the pooler's certificate chains to
 * "Supabase Root 2021 CA", which is self-signed and in no public trust store,
 * so Node rejects it with `self-signed certificate in certificate chain`. The
 * tempting fixes are both wrong — `NODE_TLS_REJECT_UNAUTHORIZED=0` disables
 * verification for the *entire process*, including the Gemini calls, and
 * `rejectUnauthorized: false` encrypts without authenticating the server,
 * which is a channel a network attacker can sit inside undetected.
 *
 * Supplying the root explicitly is the correct fix and is strictly stronger
 * than the ordinary public-CA case: only certificates issued by this one CA
 * are accepted, so a mis-issuance by any of the ~150 roots Node otherwise
 * trusts cannot impersonate the database. See `backend/certs/README.md` for
 * the certificate's provenance and fingerprint.
 *
 * Read once at module load. A file read per connection would put disk I/O in
 * the pool's acquisition path for a value that cannot change while the
 * process runs.
 */
function usesTls(): boolean {
  return /sslmode=(require|verify-ca|verify-full)/.test(env.DATABASE_URL);
}

/**
 * The connection string with `sslmode` removed.
 *
 * **Load-bearing.** `pg-connection-string` turns `sslmode` into its own TLS
 * configuration and that configuration *replaces* the `ssl` object below —
 * so a URL saying `sslmode=require` silently discards the pinned CA and
 * verifies against Node's system roots instead, which fails against
 * Supabase's private CA with the very error this function exists to fix.
 *
 * The parameter still belongs in `DATABASE_URL`: it is how an operator states
 * that TLS is required, it is what `verify:supabase` checks, and it is what
 * every other Postgres client in the world reads. It is consumed here rather
 * than obeyed twice.
 */
function connectionString(): string {
  if (!usesTls()) return env.DATABASE_URL;

  return env.DATABASE_URL.replace(/([?&])sslmode=[^&]*(&|$)/, (_match, prefix: string, tail: string) =>
    tail === '&' ? prefix : '',
  );
}

function databaseTls(): PoolConfig['ssl'] {
  /*
    Only when the connection string asks for TLS. Local development runs
    Postgres in Docker with no certificate at all, and attaching a CA there
    turns `docker compose up` into a TLS handshake failure.
  */
  if (!usesTls()) return undefined;

  return {
    ca: readFileSync(join(PACKAGE_ROOT, 'certs', 'supabase-prod-ca-2021.crt'), 'utf8'),
    /*
      Explicit, though it is the default: this line is the entire security
      property of the block, and a future edit that flips it should have to
      delete something that says so rather than merely omit a field.
    */
    rejectUnauthorized: true,
  };
}

/**
 * Connection pool configuration.
 *
 * Separated from the pool itself so the shape of the configuration is
 * reviewable without reading connection-lifecycle code, and so a test can
 * build a pool with an overridden value without reaching into `db/pool.ts`.
 */
export const databaseConfig: PoolConfig = {
  connectionString: connectionString(),
  max: env.DATABASE_POOL_MAX,

  /**
   * Certificate verification against Supabase's pinned root — see
   * `databaseTls`. `undefined` for a local Postgres with no TLS.
   */
  ssl: databaseTls(),

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
