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
        env: { PATH: process.env.PATH ?? '', ...overrides },
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
});
