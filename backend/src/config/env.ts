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

/**
 * Secrets are length-checked, and in production the schema additionally
 * refuses anything that looks like a copied placeholder
 * (docs/03-backend.md §5). A deployment signing tokens with the value from
 * `.env.example` is indistinguishable from one with no secret at all, and it
 * is the single most common way a staging config reaches production.
 */
const PLACEHOLDER_MARKERS = ['change-me', 'changeme', 'example', 'placeholder', 'secret-here'];

const secretSchema = z
  .string()
  .min(32, 'must be at least 32 characters')
  .refine(
    (value) =>
      process.env.NODE_ENV !== 'production' ||
      !PLACEHOLDER_MARKERS.some((marker) => value.toLowerCase().includes(marker)),
    'looks like a development placeholder and must not be used in production',
  );

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

  /** Where the frontend lives. Only used to build links inside emails. */
  APP_URL: z.url(),

  // ── Authentication ─────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: secretSchema,
  /**
   * Short by design. An access token cannot be revoked individually, so its
   * lifetime *is* the revocation window (docs/04-data-and-api.md §3.1).
   * Capped at an hour: anything longer stops being a mitigation.
   */
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // ── Mail ───────────────────────────────────────────────────────────────────
  /** docs/03-backend.md §5: `MAIL_DRIVER=console|smtp  SMTP_*  MAIL_FROM`. */
  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().min(1).default('Lumora <no-reply@lumora.app>'),

  /*
    SMTP settings are `.optional()` in the base schema and made mandatory by the
    `superRefine` below when the driver is `smtp`.

    A flat `.min(1)` would force every developer running the console driver to
    invent a fake SMTP host just to boot, which is how required-but-unused
    variables get filled with garbage and stop meaning anything.
  */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /**
   * `true` for implicit TLS on 465, `false` for STARTTLS on 587. When false the
   * transport still sets `requireTLS`, so the session is encrypted either way —
   * this only selects *when* the handshake happens, never whether.
   */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),

  /*
    Three separate timeouts because they fail at three different points, and an
    operator reading a log needs to know which one tripped: no TCP connection,
    a connection that never greeted, or a greeting followed by silence. A
    single timeout collapses those into one indistinguishable "it hung".
  */
  SMTP_CONNECTION_TIMEOUT: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  SMTP_GREETING_TIMEOUT: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  SMTP_SOCKET_TIMEOUT: z.coerce.number().int().min(1_000).max(120_000).default(10_000),

  /**
   * Checks new passwords against Have I Been Pwned's k-anonymity range API
   * (docs/04-data-and-api.md §3.3). Off in tests, where a network call would
   * make the suite slow and flaky.
   */
  PASSWORD_BREACH_CHECK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  LOG_LEVEL: logLevelSchema.optional(),
});

/**
 * Cross-field rules the object schema cannot express.
 *
 * Selecting the SMTP driver without credentials is the one misconfiguration
 * that would otherwise boot cleanly and then fail on the first signup — the
 * exact "discover it at 2am" case the fail-fast rule exists for
 * (docs/03-backend.md §5). Named per-variable so the error says which one is
 * missing rather than "mail is misconfigured".
 */
const REQUIRED_FOR_SMTP = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const;

const envSchemaWithRules = envSchema.superRefine((value, ctx) => {
  if (value.MAIL_DRIVER !== 'smtp') return;

  for (const key of REQUIRED_FOR_SMTP) {
    if (!value[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'is required when MAIL_DRIVER=smtp',
      });
    }
  }

  /*
    Implicit TLS lives on 465 and STARTTLS on 587. Mismatching them produces a
    connection that hangs until the socket timeout rather than a refusal, which
    reads as "the network is slow" and costs an hour to diagnose.
  */
  if (value.SMTP_SECURE && value.SMTP_PORT === 587) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_SECURE'],
      message: 'must be false on port 587 (STARTTLS). Use port 465 for implicit TLS.',
    });
  }
  if (!value.SMTP_SECURE && value.SMTP_PORT === 465) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_SECURE'],
      message: 'must be true on port 465 (implicit TLS). Use port 587 for STARTTLS.',
    });
  }
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
  const result = envSchemaWithRules.safeParse(process.env);

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
