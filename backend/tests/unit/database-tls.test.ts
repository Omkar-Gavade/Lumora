import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/lib/paths.js';

const run = promisify(execFile);

/**
 * Database TLS (docs/11).
 *
 * Supabase runs a private CA, so the pooler's certificate chains to a
 * self-signed root that appears in no public trust store. Node rejects it
 * unless that root is supplied, and the two easy ways to make the error go
 * away are both wrong: `NODE_TLS_REJECT_UNAUTHORIZED=0` disables verification
 * for the whole process including the Gemini calls, and
 * `rejectUnauthorized: false` encrypts without authenticating the server.
 *
 * These tests exist so neither can reappear quietly. They inspect the
 * configuration rather than opening a connection, so they need no network and
 * no credentials — which is also what lets them run in CI.
 */

/** Loads `databaseConfig` in a child with a controlled environment. */
async function loadConfig(databaseUrl: string): Promise<{
  hasSsl: boolean;
  rejectUnauthorized: unknown;
  caLength: number;
  sslmodeInConnectionString: boolean;
}> {
  const { stdout } = await run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--eval',
      `
      const { databaseConfig } = await import('./src/config/database.ts');
      const ssl = databaseConfig.ssl;
      process.stdout.write(JSON.stringify({
        hasSsl: Boolean(ssl),
        rejectUnauthorized: ssl && typeof ssl === 'object' ? ssl.rejectUnauthorized : undefined,
        caLength: ssl && typeof ssl === 'object' && typeof ssl.ca === 'string' ? ssl.ca.length : 0,
        sslmodeInConnectionString: /sslmode=/.test(String(databaseConfig.connectionString ?? '')),
      }));
      `,
    ],
    {
      cwd: PACKAGE_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        LUMORA_IGNORE_DOTENV: '1',
        NODE_ENV: 'development',
        DATABASE_URL: databaseUrl,
        JWT_ACCESS_SECRET: 'a'.repeat(48),
        // `env.ts` validates the whole schema before `databaseConfig` can be
        // imported, so the module refuses to load without these.
        APP_URL: 'http://localhost:5173',
        CORS_ORIGINS: 'http://localhost:5173',
      },
      timeout: 30_000,
    },
  );

  return JSON.parse(stdout) as Awaited<ReturnType<typeof loadConfig>>;
}

const SUPABASE_URL =
  'postgresql://postgres.abcdefgh:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require';
const LOCAL_URL = 'postgresql://lumora:lumora@localhost:5432/lumora';

describe('database TLS', () => {
  it('attaches the pinned CA when the connection asks for TLS', async () => {
    const config = await loadConfig(SUPABASE_URL);

    expect(config.hasSsl).toBe(true);
    expect(config.caLength).toBeGreaterThan(0);
  });

  it('**verifies the certificate rather than merely encrypting**', async () => {
    // `rejectUnauthorized: false` would still encrypt, and would leave a
    // channel a network attacker can sit inside without detection.
    const config = await loadConfig(SUPABASE_URL);

    expect(config.rejectUnauthorized).toBe(true);
  });

  it('**consumes `sslmode`, because pg-connection-string would override the CA**', async () => {
    /*
      The subtle one. `pg-connection-string` turns `sslmode` into its own TLS
      configuration and that configuration *replaces* the `ssl` object — so a
      URL saying `sslmode=require` silently discards the pinned CA and
      verifies against Node's system roots, which fails against a private CA
      with exactly the error the CA was added to fix.
    */
    const config = await loadConfig(SUPABASE_URL);

    expect(config.sslmodeInConnectionString).toBe(false);
  });

  it('attaches no TLS for a local database that has none', async () => {
    // Local development runs Postgres in Docker with no certificate at all;
    // attaching a CA there turns `docker compose up` into a handshake failure.
    const config = await loadConfig(LOCAL_URL);

    expect(config.hasSsl).toBe(false);
  });
});

describe('pinned certificate', () => {
  const path = join(PACKAGE_ROOT, 'certs', 'supabase-prod-ca-2021.crt');

  it('is present and is a certificate rather than a key', () => {
    const pem = readFileSync(path, 'utf8');

    expect(pem).toContain('-----BEGIN CERTIFICATE-----');
    // A private key in this directory would be a committed secret.
    expect(pem).not.toContain('PRIVATE KEY');
  });

  it('**is the Supabase root that was verified against the live server**', async () => {
    /*
      Pinned by fingerprint. Checking a CA against the server that presents it
      is circular — this records the value confirmed out of band, from
      Supabase's own HTTPS distribution, so a substituted file fails here
      rather than silently widening what the database will trust.
    */
    const { stdout } = await run('openssl', [
      'x509',
      '-in',
      path,
      '-noout',
      '-fingerprint',
      '-sha256',
    ]);

    // openssl prints `sha256Fingerprint=80:70:…`; strip separators, not just
    // whitespace.
    expect(stdout.replace(/[\s:]/g, '')).toContain(
      '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA',
    );
  });

  it('has not expired', async () => {
    const { stdout } = await run('openssl', ['x509', '-in', path, '-noout', '-enddate']);
    const notAfter = new Date(stdout.replace('notAfter=', '').trim());

    expect(notAfter.getTime()).toBeGreaterThan(Date.now());
  });
});
