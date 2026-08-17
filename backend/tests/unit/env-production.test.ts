import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/lib/paths.js';

const run = promisify(execFile);

/**
 * The production fail-closed rules in `config/env.ts`.
 *
 * Driven as **subprocesses**, which is not the usual choice and is the right
 * one here. `env.ts` validates at module load and calls `process.exit(1)` on
 * failure, so there is nothing importable to assert against — and the two
 * behaviours worth testing *are* "the process refuses to start" and "it says
 * which variable". Exporting the schema to make it unit-testable would test a
 * schema while leaving the actual startup path unverified, which is the half
 * that matters.
 *
 * Each case is one `tsx` process, so this file is slower than the rest of the
 * unit suite. Four cases is the whole budget for that.
 */

/** A production configuration that is otherwise entirely valid. */
const VALID_PRODUCTION: Record<string, string> = {
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://app.lumora.test',
  APP_URL: 'https://app.lumora.test',
  DATABASE_URL: 'postgres://lumora:pw@db.internal:5432/lumora',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  MAIL_DRIVER: 'smtp',
  MAIL_FROM: 'Lumora <no-reply@lumora.test>',
  SMTP_HOST: 'smtp.lumora.test',
  SMTP_USER: 'mailer',
  SMTP_PASSWORD: 'pw',
  LLM_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'k',
  EMBEDDING_PROVIDER: 'gemini',
  VECTOR_STORE: 'chroma',
  CHROMA_URL: 'https://chroma.internal:8000',
  // Object storage is now part of a valid production configuration: the local
  // driver writes to a container filesystem that a deploy replaces.
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'lumora-production-documents',
  S3_REGION: 'ap-south-1',
};

/**
 * Boots `env.ts` in a child process and reports how it went.
 *
 * `env: overrides` with no inherited parent environment, because the real
 * `.env` on a developer's machine would otherwise supply values the case is
 * trying to omit, and the test would pass for the wrong reason.
 */
async function loadEnv(overrides: Record<string, string>): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    await run(
      process.execPath,
      ['--import', 'tsx', '--eval', "import('./src/config/env.js');"],
      {
        cwd: PACKAGE_ROOT,
        /*
          No inherited environment, and no `.env` either — the child must see
          exactly what the case supplies. Reading the developer's file made
          these tests pass or fail depending on whose machine ran them.
        */
        env: { PATH: process.env.PATH ?? '', LUMORA_IGNORE_DOTENV: '1', ...overrides },
        timeout: 30_000,
      },
    );
    return { ok: true, message: '' };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return { ok: false, message: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('production environment rules', () => {
  it('accepts a valid production configuration', async () => {
    /*
      The control. Without it, every assertion below would also pass against a
      schema that rejects *everything* in production, and the suite would be
      measuring nothing.
    */
    const result = await loadEnv(VALID_PRODUCTION);

    expect(result.message).toBe('');
    expect(result.ok).toBe(true);
  });

  it('refuses a fake provider in production', async () => {
    /*
      The failure this rule exists for: a stub that answers every question
      convincingly, forever, with nothing in the logs to say the model was
      never called. `VECTOR_STORE` is the dangerous one because `fake` is its
      *default* — a deploy that simply forgets the variable gets it.
    */
    const result = await loadEnv({ ...VALID_PRODUCTION, VECTOR_STORE: 'fake' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('VECTOR_STORE');
  });

  it('refuses a localhost URL in production', async () => {
    const result = await loadEnv({ ...VALID_PRODUCTION, APP_URL: 'http://localhost:5173' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('APP_URL');
  });

  it('refuses the console mail driver in production', async () => {
    // It prints verification and reset links to stdout: a broken signup flow
    // and a credential in the log aggregator, at the same time.
    const result = await loadEnv({
      ...VALID_PRODUCTION,
      MAIL_DRIVER: 'console',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('MAIL_DRIVER');
  });

  it('**refuses the local storage driver in production**', async () => {
    /*
      The failure this rule exists for is silent: uploads succeed, documents
      are readable for the life of the task, and then a deploy replaces the
      filesystem. Originals are the one artefact this product cannot
      regenerate — chunks come from an original and vectors from chunks.
    */
    const result = await loadEnv({
      ...VALID_PRODUCTION,
      STORAGE_DRIVER: 'local',
      S3_BUCKET: '',
      S3_REGION: '',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('STORAGE_DRIVER');
  });

  it('refuses an S3 driver with no bucket, in any environment', async () => {
    // Checked outside production too: failing at boot beats failing on the
    // first upload, when the document is already accepted and queued.
    const result = await loadEnv({
      ...VALID_PRODUCTION,
      NODE_ENV: 'development',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: '',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('S3_BUCKET');
  });

  it('**refuses a custom S3 endpoint in production**', async () => {
    // An endpoint override means the deployment is pointed at a development
    // MinIO. Every upload succeeds and none of them are in S3.
    const result = await loadEnv({
      ...VALID_PRODUCTION,
      S3_ENDPOINT: 'http://minio.internal:9000',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('S3_ENDPOINT');
  });

  it('accepts pgvector as the production vector store', async () => {
    // The production recommendation (docs/08 §6) must actually validate.
    const result = await loadEnv({
      ...VALID_PRODUCTION,
      VECTOR_STORE: 'pgvector',
      CHROMA_URL: 'https://unused.internal:8000',
    });

    expect(result.ok).toBe(true);
  });

  it('**accepts a Supabase Storage production configuration**', async () => {
    /*
      The deployment target (docs/11). Supabase Storage speaks the S3 protocol,
      so it reuses the same driver — but it needs an endpoint, its own access
      keys, and the encryption header switched off, all three of which the
      pre-Supabase rules refused.
    */
    const result = await loadEnv({
      ...VALID_PRODUCTION,
      VECTOR_STORE: 'pgvector',
      DATABASE_URL: 'postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres?sslmode=require',
      S3_ENDPOINT: 'https://abcdefgh.storage.supabase.co/storage/v1/s3',
      S3_ACCESS_KEY_ID: 'supabase-key-id',
      S3_SECRET_ACCESS_KEY: 'supabase-secret',
      S3_SERVER_SIDE_ENCRYPTION: 'none',
      S3_FORCE_PATH_STYLE: 'true',
    });

    expect(result.ok).toBe(true);
  });

  it('**still refuses a non-Supabase endpoint in production**', async () => {
    // The MinIO hole stays shut: only Supabase is exempted, by hostname.
    const result = await loadEnv({
      ...VALID_PRODUCTION,
      S3_ENDPOINT: 'https://minio.internal:9000',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('S3_ENDPOINT');
  });

  it('refuses a Supabase-looking endpoint with no access keys', async () => {
    // There is no task role to fall back on, so a missing pair would fail at
    // the first upload rather than at boot.
    const result = await loadEnv({
      ...VALID_PRODUCTION,
      S3_ENDPOINT: 'https://abcdefgh.storage.supabase.co/storage/v1/s3',
      S3_SERVER_SIDE_ENCRYPTION: 'none',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('S3_ACCESS_KEY_ID');
  });

  it('refuses disabled encryption when the endpoint is not Supabase', async () => {
    const result = await loadEnv({ ...VALID_PRODUCTION, S3_SERVER_SIDE_ENCRYPTION: 'none' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('S3_SERVER_SIDE_ENCRYPTION');
  });
});
