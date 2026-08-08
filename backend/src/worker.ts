import { SHUTDOWN_TIMEOUT_MS } from './config/index.js';
import { closeDatabase, connectDatabase } from './db/pool.js';
import { flushLogger, logger } from './lib/logger.js';
import { LocalStorageProvider } from './providers/storage/local.storage.js';
import { storageProvider } from './providers/storage/storage.factory.js';
import { IngestionWorker } from './workers/ingestion.worker.js';

/**
 * Standalone worker entry point (docs/03-backend.md §7: "same process in
 * development, separate in production").
 *
 * Deliberately thin. All the behaviour lives in `IngestionWorker`, and this
 * file only owns process concerns — connect, verify, signal handling, drain.
 * If the two entry points diverged, the worker you tested in development would
 * not be the worker running in production.
 *
 * Run with `WORKER_ENABLED=false` on the API process so jobs are not claimed
 * twice over.
 */

let shuttingDown = false;

async function shutdown(worker: IngestionWorker, reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason }, 'Shutting down worker');

  const deadline = setTimeout(() => {
    /*
      In-flight jobs are abandoned when this fires, and that is survivable
      rather than lossy: their leases expire and the reaper returns them to
      `pending`, so they run again on another worker. The cost of overrunning
      is a delay, not a lost document — which is exactly why a hard deadline is
      safe to have here.
    */
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Worker drain timed out — forcing exit');
    flushLogger();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  try {
    await worker.stop();
    await closeDatabase();
    clearTimeout(deadline);
    logger.info({}, 'Worker shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'Error during worker shutdown');
    exitCode = 1;
  }

  flushLogger();
  process.exit(exitCode);
}

async function main(): Promise<void> {
  await connectDatabase();

  // Fatal for the same reason it is on the API: a worker that cannot read
  // document bytes fails every job it claims, burning each one's whole attempt
  // budget before anybody notices the mount is missing.
  if (storageProvider instanceof LocalStorageProvider) {
    await storageProvider.verify();
  }
  logger.info({ driver: storageProvider.name }, 'Storage provider ready');

  const worker = new IngestionWorker();
  worker.start();

  process.on('SIGTERM', () => void shutdown(worker, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(worker, 'SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown(worker, 'unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown(worker, 'uncaughtException', 1);
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start worker');
  flushLogger();
  process.exit(1);
});
