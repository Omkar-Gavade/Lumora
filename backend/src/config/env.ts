import { join } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { PACKAGE_ROOT } from '../lib/paths.js';

/**
 * The only module in the codebase permitted to read `process.env`
 * (docs/03-backend.md §5, enforced by `no-restricted-properties` in
 * eslint.config.js).
 *
 * Everything downstream imports the parsed, typed result. That is what turns
 * "this variable is probably set" into a compile-time fact, and it is why the
 * process refuses to start rather than discovering at 2am that a secret was
 * `undefined` and every token was signed with the string "undefined".
 *
 * The schema covers exactly what this milestone reads. Variables for the LLM,
 * vector store, storage, and mail providers are listed in docs §5 but are not
 * validated here yet: failing startup over a missing `GEMINI_API_KEY` while
 * nothing in the process can call Gemini is a false alarm that teaches people
 * to bypass the check. Each variable joins the schema in the milestone that
 * first reads it.
 */

// Real environment variables win over the file; dotenv does not override.
// That ordering is what lets a container inject configuration over a `.env`
// that happens to be baked into the image.
dotenv.config({ path: join(PACKAGE_ROOT, '.env'), quiet: true });

const nodeEnvSchema = z.enum(['development', 'test', 'production']);

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

/**
 * `POSTGRES_URL`-style connection string. Checked for scheme rather than
 * parsed: the driver owns the grammar, and a stricter regex here would reject
 * legitimate forms (socket paths, multi-host failover) for no gain.
 */
const databaseUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'must be a postgres:// or postgresql:// connection string',
  );

/**
 * Comma-separated origins. Split and validated individually so a single
 * malformed entry names itself instead of silently disabling CORS for every
 * origin in the list.
 *
 * A trailing slash is stripped: browsers send `Origin: https://app.example.com`
 * with no path, so `https://app.example.com/` would never match and would fail
 * as a CORS rejection that looks like a server bug.
 */
const corsOriginsSchema = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(z.url({ message: 'each CORS origin must be an absolute URL' })).min(1));

const envSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),

  /** 0 asks the OS for a free port — used by integration tests. */
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().min(1).default('127.0.0.1'),

  CORS_ORIGINS: corsOriginsSchema,

  DATABASE_URL: databaseUrlSchema,
  /**
   * Postgres' own `max_connections` defaults to 100 and is shared by every
   * client, so this is a per-process share, not a target. Ten is comfortable
   * for a single node and leaves room for migrations and a psql session.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  LOG_LEVEL: logLevelSchema.optional(),
});

export type Env = z.infer<typeof envSchema> & { LOG_LEVEL: z.infer<typeof logLevelSchema> };

/**
 * Renders a Zod failure as something an operator can act on at 3am, rather
 * than a stringified issue array.
 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const variable = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${variable}: ${issue.message}`;
    })
    .join('\n');
}

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    /*
      `console.error`, not the logger — deliberately, and the single exception
      to the no-console rule.

      The logger's level comes from this very parse, so at this point there is
      no configured logger to use. Writing structured JSON to a log aggregator
      would also be the wrong medium: nobody is watching a dashboard for a
      process that never started. This goes to stderr, in plain text, for the
      human running the command.
    */
    // eslint-disable-next-line no-console
    console.error(
      `\nInvalid environment configuration — refusing to start.\n\n${formatIssues(result.error)}\n\n` +
        `See backend/.env.example for the required variables.\n`,
    );
    process.exit(1);
  }

  return {
    ...result.data,
    // Development wants to see everything; production defaults to the level
    // that is actually readable in aggregate.
    LOG_LEVEL: result.data.LOG_LEVEL ?? (result.data.NODE_ENV === 'development' ? 'debug' : 'info'),
  };
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
