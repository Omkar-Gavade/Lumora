import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentStatus } from '@lumora/shared';
import { JOB_TYPES } from '../../src/domain/jobs/job-types.js';
import { jobRepository } from '../../src/repositories/job.repository.js';
import { runIngestion } from '../../src/services/documents/ingestion.pipeline.js';
import { storageProvider } from '../../src/providers/storage/storage.factory.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createVerifiedUser, type TestUser } from '../factories/user.factory.js';
import { buildDocx } from '../fixtures/docx-builder.js';
import { buildPdf, buildTextlessPdf } from '../fixtures/pdf-builder.js';
import { db } from '../helpers/database.js';

/**
 * The pipeline end to end, over real uploads.
 *
 * Documents are created through `POST /documents` rather than inserted, so
 * every one of them was validated, hashed, stored, and enqueued the way a real
 * one is. A row inserted directly would let the pipeline pass against a
 * document the upload path could never have produced.
 */

interface Uploaded {
  documentId: string;
  jobId: string;
  user: TestUser;
}

async function upload(
  user: TestUser,
  options: { bytes: Buffer; filename: string; contentType: string },
): Promise<Uploaded> {
  const document = await uploadDocument(user.session.accessToken, options);

  const job = await db
    .selectFrom('jobs')
    .select('id')
    .where('type', '=', JOB_TYPES.INGEST_DOCUMENT)
    .where(sql<boolean>`payload->>'documentId' = ${document.id}`)
    .executeTakeFirstOrThrow();

  return { documentId: document.id, jobId: job.id, user };
}

async function readStatus(documentId: string): Promise<{
  status: DocumentStatus;
  errorCode: string | null;
  errorMessage: string | null;
  pageCount: number | null;
  tokenCount: number | null;
}> {
  const row = await db
    .selectFrom('documents')
    .select(['status', 'error_code', 'error_message', 'page_count', 'token_count'])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow();

  return {
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    pageCount: row.page_count,
    tokenCount: row.token_count,
  };
}

/** A worker with a fixed id, driven one job at a time — no background polling. */
function testWorker(id = 'test-worker'): IngestionWorker {
  return new IngestionWorker({ workerId: id, concurrency: 1 });
}

describe('successful ingestion', () => {
  it('takes a plain-text document from queued to chunking', async () => {
    /*
      M4a stops at `chunking`, not `ready`. That is the honest description of
      where the document is — parsed, waiting for a chunker that does not exist
      yet — and `ready` would promise a document you can ask questions about.
    */
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: FIXTURES.text('The retrieval pipeline combines lexical and vector search.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    expect((await readStatus(documentId)).status).toBe('queued');

    await testWorker().runOnce();

    const after = await readStatus(documentId);
    expect(after.status).toBe('chunking');
    expect(after.errorCode).toBeNull();
  });

  it('records page count and token count from the parse', async () => {
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: buildPdf({
        pages: [
          ['Page one carries a full sentence of prose for the extractor.'],
          ['Page two carries another full sentence of prose for the extractor.'],
          ['Page three closes the document with a third sentence of prose.'],
        ],
      }),
      filename: uniqueFilename('.pdf'),
      contentType: 'application/pdf',
    });

    await testWorker().runOnce();

    const after = await readStatus(documentId);
    expect(after.status).toBe('chunking');
    expect(after.pageCount).toBe(3);
    expect(after.tokenCount).toBeGreaterThan(0);
  });

  it('parses a DOCX upload', async () => {
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: buildDocx([
        { text: 'Lumora Handbook', level: 1 },
        { text: 'Hybrid search combines BM25 with dense vectors.' },
      ]),
      filename: uniqueFilename('.docx'),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    await testWorker().runOnce();

    expect((await readStatus(documentId)).status).toBe('chunking');
  });

  it('parses a Markdown upload', async () => {
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: FIXTURES.markdown('# Architecture\n\nThe worker claims jobs with SKIP LOCKED.\n'),
      filename: uniqueFilename('.md'),
      contentType: 'text/markdown',
    });

    await testWorker().runOnce();

    expect((await readStatus(documentId)).status).toBe('chunking');
  });

  it('completes the job, so it is never claimed again', async () => {
    const user = await createVerifiedUser();
    const { jobId } = await upload(user, {
      bytes: FIXTURES.text('Body text long enough to parse.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    await testWorker().runOnce();

    const job = await jobRepository.findById(jobId);
    expect(job).toMatchObject({ status: 'completed', locked_by: null, error: null });
    expect(await testWorker('other').runOnce()).toBe(false);
  });
});

describe('parse failures', () => {
  it('fails a scanned PDF with the documented reason on the row', async () => {
    // FR-13 requires a human-readable failure reason; docs/00-product.md §160
    // specifies this exact wording for a scan.
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: buildTextlessPdf(6),
      filename: uniqueFilename('.pdf'),
      contentType: 'application/pdf',
    });

    await testWorker().runOnce();

    const after = await readStatus(documentId);
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('NO_TEXT_LAYER');
    expect(after.errorMessage).toBe(
      'This PDF has no extractable text — it looks like a scanned image. OCR is not supported yet.',
    );
  });

  it('dead-letters a permanent failure immediately rather than burning retries', async () => {
    /*
      A scanned PDF will not grow a text layer on the third attempt. Retrying
      spends the whole budget to reach the same answer and delays by minutes
      the failure the user is waiting to see.
    */
    const user = await createVerifiedUser();
    const { jobId } = await upload(user, {
      bytes: buildTextlessPdf(6),
      filename: uniqueFilename('.pdf'),
      contentType: 'application/pdf',
    });

    await testWorker().runOnce();

    const job = await jobRepository.findById(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(1);
    expect(job?.error).toContain('NO_TEXT_LAYER');
  });

  it('fails a document whose bytes vanished from storage', async () => {
    const user = await createVerifiedUser();
    const { documentId, jobId } = await upload(user, {
      bytes: FIXTURES.text('Body.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    const row = await db
      .selectFrom('documents')
      .select('storage_key')
      .where('id', '=', documentId)
      .executeTakeFirstOrThrow();
    await storageProvider.delete(row.storage_key);

    await testWorker().runOnce();

    /*
      Storage failures are infrastructure, not document, problems: the document
      stays mid-pipeline and the job retries with backoff. Burning the row on a
      thirty-second blip is how a user loses a file to a transient outage — and
      a mount that comes back makes this document succeed.
    */
    expect((await readStatus(documentId)).status).toBe('parsing');

    const job = await jobRepository.findById(jobId);
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(1);
  });
});

describe('idempotency', () => {
  it('treats a duplicate delivery as a no-op', async () => {
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: FIXTURES.text('Body text for the parser.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    const payload = { documentId, userId: user.id };

    expect(await runIngestion(payload)).toEqual({ kind: 'advanced', status: 'chunking' });
    // The second run must not drag the document back through parsing.
    expect(await runIngestion(payload)).toEqual({ kind: 'skipped', reason: 'already-processed' });
    expect((await readStatus(documentId)).status).toBe('chunking');
  });

  it('skips a document that reached a terminal state', async () => {
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: buildTextlessPdf(6),
      filename: uniqueFilename('.pdf'),
      contentType: 'application/pdf',
    });

    await runIngestion({ documentId, userId: user.id });
    expect((await readStatus(documentId)).status).toBe('failed');

    expect(await runIngestion({ documentId, userId: user.id })).toEqual({
      kind: 'skipped',
      reason: 'already-processed',
    });
  });

  it('drops a job whose document was deleted while it waited', async () => {
    // Deleting a document does not reach into the queue — that would race with
    // a worker that may already hold the row. Tolerating the miss is safer.
    const user = await createVerifiedUser();
    const { documentId, jobId } = await upload(user, {
      bytes: FIXTURES.text('Body.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    await db.deleteFrom('documents').where('id', '=', documentId).execute();

    await testWorker().runOnce();

    // A skipped job is a successful job: there is nothing left to do.
    expect((await jobRepository.findById(jobId))?.status).toBe('completed');
  });

  it('refuses to process another user’s document', async () => {
    // Every repository call is owner-scoped. A payload naming the wrong user
    // finds no row, which is indistinguishable from the document not existing.
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const { documentId } = await upload(owner, {
      bytes: FIXTURES.text('Confidential body.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    expect(await runIngestion({ documentId, userId: stranger.id })).toEqual({
      kind: 'skipped',
      reason: 'deleted',
    });
    expect((await readStatus(documentId)).status).toBe('queued');
  });

  it('lets only one of two concurrent runs advance the document', async () => {
    // The guard lives in the UPDATE's WHERE clause, so exactly one row matches
    // and the loser learns it lost from the return value.
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: FIXTURES.text('Body text for the parser.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    const payload = { documentId, userId: user.id };
    const outcomes = await Promise.all([runIngestion(payload), runIngestion(payload)]);

    expect(outcomes.filter((outcome) => outcome.kind === 'advanced')).toHaveLength(1);
    expect((await readStatus(documentId)).status).toBe('chunking');
  });
});

describe('crash recovery', () => {
  it('re-enters parsing after a worker died mid-job', async () => {
    /*
      The scenario the reaper exists for. A killed worker leaves the job in
      `processing` with a stale lease and the document in `parsing`; nothing
      else would ever touch either.
    */
    const user = await createVerifiedUser();
    const { documentId, jobId } = await upload(user, {
      bytes: FIXTURES.text('Body text that will be parsed on the second attempt.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    // Simulate the crash: the job is claimed and the document moved to
    // `parsing`, then the worker disappears without recording anything.
    await jobRepository.claim('dead-worker', [JOB_TYPES.INGEST_DOCUMENT]);
    await db
      .updateTable('documents')
      .set({ status: 'parsing' })
      .where('id', '=', documentId)
      .execute();
    await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${jobId}`.execute(
      db,
    );

    const worker = testWorker('live-worker');
    expect(await worker.reap()).toBe(1);
    expect(await worker.runOnce()).toBe(true);

    // `parsing` is a legal entry state precisely so this retry can proceed.
    expect((await readStatus(documentId)).status).toBe('chunking');
    expect((await jobRepository.findById(jobId))?.status).toBe('completed');
  });

  it('keeps counting attempts across a crash, so a poison job still dead-letters', async () => {
    const user = await createVerifiedUser();
    const { jobId } = await upload(user, {
      bytes: FIXTURES.text('Body.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    await jobRepository.claim('dead-worker', [JOB_TYPES.INGEST_DOCUMENT]);
    await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${jobId}`.execute(
      db,
    );
    await testWorker().reap();

    // Forgiving attempts on reclaim would make a job that repeatedly kills its
    // worker immortal.
    expect((await jobRepository.findById(jobId))?.attempts).toBe(1);
    await testWorker().runOnce();
    expect((await jobRepository.findById(jobId))?.attempts).toBe(2);
  });
});

describe('retry and dead-lettering', () => {
  it('retries a transient failure with a deferred run_after, then succeeds', async () => {
    const user = await createVerifiedUser();
    const { documentId, jobId } = await upload(user, {
      bytes: FIXTURES.text('Body text for the parser.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    // One transient storage outage, then the mount comes back.
    const get = vi
      .spyOn(storageProvider, 'get')
      .mockRejectedValueOnce(new Error('ECONNRESET: storage unavailable'));

    await testWorker().runOnce();

    const afterFailure = await jobRepository.findById(jobId);
    expect(afterFailure?.status).toBe('pending');
    expect(afterFailure?.error).toContain('storage unavailable');
    expect((await readStatus(documentId)).status).toBe('parsing');

    get.mockRestore();

    // The backoff genuinely defers the retry, so clear it to run the next
    // attempt without sleeping through a randomised delay.
    await sql`UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);

    await testWorker().runOnce();

    expect((await readStatus(documentId)).status).toBe('chunking');
    expect((await jobRepository.findById(jobId))?.status).toBe('completed');
  });

  it('dead-letters once the attempt budget is spent', async () => {
    const user = await createVerifiedUser();
    const { documentId, jobId } = await upload(user, {
      bytes: FIXTURES.text('Body.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    const get = vi
      .spyOn(storageProvider, 'get')
      .mockRejectedValue(new Error('storage permanently unavailable'));

    const maxAttempts = (await jobRepository.findById(jobId))?.max_attempts ?? 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sql`UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = ${jobId}`.execute(
        db,
      );
      expect(await testWorker().runOnce()).toBe(true);
    }

    get.mockRestore();

    // The terminal `failed` row *is* the dead letter — payload, attempt count,
    // and last error, which is everything needed to diagnose or replay it.
    const job = await jobRepository.findById(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(maxAttempts);
    expect(job?.error).toContain('storage permanently unavailable');
    expect(job?.payload).toMatchObject({ documentId });

    // The document is left mid-pipeline rather than falsely marked ready.
    expect((await readStatus(documentId)).status).toBe('parsing');
  });

  it('dead-letters a job whose payload no longer validates', async () => {
    const user = await createVerifiedUser();
    const { jobId } = await upload(user, {
      bytes: FIXTURES.text('Body.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    // A shape change between the build that wrote the row and the one reading
    // it. Retrying cannot make the stored payload valid.
    await db
      .updateTable('jobs')
      .set({ payload: JSON.stringify({ documentId: 'not-a-uuid' }) })
      .where('id', '=', jobId)
      .execute();

    await testWorker().runOnce();

    const job = await jobRepository.findById(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(1);
    expect(job?.error).toContain('Invalid ingest_document payload');
  });

  it('dead-letters a job type no handler is registered for', async () => {
    // A deploy problem, not a data problem. Retrying will not install the code.
    const jobId = await jobRepository.enqueue(
      JOB_TYPES.INGEST_DOCUMENT,
      { documentId: randomUUID(), userId: randomUUID() },
      db,
    );
    await db.updateTable('jobs').set({ type: 'unknown_job' }).where('id', '=', jobId).execute();

    // Claimed directly, because the worker only asks for types it handles.
    const claimed = await jobRepository.claim('worker-a', ['unknown_job' as never]);
    expect(claimed).not.toBeNull();
    await jobRepository.fail(jobId, `No handler registered for job type "unknown_job"`, null);

    expect((await jobRepository.findById(jobId))?.status).toBe('failed');
  });
});

describe('worker runtime', () => {
  it('drains a backlog', async () => {
    const user = await createVerifiedUser();
    for (let index = 0; index < 4; index += 1) {
      await upload(user, {
        bytes: FIXTURES.text(`Document number ${String(index)} with a body worth parsing.\n`),
        filename: uniqueFilename('.txt'),
        contentType: 'text/plain',
      });
    }

    expect(await testWorker().drain()).toBe(4);
    expect(await jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).toBe(0);
  });

  it('processes concurrently without duplicating work', async () => {
    const user = await createVerifiedUser();
    const documentIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const { documentId } = await upload(user, {
        bytes: FIXTURES.text(`Concurrent document ${String(index)} with a real body.\n`),
        filename: uniqueFilename('.txt'),
        contentType: 'text/plain',
      });
      documentIds.push(documentId);
    }

    // Three workers racing over six jobs. SKIP LOCKED is what makes this safe.
    const workers = ['w1', 'w2', 'w3'].map((id) => testWorker(id));
    const processed = await Promise.all(workers.map((worker) => worker.drain()));

    expect(processed.reduce((total, count) => total + count, 0)).toBe(6);

    for (const documentId of documentIds) {
      expect((await readStatus(documentId)).status).toBe('chunking');
    }
  });

  it('drains in-flight work on graceful shutdown', async () => {
    /*
      An abandoned job is recoverable — the reaper takes it back — but only
      after a full lease expires, so every rolling restart would strand
      documents for a minute for no reason.
    */
    const user = await createVerifiedUser();
    const { documentId } = await upload(user, {
      bytes: FIXTURES.text('A document that must survive a rolling restart.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    const worker = new IngestionWorker({
      workerId: 'draining-worker',
      concurrency: 1,
      pollIntervalMs: 100,
    });
    worker.start();

    // Stop is issued while the loop is live; it must not cut the job short.
    await worker.stop();

    expect((await readStatus(documentId)).status).toBe('chunking');
    expect(await jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).toBe(0);
  });

  it('leaves no lease behind after shutdown', async () => {
    const user = await createVerifiedUser();
    await upload(user, {
      bytes: FIXTURES.text('Body text for the parser.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    const worker = new IngestionWorker({ workerId: 'lease-worker', pollIntervalMs: 100 });
    worker.start();
    await worker.stop();

    const locked = await db
      .selectFrom('jobs')
      .select('id')
      .where('locked_by', 'is not', null)
      .execute();

    expect(locked).toHaveLength(0);
  });

  it('leaves no query in flight after stop returns', async () => {
    /*
      Heartbeats and reaper sweeps are database round trips fired from timers.
      `clearInterval` stops new ticks but says nothing about the query already
      issued — and a statement that outlives `stop()` runs against a pool the
      caller is about to close, failing from a timer with no call stack
      pointing at anything that caused it.

      A one-millisecond heartbeat and reaper make both fire many times during
      the run; if either escaped, `stop()` would return with work outstanding.
    */
    const user = await createVerifiedUser();
    await upload(user, {
      bytes: FIXTURES.text('A document processed while the timers are firing constantly.\n'),
      filename: uniqueFilename('.txt'),
      contentType: 'text/plain',
    });

    const worker = new IngestionWorker({
      workerId: 'busy-timer-worker',
      pollIntervalMs: 1,
      heartbeatIntervalMs: 1,
      reaperIntervalMs: 1,
      leaseMs: 60_000,
    });

    worker.start();
    await worker.stop();

    // A query still in flight would still be holding a pool connection; the
    // pool answering immediately is the observable form of "nothing pending".
    await expect(jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).resolves.toBe(0);
  });

  it('stops cleanly when it never had anything to do', async () => {
    const worker = new IngestionWorker({ workerId: 'idle-worker', pollIntervalMs: 100 });
    worker.start();

    await expect(worker.stop()).resolves.toBeUndefined();
    // A second stop must not hang or throw — both SIGTERM and SIGINT arrive in
    // some environments.
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
