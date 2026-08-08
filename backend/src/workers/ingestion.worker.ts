import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { env } from '../config/index.js';
import { logger, type Logger } from '../lib/logger.js';
import { backoffDelayMs, jobRepository, type ClaimedJob } from '../repositories/job.repository.js';
import { HANDLED_JOB_TYPES, handlerFor } from './job-handlers.js';

export interface WorkerOptions {
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  reaperIntervalMs?: number;
}

/**
 * The ingestion worker (docs/03-backend.md §7).
 *
 * A poll loop over `jobs`, `FOR UPDATE SKIP LOCKED` on claim, leases renewed by
 * a heartbeat, and a reaper that returns expired leases to `pending`. No Redis,
 * no broker: the job and the document status it mutates commit together, which
 * is the property a separate queue cannot offer.
 *
 * Runs in-process with the API in development and as its own process in
 * production. Nothing here assumes either — the worker holds no HTTP state and
 * shares only the connection pool, so `node dist/worker.js` and "started from
 * `server.ts`" are the same code path.
 *
 * A class rather than module-level functions because tests need to run a worker
 * with a two-second lease beside one with a sixty-second lease, and shared
 * mutable module state makes that impossible.
 */
export class IngestionWorker {
  /**
   * Identifies this worker in `jobs.locked_by`.
   *
   * Host **and** a random suffix: the host alone collides across replicas on
   * one machine and across restarts, and a stale lock labelled with a name a
   * live worker also uses lets that worker heartbeat a job it does not own.
   */
  readonly id: string;

  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reaperIntervalMs: number;

  private running = false;
  private stopping = false;
  /** One promise per in-flight job, awaited by `stop()`. */
  private readonly inFlight = new Set<Promise<void>>();
  private loop: Promise<void> | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  /**
   * The reaper sweep currently in flight, so `stop()` can wait for it.
   *
   * `clearInterval` stops new ticks but says nothing about the query already
   * issued. Without this the pool can be closed underneath a live statement,
   * which surfaces as an error thrown from a timer with no call stack pointing
   * at anything that caused it.
   */
  private reaping: Promise<unknown> = Promise.resolve();
  /** Resolves the poll loop's sleep early so shutdown is not delayed by it. */
  private wake: (() => void) | null = null;

  constructor(options: WorkerOptions = {}) {
    this.id = options.workerId ?? `${hostname()}-${randomUUID().slice(0, 8)}`;
    this.concurrency = options.concurrency ?? env.WORKER_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? env.WORKER_POLL_INTERVAL_MS;
    this.leaseMs = options.leaseMs ?? env.WORKER_LEASE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? env.WORKER_HEARTBEAT_INTERVAL_MS;
    this.reaperIntervalMs = options.reaperIntervalMs ?? env.WORKER_REAPER_INTERVAL_MS;
  }

  /** Starts the poll loop and the reaper. Returns immediately. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    logger.info(
      {
        workerId: this.id,
        concurrency: this.concurrency,
        pollIntervalMs: this.pollIntervalMs,
        leaseMs: this.leaseMs,
        types: HANDLED_JOB_TYPES,
      },
      'Ingestion worker started',
    );

    this.reaperTimer = setInterval(() => {
      // Never overlap: a sweep slower than the interval would otherwise stack
      // identical UPDATEs against a database that is evidently already
      // struggling.
      this.reaping = this.reaping.then(() => this.reap());
    }, this.reaperIntervalMs);
    // The reaper must never be the reason the process stays alive: without
    // this, a shutdown that fails to clear the interval hangs forever.
    this.reaperTimer.unref();

    this.loop = this.pollLoop();
  }

  /**
   * Stops claiming and waits for in-flight jobs to finish (docs/03-backend.md §7:
   * "graceful shutdown drains in-flight jobs").
   *
   * Draining rather than abandoning is what makes a deploy invisible. An
   * abandoned job is recoverable — the reaper takes it back — but only after a
   * full lease expires, so every rolling restart would strand documents in
   * `parsing` for a minute for no reason.
   *
   * Bounded by the caller's shutdown deadline rather than by a timeout here:
   * `server.ts` already owns a hard deadline for the whole process, and a
   * second competing one would make the effective limit whichever fired first,
   * which is not a limit anybody chose.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;

    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    // Cut the sleep short. Otherwise shutdown waits out a poll interval that
    // will do nothing when it wakes.
    this.wake?.();

    const pending = this.inFlight.size;
    if (pending > 0) {
      logger.info({ workerId: this.id, pending }, 'Draining in-flight jobs');
    }

    await this.loop;
    await Promise.allSettled([...this.inFlight]);
    // The sweep holds a connection; returning before it finishes lets the
    // caller close the pool underneath it.
    await this.reaping.catch(() => undefined);

    this.running = false;
    this.loop = null;
    logger.info({ workerId: this.id }, 'Ingestion worker stopped');
  }

  /**
   * Claims and runs at most one job. Returns whether one was found.
   *
   * The test seam. A background poller on its own schedule makes every queue
   * assertion a race — the suite drives the worker one job at a time instead,
   * which is also how each of claim, heartbeat, failure, and dead-lettering can
   * be observed in isolation.
   */
  async runOnce(): Promise<boolean> {
    const job = await jobRepository.claim(this.id, HANDLED_JOB_TYPES);
    if (job === null) return false;

    await this.process(job);
    return true;
  }

  /** Runs jobs until the queue is empty. Bounded so a bug cannot spin. */
  async drain(maxJobs = 1_000): Promise<number> {
    let processed = 0;
    while (processed < maxJobs && (await this.runOnce())) processed += 1;
    return processed;
  }

  /**
   * Returns expired leases to `pending`.
   *
   * Every worker runs this, not a designated leader. Election would need
   * coordination the queue deliberately does not have, and the sweep is a
   * single indexed `UPDATE` — two workers running it concurrently produce the
   * same rows, and the second one updates nothing.
   */
  async reap(): Promise<number> {
    try {
      const requeued = await jobRepository.requeueStale(this.leaseMs);
      if (requeued > 0) {
        logger.warn(
          { workerId: this.id, requeued, leaseMs: this.leaseMs },
          'Reclaimed jobs from expired leases',
        );
      }
      return requeued;
    } catch (error) {
      // Never fatal. The reaper is a repair mechanism; if it cannot run, the
      // next tick tries again, and taking the worker down over it would strand
      // exactly the jobs it exists to recover.
      logger.error({ err: error, workerId: this.id }, 'Reaper failed');
      return 0;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      let claimed = false;

      try {
        // Claim only up to the free capacity, so `concurrency` bounds
        // simultaneous work rather than merely the claim rate.
        while (!this.stopping && this.inFlight.size < this.concurrency) {
          const job = await jobRepository.claim(this.id, HANDLED_JOB_TYPES);
          if (job === null) break;

          claimed = true;
          const task = this.process(job).finally(() => this.inFlight.delete(task));
          this.inFlight.add(task);
        }
      } catch (error) {
        // Almost always the database being unreachable. Logged and slept
        // through: the loop is the thing that recovers when it comes back, so
        // it must not be the thing that dies.
        logger.error({ err: error, workerId: this.id }, 'Failed to claim job');
      }

      // A successful claim means there may be more waiting, so a backlog
      // drains at full speed instead of one job per poll interval. Sleeping
      // only when idle, or when at capacity, is what keeps polling cheap.
      if (!claimed || this.inFlight.size >= this.concurrency) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * Runs one claimed job with its lease kept alive, and records the outcome.
   *
   * Never throws. An escaping error here would reject the promise held in
   * `inFlight`, and an unhandled rejection during shutdown takes the process
   * down over a job that was already being handled.
   */
  private async process(job: ClaimedJob): Promise<void> {
    const log = logger.child({ workerId: this.id, jobId: job.id, jobType: job.type });
    const startedAt = Date.now();

    /*
      Serialized, and awaited before this method returns.

      A heartbeat is a database round trip fired from a timer. Left floating,
      the last one outlives the job it was protecting — holding a pool
      connection and, if the pool closes first, failing with an error that
      points at no caller. Chaining also means a heartbeat slower than the
      interval cannot stack up behind itself.
    */
    let beating: Promise<void> = Promise.resolve();

    const beat = async (): Promise<void> => {
      try {
        const held = await jobRepository.heartbeat(job.id, this.id);
        if (held) return;

        /*
          The lease is gone — the reaper reclaimed it, and another worker may
          already be running this job.

          Not aborted, deliberately. Every stage is idempotent (guarded status
          transitions, upserts keyed on `(document_id, chunk_index)`), so a
          duplicate run converges rather than corrupts, and aborting mid-parse
          would leave a half-written document behind for no gain. Logged at
          `warn` because a lease lost by a *live* worker means the lease or the
          heartbeat interval is misconfigured.
        */
        log.warn({}, 'Lost job lease — another worker may be processing this job');
      } catch (error) {
        // Never fatal: the lease survives until it expires, and one missed
        // renewal is not worth abandoning a job over.
        log.error({ err: error }, 'Heartbeat failed');
      }
    };

    const heartbeat = setInterval(() => {
      beating = beating.then(beat);
    }, this.heartbeatIntervalMs);
    heartbeat.unref();

    try {
      const handler = handlerFor(job.type);

      if (handler === null) {
        // A type with no handler is a deploy problem, not a data problem, and
        // retrying will not install the missing code. Dead-lettered so it is
        // visible rather than cycling forever.
        await jobRepository.fail(job.id, `No handler registered for job type "${job.type}"`, null);
        log.error({}, 'No handler registered — dead-lettered');
        return;
      }

      const result = await handler(job.payload);

      if (result.ok) {
        await jobRepository.complete(job.id);
        log.info({ durationMs: Date.now() - startedAt, attempts: job.attempts }, 'Job completed');
        return;
      }

      await this.recordFailure(job, result.error, result.retryable, log);
    } catch (error) {
      // An unexpected throw is treated as retryable: it is an infrastructure
      // failure by elimination, since handlers return their domain failures as
      // values rather than throwing them.
      await this.recordFailure(job, describe(error), true, log);
    } finally {
      clearInterval(heartbeat);
      await beating;
    }
  }

  /**
   * Decides between a backoff and a dead letter, then writes it.
   *
   * Two conditions end a job: the failure is permanent, or the attempt budget
   * is spent. `attempts` was incremented on claim, so `attempts >= maxAttempts`
   * here means this run was the last one — no off-by-one that grants a silent
   * fourth try.
   */
  private async recordFailure(
    job: ClaimedJob,
    error: string,
    retryable: boolean,
    log: Logger,
  ): Promise<void> {
    const budgetSpent = job.attempts >= job.maxAttempts;
    const retryAt = retryable && !budgetSpent ? new Date(Date.now() + backoffDelayMs(job.attempts)) : null;

    try {
      const { deadLettered } = await jobRepository.fail(job.id, error, retryAt);

      if (deadLettered) {
        log.error(
          { attempts: job.attempts, maxAttempts: job.maxAttempts, retryable, error },
          'Job dead-lettered',
        );
      } else {
        log.warn({ attempts: job.attempts, retryAt, error }, 'Job failed — will retry');
      }
    } catch (writeError) {
      /*
        The failure could not even be recorded — the database went away between
        the job running and this write.

        Nothing more can be done from here, and that is acceptable: the row is
        still `processing` with a lease that will expire, so the reaper picks it
        up. This is precisely the case the reaper exists for.
      */
      log.error({ err: writeError, originalError: error }, 'Could not record job failure');
    }
  }

  /** Interruptible sleep — `stop()` resolves it early via `wake`. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      timer.unref();

      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
