import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import { db } from '../db/pool.js';
import type { JobsTable } from '../db/schema.js';
import { JOB_PAYLOAD_SCHEMAS, type JobType } from '../domain/jobs/job-types.js';
import type { Executor } from './user.repository.js';

export interface EnqueueOptions {
  /** Higher runs first among rows that are due. */
  priority?: number;
  /** Delays eligibility — used by a retry's backoff. */
  runAfter?: Date;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  /** Incremented by the claim itself, so the first run reads 1. */
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

function toClaimedJob(row: Selectable<JobsTable>): ClaimedJob {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
  };
}

/**
 * SQL for `jobs` — the durable queue from docs/03-backend.md §7.
 *
 * A job table in Postgres claimed with `FOR UPDATE SKIP LOCKED`, no Redis and
 * no broker. The decisive property is not throughput: it is that a job and the
 * document status it mutates commit **together or not at all**, which a
 * separate queue cannot guarantee. Every other design here follows from that.
 */
export const jobRepository = {
  /**
   * Writes one job.
   *
   * Takes an `Executor` with no default, unlike every other repository here.
   * That is the point: enqueueing outside a transaction is the bug
   * docs/05-rag-and-chat.md §2.1 names — orphan jobs referencing rolled-back
   * rows, or documents that are never processed — so the signature makes a
   * caller pass one rather than silently getting the pool.
   */
  async enqueue(
    type: JobType,
    payload: unknown,
    executor: Executor,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const validated: unknown = JOB_PAYLOAD_SCHEMAS[type].parse(payload);

    const row = await executor
      .insertInto('jobs')
      .values({
        type,
        payload: JSON.stringify(validated),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.runAfter === undefined ? {} : { run_after: options.runAfter.toISOString() }),
        ...(options.maxAttempts === undefined ? {} : { max_attempts: options.maxAttempts }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  },

  /**
   * Atomically claims one due job, or returns `null`.
   *
   * The SQL is the shape docs/03-backend.md §7 specifies, and every clause
   * earns its place:
   *
   * **`FOR UPDATE SKIP LOCKED`** is what makes this safe with N workers. Two
   * workers issuing this statement simultaneously cannot select the same row —
   * the second skips what the first has locked rather than blocking on it. A
   * plain `SELECT … LIMIT 1` followed by an `UPDATE` has a window between the
   * two in which both workers see the same id, and the same document is
   * processed twice.
   *
   * **The subquery** exists because `SKIP LOCKED` is only meaningful on a
   * `SELECT`. The `UPDATE` then targets exactly the one id that select
   * resolved to, so the lock and the claim are one statement.
   *
   * **`attempts = attempts + 1` on claim**, not on failure. A worker that is
   * killed mid-job never reaches its failure handler, so incrementing there
   * would let a job that reliably crashes the process retry forever. Counting
   * the attempt when it *starts* means a poison job exhausts its budget and
   * dead-letters even if it never returns.
   */
  async claim(workerId: string, types: JobType[], executor: Executor = db): Promise<ClaimedJob | null> {
    if (types.length === 0) return null;

    const row = await executor
      .updateTable('jobs')
      .set((eb) => ({
        status: 'processing' as const,
        locked_at: sql<string>`now()`,
        locked_by: workerId,
        attempts: eb('attempts', '+', 1),
      }))
      .where(
        'id',
        '=',
        (eb) =>
          eb
            .selectFrom('jobs')
            .select('id')
            .where('status', '=', 'pending')
            .where('run_after', '<=', sql<Date>`now()`)
            .where('type', 'in', types)
            .orderBy('priority', 'desc')
            .orderBy('created_at')
            .limit(1)
            .forUpdate()
            .skipLocked(),
      )
      .returningAll()
      .executeTakeFirst();

    return row ? toClaimedJob(row) : null;
  },

  /** Marks a job done. Terminal — a completed job is never re-claimed. */
  async complete(jobId: string, executor: Executor = db): Promise<void> {
    await executor
      .updateTable('jobs')
      .set({
        status: 'completed',
        completed_at: sql<string>`now()`,
        error: null,
        locked_at: null,
        locked_by: null,
      })
      .where('id', '=', jobId)
      .execute();
  },

  /**
   * Records a failure and decides whether the job lives.
   *
   * docs/03-backend.md §7: `attempts < max` returns it to `pending` with a
   * backoff; `attempts >= max` marks it `failed`. **That terminal `failed` row
   * is the dead letter** — it retains the payload, the attempt count, and the
   * last error, which is everything needed to diagnose or replay it. A
   * separate dead-letter table would hold the same columns under a different
   * name.
   *
   * Returns which happened, so the caller knows whether to mark the document
   * failed or leave it queued for another attempt.
   */
  async fail(
    jobId: string,
    error: string,
    retryAt: Date | null,
    executor: Executor = db,
  ): Promise<{ deadLettered: boolean }> {
    const row = await executor
      .updateTable('jobs')
      .set({
        // `retryAt === null` is the caller saying "do not retry this" — either
        // the budget is spent or the failure is permanent and retrying would
        // burn attempts on an outcome that cannot change.
        status: retryAt === null ? ('failed' as const) : ('pending' as const),
        // Left untouched on a dead letter. A terminal row's `run_after` means
        // nothing, and rewriting it would destroy the record of when the last
        // retry had been scheduled for.
        ...(retryAt === null ? {} : { run_after: retryAt.toISOString() }),
        // The lease is released either way. A `failed` row holding a lease
        // would look to the reaper like work in progress.
        locked_at: null,
        locked_by: null,
        // Truncated: a provider stack trace can be tens of kilobytes, and the
        // useful part is always the first line.
        error: error.slice(0, 2000),
      })
      .where('id', '=', jobId)
      .returning('status')
      .executeTakeFirstOrThrow();

    return { deadLettered: row.status === 'failed' };
  },

  /**
   * Extends the lease on a job that is still running.
   *
   * Without it the reaper's lease has to be longer than the slowest
   * conceivable job — and a lease sized for a 200-page PDF is a lease that
   * leaves a crashed worker's jobs stranded for that same duration. A
   * heartbeat lets the lease be short *and* long jobs survive: the reaper
   * reclaims anything whose worker stopped reporting, which is exactly the
   * condition worth reclaiming.
   *
   * Guarded on `locked_by`, so a worker whose job the reaper already took back
   * cannot silently re-extend a lease it no longer holds. The return value
   * tells the caller it lost the job.
   */
  async heartbeat(jobId: string, workerId: string, executor: Executor = db): Promise<boolean> {
    const result = await executor
      .updateTable('jobs')
      .set({ locked_at: sql<string>`now()` })
      .where('id', '=', jobId)
      .where('locked_by', '=', workerId)
      .where('status', '=', 'processing')
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  },

  /**
   * Returns expired leases to `pending` — the reaper from docs/03-backend.md §7.
   *
   * This is the entire crash-recovery story. A worker killed mid-job leaves
   * its row in `processing` with a stale `locked_at`; nothing else will ever
   * touch it, because claiming only looks at `pending`. The reaper is what
   * turns "the process died" into "the job runs again" without human
   * intervention.
   *
   * The attempt count is deliberately **not** reset. A job that repeatedly
   * kills its worker is exactly the job that must eventually stop being
   * retried, and forgiving the attempts on reclaim would make it immortal.
   */
  async requeueStale(leaseMs: number, executor: Executor = db): Promise<number> {
    const cutoff = new Date(Date.now() - leaseMs).toISOString();

    const result = await executor
      .updateTable('jobs')
      .set({ status: 'pending', locked_at: null, locked_by: null })
      .where('status', '=', 'processing')
      .where('locked_at', '<', sql<Date>`${cutoff}::timestamptz`)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  },

  /** Pending jobs of a type, for assertions and operational visibility. */
  async countPending(type: JobType, executor: Executor = db): Promise<number> {
    const row = await executor
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('type', '=', type)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();

    return row.count;
  },

  /** One job by id, for tests and for an operator inspecting a dead letter. */
  async findById(jobId: string, executor: Executor = db): Promise<Selectable<JobsTable> | null> {
    const row = await executor
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirst();

    return row ?? null;
  },
};

/**
 * Exponential backoff with jitter (docs/03-backend.md §7).
 *
 * The exponent is obvious; the jitter is the part that matters. When a
 * provider returns 429 to twenty concurrent jobs, a bare exponential schedule
 * makes all twenty retry at the identical instant — reproducing the burst that
 * caused the rate limit, and doing it again on the next attempt. Full jitter
 * spreads them across the window, which is what actually lets the upstream
 * recover.
 *
 * Capped so the fifth attempt is not scheduled for tomorrow.
 */
export function backoffDelayMs(attempts: number, baseMs = 1_000, maxMs = 5 * 60_000): number {
  const ceiling = Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
  // Full jitter: uniform over [0, ceiling]. Preferred over ±20% because it
  // decorrelates retries completely rather than merely blurring the spike.
  return Math.floor(Math.random() * ceiling);
}
