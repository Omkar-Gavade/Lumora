import type { Server } from 'node:http';
import { createApp } from './app.js';
import { APP_VERSION, SHUTDOWN_TIMEOUT_MS, env } from './config/index.js';
import { closeDatabase, connectDatabase } from './db/pool.js';
import { flushLogger, logger } from './lib/logger.js';
import { mailProvider } from './providers/mail/mail.factory.js';
import { LocalStorageProvider } from './providers/storage/local.storage.js';
import { storageProvider } from './providers/storage/storage.factory.js';
import { IngestionWorker } from './workers/ingestion.worker.js';

/**
 * Process entry: load config, verify the database, listen, and shut down
 * cleanly (docs/03-backend.md §2).
 *
 * Importing `./config` is what validates the environment — the module runs its
 * Zod parse at import time and calls `process.exit(1)` on failure, so an
 * invalid configuration stops the process here, before a socket is opened and
 * before anything can observe a half-configured service.
 */

/**
 * Guards against a second shutdown running concurrently with the first. Both
 * SIGTERM and SIGINT arrive in some environments, and two overlapping
 * shutdowns close the pool twice — the second throws inside a signal handler,
 * which is an unhandled rejection during shutdown and masks the real reason
 * the process is going down.
 */
let shuttingDown = false;

async function shutdown(
  server: Server,
  worker: IngestionWorker | null,
  reason: string,
  exitCode = 0,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason }, 'Shutting down');

  /*
    A hard deadline. `server.close()` waits for in-flight requests, and a
    single stuck handler — or a keep-alive connection a client never closes —
    would otherwise hold the process open until the orchestrator SIGKILLs it,
    turning a clean shutdown into a dropped one. `unref()` so this timer is
    not itself a reason to stay alive.
  */
  const deadline = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown timed out — forcing exit');
    flushLogger();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  try {
    // Stop accepting connections first, then drain. Closing the database
    // before the server would fail every request still in flight.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    logger.info({}, 'HTTP server closed');

    /*
      The worker drains **after** the HTTP server closes and **before** the
      pool does, and both halves of that ordering matter.

      After the server, because a request still in flight may enqueue a job,
      and stopping the worker first would leave it for the next deploy. Before
      the pool, because a draining job holds connections — closing the pool
      underneath it turns a clean drain into a job that fails on its last
      statement and gets retried for no reason.
    */
    if (worker) await worker.stop();

    await closeDatabase();

    clearTimeout(deadline);
    logger.info({}, 'Shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    exitCode = 1;
  }

  flushLogger();
  process.exit(exitCode);
}

/**
 * Checks the mail transport at boot and reports it — **without** refusing to
 * start.
 *
 * The asymmetry with the database is deliberate. Without Postgres nothing
 * works, so a failed connection is fatal. Without mail, everything except
 * verification and password reset works perfectly, and both have a resend path
 * (docs/00-product.md §160). Killing the process over a mail outage would take
 * chat and documents down to protect an email nobody was waiting for.
 *
 * The failure is logged at `error` precisely because it is not fatal: nothing
 * else will crash to draw attention to it.
 */
async function verifyMailProvider(): Promise<void> {
  const health = await mailProvider.verify();

  if (health.ok) {
    logger.info({ driver: mailProvider.name, latencyMs: health.latencyMs }, 'Mail provider ready');
    return;
  }

  logger.error(
    { driver: mailProvider.name, latencyMs: health.latencyMs, reason: health.message },
    'Mail provider unavailable — verification and password-reset emails will fail until this is fixed',
  );
}

/**
 * Proves the storage root exists and is writable.
 *
 * **Fatal, unlike the mail check.** A document platform that cannot write
 * bytes has no working feature to offer — every upload would accept a file,
 * transfer it, and fail at the last step. Better to refuse to start than to
 * look healthy while losing every upload.
 */
async function verifyStorageProvider(): Promise<void> {
  if (storageProvider instanceof LocalStorageProvider) {
    await storageProvider.verify();
  }
  logger.info({ driver: storageProvider.name }, 'Storage provider ready');
}

async function main(): Promise<void> {
  // Fail before listening. A process that accepts traffic and then discovers
  // it has no database is a service that reports healthy and 500s.
  await connectDatabase();

  await verifyStorageProvider();
  await verifyMailProvider();

  const app = createApp();

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(env.PORT, env.HOST, () => resolve(instance));
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : env.PORT;

  logger.info(
    { host: env.HOST, port, environment: env.NODE_ENV, version: APP_VERSION },
    'Lumora API listening',
  );

  /*
    In-process worker (docs/03-backend.md §7: "same process in development,
    separate in production").

    Set `WORKER_ENABLED=false` and run `npm run worker` to split them. Nothing
    in the worker depends on being co-located — it shares only the connection
    pool — so the split is a deployment decision rather than a code change,
    and either arrangement runs the same file.
  */
  const worker = env.WORKER_ENABLED ? new IngestionWorker() : null;
  worker?.start();

  process.on('SIGTERM', () => void shutdown(server, worker, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(server, worker, 'SIGINT'));

  /*
    Both handlers exit non-zero rather than continuing.

    After an uncaught exception the process is in an unknown state — a
    half-finished mutation, a released lock that was never taken. Continuing
    trades a loud crash for silent corruption. A supervisor restarting a
    process is cheap; a process serving wrong answers is not.
  */
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown(server, worker, 'unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown(server, worker, 'uncaughtException', 1);
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start');
  flushLogger();
  process.exit(1);
});
