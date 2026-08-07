import type { Server } from 'node:http';
import { createApp } from './app.js';
import { APP_VERSION, SHUTDOWN_TIMEOUT_MS, env } from './config/index.js';
import { closeDatabase, connectDatabase } from './db/pool.js';
import { flushLogger, logger } from './lib/logger.js';

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

async function shutdown(server: Server, reason: string, exitCode = 0): Promise<void> {
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

async function main(): Promise<void> {
  // Fail before listening. A process that accepts traffic and then discovers
  // it has no database is a service that reports healthy and 500s.
  await connectDatabase();

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

  process.on('SIGTERM', () => void shutdown(server, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(server, 'SIGINT'));

  /*
    Both handlers exit non-zero rather than continuing.

    After an uncaught exception the process is in an unknown state — a
    half-finished mutation, a released lock that was never taken. Continuing
    trades a loud crash for silent corruption. A supervisor restarting a
    process is cheap; a process serving wrong answers is not.
  */
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown(server, 'unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown(server, 'uncaughtException', 1);
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start');
  flushLogger();
  process.exit(1);
});
