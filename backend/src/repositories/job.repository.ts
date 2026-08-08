import { db } from '../db/pool.js';
import { JOB_PAYLOAD_SCHEMAS, type JobType } from '../domain/jobs/job-types.js';
import type { Executor } from './user.repository.js';

export interface EnqueueOptions {
  /** Higher runs first among rows that are due. */
  priority?: number;
  /** Delays eligibility — used by a retry's backoff in M4. */
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * SQL for `jobs`.
 *
 * Only `enqueue` exists, and that is deliberate. Claiming (`FOR UPDATE SKIP
 * LOCKED`), completing, failing, and reaping expired leases are the worker's
 * operations, and this milestone has no worker — writing them now would add
 * four untested methods that nothing calls, which is the placeholder code the
 * quality bar rejects.
 *
 * The queue exists at all because docs/05-rag-and-chat.md §2.1 requires the
 * document row and its job to be written in **one transaction**: "enqueueing
 * outside the transaction produces either orphan jobs referencing rows that
 * were rolled back, or documents that are never processed." Retrofitting that
 * atomicity onto an upload path that already shipped without it is exactly the
 * kind of change that gets deferred forever.
 */
export const jobRepository = {
  /**
   * Writes one job.
   *
   * Takes an `Executor` with no default, unlike every other repository here.
   * That is the point: enqueueing outside a transaction is the bug §2.1
   * names, so the signature makes a caller pass one rather than silently
   * getting the pool.
   *
   * The payload is validated against its type's schema before it is written.
   * A payload is JSONB read later by a different process, so the only place it
   * can be checked cheaply is here — a worker that discovers a malformed
   * payload can neither interpret it nor skip it.
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

  /** Pending jobs of a type, for assertions and for operational visibility. */
  async countPending(type: JobType, executor: Executor = db): Promise<number> {
    const row = await executor
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('type', '=', type)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();

    return row.count;
  },
};
