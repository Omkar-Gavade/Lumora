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

/**
 * `silent` is pino's own level for "emit nothing" and exists here for the test
 * suite, where a few thousand request log lines bury the assertion that
 * actually failed. It is deliberately reachable in any environment — a
 * developer chasing one noisy endpoint should be able to mute the rest.
 */
const logLevelSchema = z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']);

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

  // ── Storage ────────────────────────────────────────────────────────────────
  /**
   * Only `local` exists today. S3 is one driver behind the same interface
   * (docs/05-rag-and-chat.md §2.1); adding it here without adding a factory
   * arm is a compile error, which is the point.
   */
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  /**
   * Where the local driver writes. Never hardcoded — a container mounts a
   * volume somewhere else, and a path baked into the source means documents
   * land on an ephemeral filesystem.
   */
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./uploads'),

  // ── Chunking ───────────────────────────────────────────────────────────────
  /*
    The parameters from docs/05-rag-and-chat.md §2.3, exposed so a corpus with
    unusual shape can be retuned without a deploy — not so they can be guessed
    at. The defaults are the documented ones and are the right answer for
    ordinary prose.
  */
  CHUNK_SIZE: z.coerce.number().int().min(64).max(4_000).default(512),
  CHUNK_MAX_SIZE: z.coerce.number().int().min(64).max(8_000).default(800),
  CHUNK_MIN_SIZE: z.coerce.number().int().min(1).max(2_000).default(100),
  /** ≈15% of the target. Where recall stops improving and storage keeps rising. */
  CHUNK_OVERLAP: z.coerce.number().int().min(0).max(2_000).default(75),

  // ── Embedding ──────────────────────────────────────────────────────────────
  /**
   * `fake` is a first-class option, not a test hack.
   *
   * It is what lets the whole ingestion pipeline — chunking, batching,
   * indexing, status transitions — be developed and verified without an API
   * key or a cent of spend. The alternative is a codebase where the only way
   * to run the pipeline is to pay for it, which means it stops being run.
   */
  EMBEDDING_PROVIDER: z.enum(['fake', 'gemini', 'openai']).default('fake'),
  EMBEDDING_MODEL: z.string().min(1).default('fake-embedding-001'),
  /**
   * Asserted against the provider's actual output, not used to configure it.
   *
   * docs/05-rag-and-chat.md §2.4: embedding spaces are not comparable across
   * models. A dimension mismatch means the model changed under an index that
   * already exists, and the symptom is confident nonsense rather than an
   * error — so it is checked at the one moment it is still cheap to catch.
   */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(8_192).default(8),
  /** ≈96 texts per call (docs §2.4). Bounded by provider request-size limits. */
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(512).default(96),
  /** Retries for a single batch, inside the job, before the job itself fails. */
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  GEMINI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),

  // ── Vector store ───────────────────────────────────────────────────────────
  /**
   * `pgvector` is present in the enum and stubbed, per docs/06-roadmap.md R5:
   * "the pgvector implementation is stubbed so the interface is proven against
   * two backends rather than shaped around one."
   */
  VECTOR_STORE: z.enum(['chroma', 'fake', 'pgvector']).default('fake'),
  CHROMA_URL: z.url().default('http://localhost:8000'),
  /**
   * One collection per user (docs §2.5): `user_{userId}`.
   *
   * Prefixed so several environments can share one Chroma instance without a
   * staging document appearing in a production answer.
   */
  CHROMA_COLLECTION_PREFIX: z.string().min(1).default('user_'),

  // ── Worker ─────────────────────────────────────────────────────────────────
  /**
   * Runs the ingestion worker in-process alongside the API
   * (docs/03-backend.md §7: "same process in development, separate in
   * production").
   *
   * Off in the test suite by default. A background poller that claims jobs on
   * its own schedule turns every queue assertion into a race — the test suite
   * drives the worker explicitly instead.
   */
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * Jobs processed simultaneously by one worker.
   *
   * Two, not more, because parsing is memory-bound rather than I/O-bound: a
   * 25 MB PDF holds its page tree, fonts, and extracted text in memory at once,
   * and the failure mode of over-parallelising is an OOM-killed worker that
   * strands every job it held — recoverable via the reaper, but only after a
   * full lease expires.
   */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),

  /**
   * Gap between polls when the queue came back empty.
   *
   * A poll costs one indexed query, so this is a latency knob, not a load one:
   * it is the delay a user sees between upload and the status leaving `queued`.
   * The loop polls again immediately after a successful claim, so a backlog is
   * drained at full speed regardless of this value.
   */
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),

  /**
   * How long a claim survives without a heartbeat before the reaper takes it
   * back.
   *
   * Bounds crash recovery: a worker killed mid-job strands its documents for at
   * most this long. It can be short because running jobs heartbeat — it needs
   * to exceed the heartbeat interval by enough margin to survive a GC pause or
   * a slow query, not to exceed the longest possible job.
   */
  WORKER_LEASE_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),

  /** Lease renewal cadence. Kept well under `WORKER_LEASE_MS`. */
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),

  /** How often the reaper sweeps for expired leases. */
  WORKER_REAPER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

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
  /*
    A heartbeat slower than the lease guarantees the reaper steals jobs from
    workers that are alive and making progress — the document is processed
    twice, and the original worker's `complete` silently applies to a job
    somebody else now owns. Caught at startup because in production it presents
    as intermittent duplicate processing under load, which is close to
    undiagnosable from logs alone.
  */
  if (value.WORKER_HEARTBEAT_INTERVAL_MS >= value.WORKER_LEASE_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['WORKER_HEARTBEAT_INTERVAL_MS'],
      message: `must be less than WORKER_LEASE_MS (${String(value.WORKER_LEASE_MS)}), or the reaper will reclaim jobs from live workers`,
    });
  }

  /*
    A minimum above the maximum silently produces the opposite of what both
    numbers mean: every chunk is "undersized", so every chunk merges into its
    neighbour until one breaches the maximum. Caught here because the symptom
    is bad retrieval, which nobody traces back to a config file.
  */
  if (value.CHUNK_MIN_SIZE >= value.CHUNK_MAX_SIZE) {
    ctx.addIssue({
      code: 'custom',
      path: ['CHUNK_MIN_SIZE'],
      message: `must be less than CHUNK_MAX_SIZE (${String(value.CHUNK_MAX_SIZE)})`,
    });
  }
  if (value.CHUNK_SIZE > value.CHUNK_MAX_SIZE) {
    ctx.addIssue({
      code: 'custom',
      path: ['CHUNK_SIZE'],
      message: `must not exceed CHUNK_MAX_SIZE (${String(value.CHUNK_MAX_SIZE)})`,
    });
  }
  /*
    Overlap at or above the target means each chunk carries its predecessor
    whole, so the corpus grows without bound and every chunk is about two
    things.
  */
  if (value.CHUNK_OVERLAP >= value.CHUNK_SIZE) {
    ctx.addIssue({
      code: 'custom',
      path: ['CHUNK_OVERLAP'],
      message: `must be less than CHUNK_SIZE (${String(value.CHUNK_SIZE)})`,
    });
  }

  /*
    A provider selected without its key boots cleanly and then fails on the
    first document — the exact "discover it at 2am" case fail-fast exists for
    (docs/03-backend.md §5). Named per-provider so the error says which key.
  */
  if (value.EMBEDDING_PROVIDER === 'gemini' && !value.GEMINI_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['GEMINI_API_KEY'],
      message: 'is required when EMBEDDING_PROVIDER=gemini',
    });
  }
  if (value.EMBEDDING_PROVIDER === 'openai' && !value.OPENAI_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPENAI_API_KEY'],
      message: 'is required when EMBEDDING_PROVIDER=openai',
    });
  }

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
