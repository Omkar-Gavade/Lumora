import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { JOB_TYPES } from '../../src/domain/jobs/job-types.js';
import { jobRepository } from '../../src/repositories/job.repository.js';
import { db } from '../helpers/database.js';

/**
 * The durable queue from docs/03-backend.md §7.
 *
 * These run against a real Postgres because the properties under test *are*
 * Postgres properties — `FOR UPDATE SKIP LOCKED`, row-level locking, `now()`
 * evaluated by the server. A mocked database would assert the shape of the SQL
 * rather than what it does, and the whole point of choosing Postgres as the
 * broker was the behaviour, not the syntax.
 */

/**
 * A schema-valid payload with no user or document row behind it.
 *
 * `jobs` has no foreign keys — deliberately, so the queue can be reasoned
 * about and tested as a queue. Creating real users here would add an argon2
 * hash per job and prove nothing about claiming.
 */
async function enqueueIngest(
  options: { priority?: number; runAfter?: Date; maxAttempts?: number } = {},
): Promise<{ jobId: string; documentId: string; userId: string }> {
  const documentId = randomUUID();
  const userId = randomUUID();

  const jobId = await jobRepository.enqueue(
    JOB_TYPES.INGEST_DOCUMENT,
    { documentId, userId },
    db,
    options,
  );

  return { jobId, documentId, userId };
}

const INGEST = [JOB_TYPES.INGEST_DOCUMENT];

describe('enqueue', () => {
  it('validates the payload against the type’s schema', async () => {
    // A worker reads rows written by a possibly-different build. Rejecting a
    // bad shape here is what lets it trust what it reads.
    await expect(
      jobRepository.enqueue(JOB_TYPES.INGEST_DOCUMENT, { documentId: 'not-a-uuid' }, db),
    ).rejects.toThrow();
  });

  it('starts a job pending, unlocked, and with no attempts', async () => {
    const { jobId } = await enqueueIngest();
    const row = await jobRepository.findById(jobId);

    expect(row).toMatchObject({
      status: 'pending',
      attempts: 0,
      locked_at: null,
      locked_by: null,
      error: null,
      completed_at: null,
    });
  });
});

describe('claim', () => {
  it('locks a due job to the claiming worker and counts the attempt', async () => {
    const { jobId } = await enqueueIngest();

    const claimed = await jobRepository.claim('worker-a', INGEST);

    expect(claimed?.id).toBe(jobId);
    // Incremented on claim, not on failure: a worker killed mid-job never
    // reaches its failure handler, so counting there would let a job that
    // reliably crashes the process retry forever.
    expect(claimed?.attempts).toBe(1);

    const row = await jobRepository.findById(jobId);
    expect(row).toMatchObject({ status: 'processing', locked_by: 'worker-a' });
    expect(row?.locked_at).not.toBeNull();
  });

  it('returns null when nothing is due', async () => {
    expect(await jobRepository.claim('worker-a', INGEST)).toBeNull();
  });

  it('never hands the same job to two workers', async () => {
    // The core safety property. Without SKIP LOCKED, a select-then-update has
    // a window in which both workers see the same id and the same document is
    // processed twice.
    await enqueueIngest();

    const [first, second] = await Promise.all([
      jobRepository.claim('worker-a', INGEST),
      jobRepository.claim('worker-b', INGEST),
    ]);

    const claimed = [first, second].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
  });

  it('gives every job to exactly one worker under contention', async () => {
    const jobIds = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      jobIds.add((await enqueueIngest()).jobId);
    }

    // Twelve claims for eight jobs: four must come back empty, and no id may
    // appear twice.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => jobRepository.claim(`worker-${String(index)}`, INGEST)),
    );

    const claimedIds = results.filter((job) => job !== null).map((job) => job.id);

    expect(claimedIds).toHaveLength(8);
    expect(new Set(claimedIds).size).toBe(8);
    expect(new Set(claimedIds)).toEqual(jobIds);
  });

  it('skips a locked row instead of blocking on it', async () => {
    /*
      This is the test that actually pins `SKIP LOCKED`.

      The concurrency tests above pass with a plain `FOR UPDATE` too: claims
      are single autocommit statements, so a lock is released before the next
      claim can observe it, and blocking is invisible. Holding the lock open in
      a transaction is the only way to tell the two apart — with `SKIP LOCKED`
      the second claim returns `null` immediately; without it, the statement
      blocks until the transaction ends.

      That difference is the whole reason for the clause. A worker pool that
      blocks on a locked row serializes behind the slowest job in the queue.
    */
    await enqueueIngest();

    await db.transaction().execute(async (trx) => {
      await trx.selectFrom('jobs').selectAll().forUpdate().execute();

      const blocked = Symbol('blocked');
      const outcome = await Promise.race([
        jobRepository.claim('worker-b', INGEST),
        // Generous: the assertion is "returns promptly", not "returns in 2s".
        // A claim that blocks waits for the transaction, which outlives this.
        new Promise((resolve) => setTimeout(() => resolve(blocked), 2_000)),
      ]);

      expect(outcome).toBeNull();
    });
  });

  it('skips a job whose run_after is in the future', async () => {
    // The mechanism a retry's backoff relies on.
    await enqueueIngest({ runAfter: new Date(Date.now() + 60_000) });

    expect(await jobRepository.claim('worker-a', INGEST)).toBeNull();
  });

  it('claims a job whose run_after has passed', async () => {
    const { jobId } = await enqueueIngest({ runAfter: new Date(Date.now() - 1_000) });

    expect((await jobRepository.claim('worker-a', INGEST))?.id).toBe(jobId);
  });

  it('takes higher priority first', async () => {
    const low = await enqueueIngest({ priority: 0 });
    const high = await enqueueIngest({ priority: 10 });

    expect((await jobRepository.claim('worker-a', INGEST))?.id).toBe(high.jobId);
    expect((await jobRepository.claim('worker-a', INGEST))?.id).toBe(low.jobId);
  });

  it('takes the oldest first within a priority', async () => {
    const first = await enqueueIngest();
    const second = await enqueueIngest();

    expect((await jobRepository.claim('worker-a', INGEST))?.id).toBe(first.jobId);
    expect((await jobRepository.claim('worker-a', INGEST))?.id).toBe(second.jobId);
  });

  it('ignores types the worker did not ask for', async () => {
    await enqueueIngest();

    expect(await jobRepository.claim('worker-a', [])).toBeNull();
  });

  it('does not re-claim a job that is already processing', async () => {
    await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);

    expect(await jobRepository.claim('worker-b', INGEST)).toBeNull();
  });
});

describe('complete', () => {
  it('marks the job done, releases the lease, and clears the error', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);
    await jobRepository.fail(jobId, 'transient blip', new Date(Date.now() - 1_000));
    await jobRepository.claim('worker-a', INGEST);

    await jobRepository.complete(jobId);

    const row = await jobRepository.findById(jobId);
    expect(row).toMatchObject({ status: 'completed', locked_by: null, locked_at: null, error: null });
    expect(row?.completed_at).not.toBeNull();
  });

  it('is terminal — a completed job is never claimed again', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);
    await jobRepository.complete(jobId);

    expect(await jobRepository.claim('worker-b', INGEST)).toBeNull();
  });
});

describe('fail', () => {
  it('returns the job to pending with a future run_after when a retry is scheduled', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);

    const retryAt = new Date(Date.now() + 30_000);
    const { deadLettered } = await jobRepository.fail(jobId, 'boom', retryAt);

    expect(deadLettered).toBe(false);

    const row = await jobRepository.findById(jobId);
    expect(row).toMatchObject({ status: 'pending', locked_by: null, locked_at: null });
    expect(row?.error).toBe('boom');
    // The retry is genuinely deferred, not immediately re-claimable.
    expect(await jobRepository.claim('worker-b', INGEST)).toBeNull();
  });

  it('dead-letters when no retry is scheduled', async () => {
    // docs/03-backend.md §7: the terminal `failed` row *is* the dead letter —
    // it keeps the payload, the attempt count, and the last error.
    const { jobId, documentId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);

    const { deadLettered } = await jobRepository.fail(jobId, 'permanent', null);

    expect(deadLettered).toBe(true);

    const row = await jobRepository.findById(jobId);
    expect(row).toMatchObject({ status: 'failed', locked_by: null, locked_at: null, error: 'permanent' });
    expect(row?.attempts).toBe(1);
    expect(row?.payload).toMatchObject({ documentId });
  });

  it('does not resurrect a dead-lettered job', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);
    await jobRepository.fail(jobId, 'permanent', null);

    expect(await jobRepository.claim('worker-b', INGEST)).toBeNull();
  });

  it('truncates an enormous error rather than storing a whole stack trace', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);

    await jobRepository.fail(jobId, 'x'.repeat(10_000), null);

    expect((await jobRepository.findById(jobId))?.error).toHaveLength(2_000);
  });

  it('preserves the previous run_after on a dead letter', async () => {
    const runAfter = new Date(Date.now() - 5_000);
    const { jobId } = await enqueueIngest({ runAfter });
    await jobRepository.claim('worker-a', INGEST);

    await jobRepository.fail(jobId, 'permanent', null);

    // A terminal row's run_after means nothing; rewriting it would destroy the
    // record of when the last retry had been scheduled for.
    expect((await jobRepository.findById(jobId))?.run_after.getTime()).toBe(runAfter.getTime());
  });
});

describe('heartbeat', () => {
  it('extends the lease for the worker holding it', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);

    const before = (await jobRepository.findById(jobId))?.locked_at;
    // Backdated rather than slept through: an assertion on wall-clock time is
    // a flaky assertion, and there is nothing to wait for that the database
    // cannot be told directly.
    await sql`UPDATE jobs SET locked_at = now() - interval '30 seconds' WHERE id = ${jobId}`.execute(db);

    expect(await jobRepository.heartbeat(jobId, 'worker-a')).toBe(true);

    const after = (await jobRepository.findById(jobId))?.locked_at;
    expect(after?.getTime()).toBeGreaterThan((before?.getTime() ?? 0) - 30_000);
  });

  it('refuses a worker that does not hold the lease', async () => {
    // A worker whose job the reaper already took back must not silently
    // re-extend a lease it no longer owns.
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);

    expect(await jobRepository.heartbeat(jobId, 'worker-b')).toBe(false);
  });

  it('refuses once the job is no longer processing', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);
    await jobRepository.complete(jobId);

    expect(await jobRepository.heartbeat(jobId, 'worker-a')).toBe(false);
  });
});

describe('requeueStale (the reaper)', () => {
  it('returns an expired lease to pending', async () => {
    // The entire crash-recovery story: a killed worker leaves its row in
    // `processing`, and nothing else would ever touch it.
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('dead-worker', INGEST);
    await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${jobId}`.execute(db);

    expect(await jobRepository.requeueStale(60_000)).toBe(1);

    const row = await jobRepository.findById(jobId);
    expect(row).toMatchObject({ status: 'pending', locked_by: null, locked_at: null });
  });

  it('makes the reclaimed job claimable again', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('dead-worker', INGEST);
    await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${jobId}`.execute(db);
    await jobRepository.requeueStale(60_000);

    expect((await jobRepository.claim('live-worker', INGEST))?.id).toBe(jobId);
  });

  it('does not reset attempts, so a poison job still dead-letters', async () => {
    // Forgiving the attempts on reclaim would make a job that repeatedly kills
    // its worker immortal.
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('dead-worker', INGEST);
    await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${jobId}`.execute(db);

    await jobRepository.requeueStale(60_000);

    expect((await jobRepository.findById(jobId))?.attempts).toBe(1);
    expect((await jobRepository.claim('live-worker', INGEST))?.attempts).toBe(2);
  });

  it('leaves a live lease alone', async () => {
    await enqueueIngest();
    await jobRepository.claim('live-worker', INGEST);

    expect(await jobRepository.requeueStale(60_000)).toBe(0);
  });

  it('ignores jobs that are not processing', async () => {
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('worker-a', INGEST);
    await jobRepository.complete(jobId);

    expect(await jobRepository.requeueStale(0)).toBe(0);
  });

  it('is safe to run concurrently from several workers', async () => {
    // Every worker sweeps; there is no leader election, because the sweep is
    // one idempotent UPDATE.
    const { jobId } = await enqueueIngest();
    await jobRepository.claim('dead-worker', INGEST);
    await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${jobId}`.execute(db);

    const results = await Promise.all([
      jobRepository.requeueStale(60_000),
      jobRepository.requeueStale(60_000),
      jobRepository.requeueStale(60_000),
    ]);

    expect(results.reduce((total, count) => total + count, 0)).toBe(1);
  });
});

describe('countPending', () => {
  it('counts only pending jobs of the given type', async () => {
    const first = await enqueueIngest();
    await enqueueIngest();

    expect(await jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).toBe(2);

    await jobRepository.claim('worker-a', INGEST);
    expect(await jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).toBe(1);

    await jobRepository.complete(first.jobId);
    expect(await jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).toBe(1);
  });
});

describe('transactional enqueue', () => {
  it('rolls the job back with the transaction that wrote it', async () => {
    /*
      Why `enqueue` takes an `Executor` with no default. This is the property
      docs/05-rag-and-chat.md §2.1 is protecting: an orphan job referencing a
      rolled-back row, or a document that is never processed.
    */
    await expect(
      db.transaction().execute(async (trx) => {
        await jobRepository.enqueue(
          JOB_TYPES.INGEST_DOCUMENT,
          { documentId: randomUUID(), userId: randomUUID() },
          trx,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).toBe(0);
  });
});
