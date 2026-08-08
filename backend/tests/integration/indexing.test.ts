import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/index.js';
import { JOB_TYPES } from '../../src/domain/jobs/job-types.js';
import { ProviderError } from '../../src/providers/embedding/embedding-provider.interface.js';
import { embeddingProvider } from '../../src/providers/embedding/embedding.factory.js';
import { chunkRepository } from '../../src/repositories/chunk.repository.js';
import { jobRepository } from '../../src/repositories/job.repository.js';
import { usageRepository } from '../../src/repositories/usage.repository.js';
import { runIngestion } from '../../src/services/documents/ingestion.pipeline.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { API_PREFIX, request } from '../helpers/app.js';
import { db } from '../helpers/database.js';
import { fakeVectorStore, vectorsForDocument, vectorsForUser } from '../helpers/vector.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createVerifiedUser, type TestUser } from '../factories/user.factory.js';
import { buildDocx } from '../fixtures/docx-builder.js';
import { buildPdf } from '../fixtures/pdf-builder.js';

/**
 * M4b end to end: chunking, embedding, and vector storage, over real uploads.
 *
 * Runs on the fake embedding provider and the in-memory vector store, both of
 * which are deterministic (`tests/setup/test-env.ts`). That is what makes
 * idempotency assertable at all — a random provider would write different
 * vectors on every run, and "the retry wrote the same vectors" could not be
 * expressed.
 *
 * The real `ChromaVectorStore` is verified separately against a live server in
 * `chroma.store.test.ts`.
 */

const LONG_TEXT = [
  '# Employment Agreement',
  '',
  'This agreement is made between the company and the employee, and it governs every aspect of the working relationship described in the sections that follow.',
  '',
  '## 3. Termination',
  '',
  'Either party may terminate this agreement with thirty days written notice delivered to the address of record. The notice period begins on the day after delivery is confirmed.',
  '',
  '## 4. Compensation',
  '',
  'Base salary is paid monthly in arrears. Any bonus is discretionary and is determined by the board at the end of each financial year.',
].join('\n');

async function uploadText(user: TestUser, body = LONG_TEXT): Promise<string> {
  const document = await uploadDocument(user.session.accessToken, {
    bytes: FIXTURES.markdown(body),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });
  return document.id;
}

function worker(id = 'index-worker'): IngestionWorker {
  return new IngestionWorker({ workerId: id, concurrency: 1 });
}

async function readDocument(documentId: string): Promise<{
  status: string;
  chunkCount: number;
  embeddingModel: string | null;
  embeddingDims: number | null;
  processedAt: Date | null;
}> {
  const row = await db
    .selectFrom('documents')
    .select(['status', 'chunk_count', 'embedding_model', 'embedding_dims', 'processed_at'])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow();

  return {
    status: row.status,
    chunkCount: row.chunk_count,
    embeddingModel: row.embedding_model,
    embeddingDims: row.embedding_dims,
    processedAt: row.processed_at,
  };
}

describe('READY criteria', () => {
  it('reaches ready only with chunks, embeddings, and vectors all in place', async () => {
    /*
      docs/05-rag-and-chat.md §1: queued → parsing → chunking → embedding →
      ready. `ready` promises a document that can be asked questions, which
      requires all three — anything less and the document answers nothing while
      claiming otherwise.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const document = await readDocument(documentId);
    const chunks = await chunkRepository.findByDocument(documentId);
    const vectors = vectorsForDocument(user.id, documentId);

    expect(document.status).toBe('ready');
    expect(chunks.length).toBeGreaterThan(0);
    expect(vectors).toHaveLength(chunks.length);
    for (const chunk of chunks) expect(chunk.vectorId).not.toBeNull();
  });

  it('records the embedding model and dimensions on the document', async () => {
    /*
      §2.4: "embedding spaces are not comparable across models". Recorded per
      document so a provider change is detectable and the affected documents
      can be re-indexed, rather than silently degrading every answer.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    expect(await readDocument(documentId)).toMatchObject({
      embeddingModel: embeddingProvider.model,
      embeddingDims: embeddingProvider.dimensions,
    });
  });

  it('records chunk_count and processed_at', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const document = await readDocument(documentId);
    const actual = await chunkRepository.countByDocument(documentId);

    expect(document.chunkCount).toBe(actual);
    expect(document.processedAt).not.toBeNull();
  });

  /*
    The `chunkCount === 0` branch in the pipeline is deliberately not tested
    here.

    It is a defensive guard, and unreachable through real input: the chunker
    returns an empty list only for empty text, and every parser already raises
    `EMPTY_CONTENT` before that point (see `parsers.test.ts`). Reaching it in a
    test requires stubbing the chunker module itself, and a spy on an ES module
    namespace does not reliably restore — the first version of this file did
    exactly that and silently emptied every document in the six tests that
    followed. A guard that costs four lines is not worth a mock that
    invalidates its neighbours.
  */
});

describe('chunk persistence', () => {
  it('writes every documented column', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const [first] = await chunkRepository.findByDocument(documentId);

    expect(first).toMatchObject({
      documentId,
      userId: user.id,
      chunkIndex: 0,
    });
    expect(first?.content.length).toBeGreaterThan(0);
    expect(first?.tokenCount).toBeGreaterThan(0);
  });

  it('carries the section path onto the chunk row for citations', async () => {
    // §2.3: section path is one of the four fields that make a citation point
    // somewhere specific rather than at a whole document.
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const chunks = await chunkRepository.findByDocument(documentId);

    expect(chunks.some((chunk) => chunk.sectionPath?.includes('Termination'))).toBe(true);
  });

  it('numbers chunks contiguously from zero', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const chunks = await chunkRepository.findByDocument(documentId);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  it('populates the generated tsvector for lexical search', async () => {
    // `content_tsv` is the BM25 half of hybrid search (§3.2). It is generated
    // by Postgres, so this proves the column is actually being populated by the
    // insert path rather than left null.
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const row = await db
      .selectFrom('document_chunks')
      .select(sql<string>`content_tsv::text`.as('tsv'))
      .where('document_id', '=', documentId)
      .executeTakeFirstOrThrow();

    expect(row.tsv.length).toBeGreaterThan(0);
  });

  it('scopes chunks to the owning user', async () => {
    // The denormalized tenant filter for lexical search (docs/04 §1.1).
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    for (const chunk of await chunkRepository.findByDocument(documentId)) {
      expect(chunk.userId).toBe(user.id);
    }
  });
});

describe('vector storage', () => {
  it('indexes into the user’s own collection', async () => {
    /*
      One collection per user (§2.5). Tenant isolation is structural rather
      than dependent on a metadata filter being present on every query.
    */
    const alice = await createVerifiedUser();
    const bob = await createVerifiedUser();

    await uploadText(alice);
    await uploadText(bob);
    await worker().drain();

    const store = fakeVectorStore();
    const names = store.collectionNames();

    expect(names).toContain(`${env.CHROMA_COLLECTION_PREFIX}${alice.id}`);
    expect(names).toContain(`${env.CHROMA_COLLECTION_PREFIX}${bob.id}`);
    expect(vectorsForUser(alice.id).every((record) => record.metadata.userId === alice.id)).toBe(
      true,
    );
  });

  it('uses the deterministic vector id derived from document and chunk index', async () => {
    // docs/03-backend.md §7. This is what makes a retry overwrite rather than
    // append.
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    for (const record of vectorsForDocument(user.id, documentId)) {
      expect(record.id).toBe(`${documentId}:${String(record.metadata.chunkIndex)}`);
    }
  });

  it('stores the citation metadata §2.5 lists', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const [record] = vectorsForDocument(user.id, documentId);
    const chunks = await chunkRepository.findByDocument(documentId);

    expect(record?.metadata).toMatchObject({
      chunkId: chunks[0]?.id,
      documentId,
      userId: user.id,
      chunkIndex: 0,
    });
    expect(record?.metadata.documentName.length).toBeGreaterThan(0);
  });

  it('stores the passage, not the section-path-enriched form', async () => {
    /*
      §2.3 prepends the section path to the *embedded* text only. The stored
      text is what a source panel renders, and showing "# Employment Agreement >
      ## Termination" glued to the top of every quoted passage would be wrong.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const chunks = await chunkRepository.findByDocument(documentId);
    const records = vectorsForDocument(user.id, documentId);

    for (const [index, record] of records.entries()) {
      expect(record.text).toBe(chunks[index]?.content);
    }
  });

  it('embeds the enriched text even though it stores the bare passage', async () => {
    /*
      "The single cheapest accuracy win available" (§2.3). Verified by
      comparing against what the deterministic provider produces for each form:
      the stored vector must match the *enriched* text's vector, not the bare
      passage's.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const chunks = await chunkRepository.findByDocument(documentId);
    const withSection = chunks.find((chunk) => chunk.sectionPath !== null);
    expect(withSection).toBeDefined();

    const record = vectorsForDocument(user.id, documentId).find(
      (entry) => entry.metadata.chunkIndex === withSection?.chunkIndex,
    );

    const [enriched] = await embeddingProvider.embed([
      `${withSection?.sectionPath ?? ''}\n\n${withSection?.content ?? ''}`,
    ]);
    const [bare] = await embeddingProvider.embed([withSection?.content ?? '']);

    expect(record?.embedding).toEqual(enriched);
    expect(record?.embedding).not.toEqual(bare);
  });

  it('records a usage event so cost is visible', async () => {
    // docs/06-roadmap.md R3: "usage_events recording from M3 so cost is visible
    // rather than discovered on a bill".
    const user = await createVerifiedUser();
    await uploadText(user);

    await worker().runOnce();

    const summary = await usageRepository.summaryFor(user.id);
    const embedding = summary.find((entry) => entry.kind === 'embedding');

    expect(embedding?.model).toBe(embeddingProvider.model);
    expect(embedding?.inputTokens).toBeGreaterThan(0);
  });
});

describe('idempotency and duplicate prevention', () => {
  it('produces identical chunks and vectors when re-run', async () => {
    /*
      The property the whole recovery story rests on. Determinism plus upsert
      on `(document_id, chunk_index)` means a retry converges rather than
      accumulating.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    const firstChunks = await chunkRepository.findByDocument(documentId);
    const firstVectors = vectorsForDocument(user.id, documentId);

    // Force a full re-run from the top.
    await db
      .updateTable('documents')
      .set({ status: 'queued' })
      .where('id', '=', documentId)
      .execute();
    await db
      .updateTable('document_chunks')
      .set({ vector_id: null })
      .where('document_id', '=', documentId)
      .execute();

    await runIngestion({ documentId, userId: user.id });

    const secondChunks = await chunkRepository.findByDocument(documentId);
    const secondVectors = vectorsForDocument(user.id, documentId);

    expect(secondChunks.map((chunk) => chunk.content)).toEqual(
      firstChunks.map((chunk) => chunk.content),
    );
    // Row ids survive: the vector store holds them as `chunkId`, and a new id
    // per attempt would leave every citation pointing at a row that is gone.
    expect(secondChunks.map((chunk) => chunk.id)).toEqual(firstChunks.map((chunk) => chunk.id));
    expect(secondVectors.map((record) => record.embedding)).toEqual(
      firstVectors.map((record) => record.embedding),
    );
  });

  it('does not multiply chunk rows across reruns', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();
    const before = await chunkRepository.countByDocument(documentId);

    for (let run = 0; run < 3; run += 1) {
      await db
        .updateTable('documents')
        .set({ status: 'queued' })
        .where('id', '=', documentId)
        .execute();
      await runIngestion({ documentId, userId: user.id });
    }

    expect(await chunkRepository.countByDocument(documentId)).toBe(before);
  });

  it('does not multiply vectors across reruns', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();
    const before = vectorsForDocument(user.id, documentId).length;

    await db
      .updateTable('documents')
      .set({ status: 'queued' })
      .where('id', '=', documentId)
      .execute();
    await db
      .updateTable('document_chunks')
      .set({ vector_id: null })
      .where('document_id', '=', documentId)
      .execute();
    await runIngestion({ documentId, userId: user.id });

    expect(vectorsForDocument(user.id, documentId)).toHaveLength(before);
  });

  it('removes surplus chunks when a rerun produces fewer', async () => {
    /*
      The other half of convergence. A retuned `CHUNK_SIZE` or a fixed parser
      can produce fewer chunks; without the trailing delete, the surplus rows
      survive with their vectors and are retrieved as passages that are no
      longer in the document.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    await worker().runOnce();

    const original = await chunkRepository.countByDocument(documentId);
    expect(original).toBeGreaterThan(0);

    // Inject phantom chunks past the real count, as a previous run would have.
    await chunkRepository.upsertMany([
      {
        documentId,
        userId: user.id,
        chunkIndex: original,
        content: 'A stale chunk from a previous run.',
        tokenCount: 9,
        pageNumber: null,
        sectionPath: null,
        charStart: 0,
        charEnd: 34,
      },
    ]);
    expect(await chunkRepository.countByDocument(documentId)).toBe(original + 1);

    await db
      .updateTable('documents')
      .set({ status: 'queued' })
      .where('id', '=', documentId)
      .execute();
    await runIngestion({ documentId, userId: user.id });

    expect(await chunkRepository.countByDocument(documentId)).toBe(original);
  });

  it('skips a document that already reached ready', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await worker().runOnce();

    expect(await runIngestion({ documentId, userId: user.id })).toEqual({
      kind: 'skipped',
      reason: 'already-processed',
    });
  });
});

describe('partial embedding recovery', () => {
  it('resumes from the chunks that still lack vectors', async () => {
    /*
      §2.4 and R3: embedding is the one step that costs real money, so a job
      that died after 300 of 500 chunks must cost the remaining 200 — not all
      500 again.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    await worker().runOnce();

    const chunks = await chunkRepository.findByDocument(documentId);
    expect(chunks.length).toBeGreaterThan(1);

    // Simulate a crash mid-embedding: the first chunk kept its vector, the
    // rest did not.
    await db
      .updateTable('document_chunks')
      .set({ vector_id: null })
      .where('document_id', '=', documentId)
      .where('chunk_index', '>', 0)
      .execute();
    await db
      .updateTable('documents')
      .set({ status: 'embedding' })
      .where('id', '=', documentId)
      .execute();

    const embedSpy = vi.spyOn(embeddingProvider, 'embed');

    await runIngestion({ documentId, userId: user.id });

    // Only the unembedded chunks were sent to the provider.
    const embeddedTexts = embedSpy.mock.calls.flatMap(([texts]) => texts);
    expect(embeddedTexts).toHaveLength(chunks.length - 1);

    expect((await readDocument(documentId)).status).toBe('ready');
    for (const chunk of await chunkRepository.findByDocument(documentId)) {
      expect(chunk.vectorId).not.toBeNull();
    }

    embedSpy.mockRestore();
  });

  it('does not re-parse when resuming from embedding', async () => {
    // Chunk rows are already in Postgres; re-reading the file and re-chunking
    // is work with no output.
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    await worker().runOnce();

    await db
      .updateTable('document_chunks')
      .set({ vector_id: null })
      .where('document_id', '=', documentId)
      .execute();
    await db
      .updateTable('documents')
      .set({ status: 'embedding' })
      .where('id', '=', documentId)
      .execute();

    const upsertSpy = vi.spyOn(chunkRepository, 'upsertMany');

    await runIngestion({ documentId, userId: user.id });

    expect(upsertSpy).not.toHaveBeenCalled();
    upsertSpy.mockRestore();
  });

  it('keeps already-embedded chunks when a later attempt fails', async () => {
    /*
      Progress is durable per batch, not held until the end. A run that fails
      partway must leave what it already wrote — embedding is the step that
      costs money (docs/06-roadmap.md R3), and discarding paid-for vectors on
      every failure makes a flaky provider unaffordable.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    await worker().runOnce();

    const chunks = await chunkRepository.findByDocument(documentId);
    expect(chunks.length).toBeGreaterThan(1);

    // Half the chunks lose their vectors, as a crash mid-run would leave them.
    await db
      .updateTable('document_chunks')
      .set({ vector_id: null })
      .where('document_id', '=', documentId)
      .where('chunk_index', '>', 0)
      .execute();
    await db
      .updateTable('documents')
      .set({ status: 'embedding' })
      .where('id', '=', documentId)
      .execute();

    const embedSpy = vi
      .spyOn(embeddingProvider, 'embed')
      .mockRejectedValue(new ProviderError('fake', 'still down', false, 503));

    await expect(runIngestion({ documentId, userId: user.id })).rejects.toThrow('still down');

    // Chunk 0's vector survived the failed attempt.
    const afterFailure = await chunkRepository.findByDocument(documentId);
    expect(afterFailure[0]?.vectorId).not.toBeNull();

    embedSpy.mockRestore();
  });

  it('never marks a chunk embedded when its vectors did not land', async () => {
    /*
      The write ordering — embed, upsert vectors, *then* record `vector_id` —
      is load-bearing, and this is the direction that must not fail.

      A crash between the upsert and the record costs one wasted embedding call
      on retry and nothing else, because the deterministic vector id makes the
      re-upsert an overwrite. The reverse order is unrecoverable: chunks are
      marked embedded whose vectors were never written, the resume query then
      skips them forever, and the document reports `ready` with passages that
      are permanently absent from the index.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    const upsertSpy = vi
      .spyOn(fakeVectorStore(), 'upsert')
      .mockRejectedValue(new Error('vector store unreachable'));

    await worker().runOnce();

    // Not one chunk may claim a vector the store never accepted.
    for (const chunk of await chunkRepository.findByDocument(documentId)) {
      expect(chunk.vectorId).toBeNull();
    }
    expect((await readDocument(documentId)).status).not.toBe('ready');

    upsertSpy.mockRestore();
  });

  it('recovers fully once the vector store comes back', async () => {
    // The corollary: nothing was marked embedded, so the retry re-embeds and
    // re-indexes everything and the document completes.
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    const { id: jobId } = await db
      .selectFrom('jobs')
      .select('id')
      .where(sql<boolean>`payload->>'documentId' = ${documentId}`)
      .executeTakeFirstOrThrow();

    const upsertSpy = vi
      .spyOn(fakeVectorStore(), 'upsert')
      .mockRejectedValueOnce(new Error('vector store unreachable'));

    await worker().runOnce();
    upsertSpy.mockRestore();

    await sql`UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);
    await worker().runOnce();

    const chunks = await chunkRepository.findByDocument(documentId);
    expect((await readDocument(documentId)).status).toBe('ready');
    expect(vectorsForDocument(user.id, documentId)).toHaveLength(chunks.length);
  });

  it('leaves the document mid-pipeline, not failed, when the provider is down', async () => {
    // Provider outages are infrastructure, not document, problems. Burning the
    // row on one is how a user loses a file to a transient blip.
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    const embedSpy = vi
      .spyOn(embeddingProvider, 'embed')
      .mockRejectedValue(new ProviderError('fake', 'service unavailable', false, 503));

    await worker().runOnce();

    const document = await readDocument(documentId);
    expect(document.status).toBe('embedding');
    expect(document.processedAt).toBeNull();

    embedSpy.mockRestore();
  });

  it('completes on the next attempt once the provider recovers', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    const { id: jobId } = await db
      .selectFrom('jobs')
      .select('id')
      .where(sql<boolean>`payload->>'documentId' = ${documentId}`)
      .executeTakeFirstOrThrow();

    const embedSpy = vi
      .spyOn(embeddingProvider, 'embed')
      .mockRejectedValueOnce(new ProviderError('fake', 'temporarily down', false, 503));

    await worker().runOnce();
    expect((await readDocument(documentId)).status).toBe('embedding');

    embedSpy.mockRestore();
    await sql`UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);

    await worker().runOnce();

    expect((await readDocument(documentId)).status).toBe('ready');
  });
});

describe('worker restart', () => {
  it('recovers a document stranded mid-embedding by a killed worker', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    const { id: jobId } = await db
      .selectFrom('jobs')
      .select('id')
      .where(sql<boolean>`payload->>'documentId' = ${documentId}`)
      .executeTakeFirstOrThrow();

    // The worker claimed the job, moved the document to `embedding`, then died.
    await jobRepository.claim('dead-worker', [JOB_TYPES.INGEST_DOCUMENT]);
    await db
      .updateTable('documents')
      .set({ status: 'embedding' })
      .where('id', '=', documentId)
      .execute();
    await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${jobId}`.execute(
      db,
    );

    const live = worker('live-worker');
    expect(await live.reap()).toBe(1);
    expect(await live.runOnce()).toBe(true);

    expect((await readDocument(documentId)).status).toBe('ready');
    expect((await jobRepository.findById(jobId))?.status).toBe('completed');
  });

  it('recovers a document stranded mid-chunking', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    const { id: jobId } = await db
      .selectFrom('jobs')
      .select('id')
      .where(sql<boolean>`payload->>'documentId' = ${documentId}`)
      .executeTakeFirstOrThrow();

    await jobRepository.claim('dead-worker', [JOB_TYPES.INGEST_DOCUMENT]);
    await db
      .updateTable('documents')
      .set({ status: 'chunking' })
      .where('id', '=', documentId)
      .execute();
    await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${jobId}`.execute(
      db,
    );

    const live = worker('live-worker');
    await live.reap();
    await live.runOnce();

    // `chunking` is a legal entry state for the chunk stage, so the retry
    // proceeds rather than refusing its own transition.
    expect((await readDocument(documentId)).status).toBe('ready');
  });

  it('does not duplicate vectors after a restart', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    await worker().runOnce();

    const before = vectorsForDocument(user.id, documentId).length;

    // A second worker re-runs the same document from `chunking`.
    await db
      .updateTable('documents')
      .set({ status: 'chunking' })
      .where('id', '=', documentId)
      .execute();
    await db
      .updateTable('document_chunks')
      .set({ vector_id: null })
      .where('document_id', '=', documentId)
      .execute();

    await runIngestion({ documentId, userId: user.id });

    expect(vectorsForDocument(user.id, documentId)).toHaveLength(before);
  });
});

describe('deletion', () => {
  it('removes the document’s vectors along with its rows', async () => {
    // docs/04 §1.2: deletion is a real delete plus a vector-store purge. A
    // document removed from Postgres but left in the index keeps appearing in
    // answers, which breaks the privacy promise invisibly.
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    await worker().runOnce();

    expect(vectorsForDocument(user.id, documentId).length).toBeGreaterThan(0);

    await request()
      .delete(`${API_PREFIX}/documents/${documentId}`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(204);

    expect(vectorsForDocument(user.id, documentId)).toHaveLength(0);
  });

  it('cascades chunk rows with the document', async () => {
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    await worker().runOnce();

    await request()
      .delete(`${API_PREFIX}/documents/${documentId}`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(204);

    expect(await chunkRepository.countByDocument(documentId)).toBe(0);
  });

  it('leaves another document’s vectors alone', async () => {
    const user = await createVerifiedUser();
    const keep = await uploadText(user);
    const remove = await uploadText(user, `${LONG_TEXT}\n\nA second distinct document body.`);
    await worker().drain();

    const keptBefore = vectorsForDocument(user.id, keep).length;
    expect(keptBefore).toBeGreaterThan(0);

    await request()
      .delete(`${API_PREFIX}/documents/${remove}`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(204);

    expect(vectorsForDocument(user.id, remove)).toHaveLength(0);
    expect(vectorsForDocument(user.id, keep)).toHaveLength(keptBefore);
  });
});

describe('POST /documents/:id/retry', () => {
  async function failed(user: TestUser): Promise<string> {
    const documentId = await uploadText(user);
    await db
      .updateTable('documents')
      .set({ status: 'failed', error_code: 'CORRUPT_FILE', error_message: 'damaged' })
      .where('id', '=', documentId)
      .execute();
    await db.deleteFrom('jobs').execute();
    return documentId;
  }

  it('resets a failed document to queued and enqueues a job', async () => {
    const user = await createVerifiedUser();
    const documentId = await failed(user);

    const response = await request()
      .post(`${API_PREFIX}/documents/${documentId}/retry`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(202);

    expect(response.body).toMatchObject({ id: documentId, status: 'queued', errorCode: null });
    expect(await jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).toBe(1);
  });

  it('drives the retried document all the way to ready', async () => {
    const user = await createVerifiedUser();
    const documentId = await failed(user);

    await request()
      .post(`${API_PREFIX}/documents/${documentId}/retry`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(202);

    await worker().runOnce();

    expect((await readDocument(documentId)).status).toBe('ready');
  });

  it('refuses a document that is not failed', async () => {
    // A document mid-pipeline already has a job; a second would put two
    // workers on it to no benefit.
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);

    await request()
      .post(`${API_PREFIX}/documents/${documentId}/retry`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(409);
  });

  it('enqueues one job when two retries arrive together', async () => {
    // Guarded on `failed` inside the transaction, so the second finds no row.
    const user = await createVerifiedUser();
    const documentId = await failed(user);

    const results = await Promise.all([
      request()
        .post(`${API_PREFIX}/documents/${documentId}/retry`)
        .set('Authorization', `Bearer ${user.session.accessToken}`),
      request()
        .post(`${API_PREFIX}/documents/${documentId}/retry`)
        .set('Authorization', `Bearer ${user.session.accessToken}`),
    ]);

    expect(results.filter((response) => response.status === 202)).toHaveLength(1);
    expect(await jobRepository.countPending(JOB_TYPES.INGEST_DOCUMENT)).toBe(1);
  });

  it('keeps chunks that already have vectors, so a retry does not re-embed them', async () => {
    /*
      The reset is deliberately partial. A document that failed at embedding
      call 400 of 500 keeps its 400 — deleting them would throw away work that
      is still valid and cost money to redo.
    */
    const user = await createVerifiedUser();
    const documentId = await uploadText(user);
    await worker().runOnce();

    const embeddedBefore = (await chunkRepository.findByDocument(documentId)).filter(
      (chunk) => chunk.vectorId !== null,
    ).length;

    await db
      .updateTable('documents')
      .set({ status: 'failed', error_code: 'X', error_message: 'y' })
      .where('id', '=', documentId)
      .execute();

    await request()
      .post(`${API_PREFIX}/documents/${documentId}/retry`)
      .set('Authorization', `Bearer ${user.session.accessToken}`)
      .expect(202);

    const stillEmbedded = (await chunkRepository.findByDocument(documentId)).filter(
      (chunk) => chunk.vectorId !== null,
    ).length;

    expect(stillEmbedded).toBe(embeddedBefore);
  });

  it('refuses another user’s document with a 404', async () => {
    // Indistinguishable from "no such document" — a 403 would confirm the id.
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const documentId = await failed(owner);

    await request()
      .post(`${API_PREFIX}/documents/${documentId}/retry`)
      .set('Authorization', `Bearer ${stranger.session.accessToken}`)
      .expect(404);
  });
});

describe('all four formats index end to end', () => {
  const cases = [
    {
      name: 'PDF',
      bytes: () =>
        buildPdf({
          pages: [
            ['The termination clause governs the notice period for both parties involved here.'],
            ['Compensation is reviewed annually by the board at the end of the financial year.'],
          ],
        }),
      filename: () => uniqueFilename('.pdf'),
      contentType: 'application/pdf',
    },
    {
      name: 'DOCX',
      bytes: () =>
        buildDocx([
          { text: 'Lumora Handbook', level: 1 },
          { text: 'Hybrid search combines BM25 with dense vectors for better recall overall.' },
        ]),
      filename: () => uniqueFilename('.docx'),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    {
      name: 'Markdown',
      bytes: () => FIXTURES.markdown(LONG_TEXT),
      filename: () => uniqueFilename('.md'),
      contentType: 'text/markdown',
    },
    {
      name: 'TXT',
      bytes: () =>
        FIXTURES.text(
          'The retrieval pipeline combines lexical and vector search to answer questions.\n',
        ),
      filename: () => uniqueFilename('.txt'),
      contentType: 'text/plain',
    },
  ];

  for (const testCase of cases) {
    it(`chunks, embeds, and indexes a ${testCase.name}`, async () => {
      const user = await createVerifiedUser();
      const document = await uploadDocument(user.session.accessToken, {
        bytes: testCase.bytes(),
        filename: testCase.filename(),
        contentType: testCase.contentType,
      });

      await worker().runOnce();

      const chunks = await chunkRepository.findByDocument(document.id);
      const vectors = vectorsForDocument(user.id, document.id);

      expect((await readDocument(document.id)).status).toBe('ready');
      expect(chunks.length).toBeGreaterThan(0);
      expect(vectors).toHaveLength(chunks.length);
    });
  }
});
