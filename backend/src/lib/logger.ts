import { pino, type Logger as PinoLogger } from 'pino';
import { env, isDevelopment, isProduction } from '../config/index.js';

/**
 * Structured fields attached to a log line. `unknown` rather than a loose
 * index signature so anything non-serializable has to be converted at the call
 * site instead of turning into `{}` in the output.
 */
export type LogContext = Record<string, unknown>;

/**
 * The logging contract the application codes against.
 *
 * docs/03-backend.md §6: "A `Logger` interface wraps pino so the implementation
 * can change without touching call sites." The point is not that pino will be
 * replaced — it is that a thousand call sites should not depend on one
 * library's exact signature, and that a test can pass a recording logger
 * without a transport.
 */
export interface Logger {
  fatal(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  info(context: LogContext, message: string): void;
  debug(context: LogContext, message: string): void;
  /** A logger that carries `bindings` on every line it writes. */
  child(bindings: LogContext): Logger;
}

/**
 * Fields scrubbed before anything is written.
 *
 * Two groups, and the second is the one that gets forgotten. Credentials are
 * obvious. **Content fields are treated as secrets too** — `content`, `text`,
 * `prompt`, `completion`, `answer` — because in this product those carry the
 * user's contracts, notes, and questions. A logger that prints a user's
 * document is a privacy incident, not a debugging convenience
 * (docs/03-backend.md §6).
 *
 * Configured here rather than left to call sites: a redaction rule that
 * depends on every future author remembering it is not a rule.
 */
const REDACTED_PATHS = [
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  'content',
  'text',
  'prompt',
  'completion',
  'answer',
  'query',
];

/**
 * The same names one level down, where they actually appear: `req.headers.
 * authorization`, `err.config.apiKey`, `job.payload.content`. pino matches
 * literal paths, not names, so the wildcard forms have to be listed.
 */
const REDACT_PATHS = [
  ...REDACTED_PATHS,
  ...REDACTED_PATHS.map((field) => `*.${field}`),
  ...REDACTED_PATHS.map((field) => `*.*.${field}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

function createRootLogger(): PinoLogger {
  const base = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    /**
     * pino defaults to `pid` and `hostname` on every line. In a single-process
     * service they are constant noise; when there is more than one process,
     * the platform adds identity anyway.
     *
     * `null`, not `undefined` — pino treats the two differently: `null` means
     * "no base fields", while `undefined` falls back to the default.
     */
    base: null,
    formatters: {
      // `level: "info"` rather than `level: 30` — the number is only readable
      // to someone who has memorized pino's scale.
      level: (label: string) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (isDevelopment) {
    // Human-readable in a terminal. Never in production, where the transport
    // costs a worker thread and defeats the point of structured logs.
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(base);
}

const rootLogger = createRootLogger();

/**
 * Adapts pino to the `Logger` interface.
 *
 * pino's own signature is `(obj, msg)` already, so this is a thin pass-through
 * — but it is the seam that keeps the rest of the codebase off pino's types.
 */
function adapt(instance: PinoLogger): Logger {
  return {
    fatal: (context, message) => instance.fatal(context, message),
    error: (context, message) => instance.error(context, message),
    warn: (context, message) => instance.warn(context, message),
    info: (context, message) => instance.info(context, message),
    debug: (context, message) => instance.debug(context, message),
    child: (bindings) => adapt(instance.child(bindings)),
  };
}

/**
 * The process-wide logger. Request handlers should use `req.log` instead —
 * it is this logger with the request id already bound.
 */
export const logger: Logger = adapt(rootLogger);

/**
 * Flushes buffered output before the process exits.
 *
 * Only meaningful in production, where pino writes asynchronously: without
 * this, the last few lines before a shutdown — usually the interesting ones —
 * are lost with the buffer.
 */
export function flushLogger(): void {
  if (isProduction) rootLogger.flush();
}
