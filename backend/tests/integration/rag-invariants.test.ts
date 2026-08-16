import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RRF_K } from '@lumora/shared';
import { reciprocalRankFusion, applyRelevanceFloor } from '../../src/services/retrieval/fusion.js';
import { PACKAGE_ROOT } from '../../src/lib/paths.js';
import { chunkRepository } from '../../src/repositories/chunk.repository.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createVerifiedUser } from '../factories/user.factory.js';
import { db } from '../../src/db/pool.js';
import { env } from '../../src/config/index.js';
import { logger } from '../../src/lib/logger.js';
import { vectorStore } from '../../src/providers/vector/vector.factory.js';
import { embeddingProvider } from '../../src/providers/embedding/embedding.factory.js';
import { collectionFor } from '../../src/providers/vector/vector-store.interface.js';
import { HybridRetriever } from '../../src/services/retrieval/hybrid.retriever.js';
import { VectorRetriever } from '../../src/services/retrieval/vector.retriever.js';
import { Bm25Retriever } from '../../src/services/retrieval/bm25.retriever.js';
import { documentService } from '../../src/services/documents/document.service.js';
import { jobRepository } from '../../src/repositories/job.repository.js';
import { JOB_TYPES } from '../../src/domain/jobs/job-types.js';

/**
 * RAG invariants that the existing suites do not already cover.
 *
 * `retrieval.test.ts` (41 cases) and `fusion.test.ts` (30 cases) already prove
 * vector retrieval, lexical retrieval, fusion, dedup, tenant isolation,
 * deletion, degradation in both directions, and all three abstention reasons.
 * Repeating them here would add runtime and no information. What follows is
 * only what M7's evaluation exposed and nothing yet asserts.
 */

describe('the relevance floor filters on cosine similarity, not the fused score', () => {
  /*
    Pinning down which field the floor reads, because getting this wrong is
    cheap and expensive: M7's first evaluation swept the fused RRF score, found
    that no threshold could ever separate anything, and concluded the mechanism
    was structurally broken. It is not — `applyRelevanceFloor` compares
    `vectorScore`, the cosine similarity from the semantic half.

    The genuinely surprising part is the null bypass, which is asserted below.
  */

  it('drops a chunk whose cosine similarity is under the floor', () => {
    const fused = reciprocalRankFusion(
      [{ source: 'vector', chunks: [chunk('weak', 0.2)] }, { source: 'bm25', chunks: [] }],
      RRF_K,
    );

    expect(applyRelevanceFloor(fused, 0.5)).toHaveLength(0);
    expect(applyRelevanceFloor(fused, 0.1)).toHaveLength(1);
  });

  it('keeps a lexical-only hit regardless of the floor', () => {
    /*
      **A lexical-only chunk has no cosine score and bypasses the floor
      entirely.** That is deliberate — BM25 exists to catch exact identifiers
      the embedding misses, and scoring it against a semantic threshold would
      discard precisely the hits it was added for. But it does mean the floor
      cannot force abstention on its own: a query that matches any term at all
      still returns something.
    */
    const fused = reciprocalRankFusion(
      [{ source: 'vector', chunks: [] }, { source: 'bm25', chunks: [chunk('lexical', 0.9)] }],
      RRF_K,
    );

    expect(fused[0]?.vectorScore).toBeNull();
    expect(applyRelevanceFloor(fused, 1)).toHaveLength(1);
  });

  it('admits everything at -1', () => {
    // Why -1 and not 0: cosine ranges over [-1, 1], so 0 looks neutral and is
    // not — it silently discards every chunk with negative similarity.
    const fused = reciprocalRankFusion(
      [{ source: 'vector', chunks: [chunk('a', -0.4), chunk('b', 0.3)] }, { source: 'bm25', chunks: [] }],
      RRF_K,
    );

    expect(applyRelevanceFloor(fused, -1)).toHaveLength(2);
    expect(applyRelevanceFloor(fused, 0)).toHaveLength(1);
  });
});

describe('degradation is reported, not just survived', () => {
  /*
    Added because a mutation survived: deleting `degraded.push(source)` from the
    hybrid retriever broke nothing. The existing degradation tests assert that
    results still come back and that `vectorCandidates` is 0 — both of which
    stay true when the *reporting* of the failure is removed.

    That gap matters more than it sounds. `vectorCandidates: 0` is exactly the
    ambiguity `degraded[]` was introduced to resolve: without it, "the corpus
    has no semantic match" and "the vector store is down" are the same number.
    An unasserted signal is one refactor away from silently disappearing, which
    is how M7 lost hours to a `vec 0` that meant something else entirely.
  */

  it('names the vector half when it fails', async () => {
    const user = await createVerifiedUser();
    await seedOneDocument(user.session.accessToken);

    const brokenVector = {
      name: 'vector' as const,
      retrieve: () => Promise.reject(new Error('vector store unreachable')),
    };

    const result = await new HybridRetriever(brokenVector, new Bm25Retriever()).retrieve(
      { text: 'widgets', userId: user.id, topK: 6 },
      logger,
    );

    expect(result.stats.degraded).toContain('vector');
  });

  it('names the lexical half when it fails', async () => {
    const user = await createVerifiedUser();
    const brokenLexical = {
      name: 'bm25' as const,
      retrieve: () => Promise.reject(new Error('full-text unavailable')),
    };

    const result = await new HybridRetriever(
      new VectorRetriever(vectorStore, embeddingProvider),
      brokenLexical,
    ).retrieve({ text: 'widgets', userId: user.id, topK: 6 }, logger);

    expect(result.stats.degraded).toContain('bm25');
  });

  it('reports nothing degraded on a healthy search', async () => {
    // The control. Without it, a `degraded` that always contained both names
    // would satisfy the two assertions above.
    const user = await createVerifiedUser();
    await seedOneDocument(user.session.accessToken);

    const result = await new HybridRetriever(
      new VectorRetriever(vectorStore, embeddingProvider),
      new Bm25Retriever(),
    ).retrieve({ text: 'widgets', userId: user.id, topK: 6 }, logger);

    expect(result.stats.degraded).toEqual([]);
  });
});

describe('document deletion purges vectors from the store', () => {
  it('leaves no vector behind for a deleted document', async () => {
    /*
      Added because a mutation survived: stubbing out `vectorStore.deleteByDocument`
      broke no test. Retrieval-after-delete still looked correct because the
      lexical half reads Postgres, where the chunk rows really were gone — so
      the orphaned vectors sat in Chroma, invisible to every assertion.

      They are not harmless. The vector retriever answers entirely from vector
      metadata by design (§2.5, "no second database round trip"), so an orphaned
      vector is a citation to deleted content that retrieval will happily serve.
      Asserted against the store directly rather than through retrieval, because
      going through retrieval is what hid it.
    */
    const user = await createVerifiedUser();
    const uploaded = await seedOneDocument(user.session.accessToken);

    const collection = collectionFor(user.id, env.CHROMA_COLLECTION_PREFIX);
    const before = await vectorStore.query(collection, await embeddingProvider.embedQuery('widgets'), 20);
    expect(before.some((match) => match.metadata.documentId === uploaded.id)).toBe(true);

    await documentService.delete(user.id, uploaded.id);

    const after = await vectorStore.query(collection, await embeddingProvider.embedQuery('widgets'), 20);
    expect(after.some((match) => match.metadata.documentId === uploaded.id)).toBe(false);
  });
});

describe('re-index idempotency', () => {
  it('re-running the pipeline neither duplicates chunks nor strands markers', async () => {
    /*
      The invariant `npm run reindex` depends on. A rebuild that appended
      instead of overwriting would double the corpus, halve every recall
      number, and duplicate every citation — visibly wrong only in aggregate,
      which is the worst way for it to be wrong.
    */
    const user = await createVerifiedUser();
    const uploaded = await uploadDocument(user.session.accessToken, {
      bytes: FIXTURES.markdown('# Title\n\nSome durable body text about widgets.\n'),
      filename: uniqueFilename('.md'),
      contentType: 'text/markdown',
    });
    await new IngestionWorker({ workerId: 'idem-1', concurrency: 1 }).drain();

    const first = await chunkRepository.countByDocument(uploaded.id);
    expect(first).toBeGreaterThan(0);

    // Exactly what the reindex script does: clear the vector markers and send
    // the document back through the pipeline from the top.
    await db
      .updateTable('document_chunks')
      .set({ vector_id: null })
      .where('document_id', '=', uploaded.id)
      .execute();
    await db
      .updateTable('documents')
      .set({ status: 'queued' })
      .where('id', '=', uploaded.id)
      .execute();
    await enqueueIngest(uploaded.id, user.id);
    await new IngestionWorker({ workerId: 'idem-2', concurrency: 1 }).drain();

    expect(await chunkRepository.countByDocument(uploaded.id)).toBe(first);

    // Every chunk re-embedded: a leftover NULL means the rebuild silently
    // skipped chunks and the index is now partial.
    const unembedded = await chunkRepository.findUnembedded(uploaded.id);
    expect(unembedded).toHaveLength(0);
  });
});

describe('eval:seed is replace-not-append', () => {
  it('re-seeding the same corpus leaves counts unchanged and no orphan vectors', async () => {
    /*
      The property the evaluation harness depends on for its numbers to mean
      anything. If seeding appended, a second run would double the corpus and
      halve every recall figure — a regression that looks like retrieval getting
      worse rather than like the harness being wrong.

      This exercises the seeder's actual strategy (delete every document, then
      upload again) rather than calling `eval/seed.ts`, which reads `docs/` and
      would spend live Gemini quota inside the test suite.
    */
    const user = await createVerifiedUser();

    const first = await seedOneDocument(user.session.accessToken);
    const firstChunks = await chunkRepository.countByDocument(first.id);
    expect(firstChunks).toBeGreaterThan(0);

    // The seeder's replace step.
    const listed = await documentService.list(user.id, { limit: 100 });
    for (const document of listed.items) await documentService.delete(user.id, document.id);

    const second = await seedOneDocument(user.session.accessToken);
    const after = await documentService.list(user.id, { limit: 100 });

    expect(after.items).toHaveLength(1);
    expect(await chunkRepository.countByDocument(second.id)).toBe(firstChunks);

    // No vector survives from the replaced generation.
    const collection = collectionFor(user.id, env.CHROMA_COLLECTION_PREFIX);
    const matches = await vectorStore.query(
      collection,
      await embeddingProvider.embedQuery('widgets'),
      50,
    );
    expect(matches.every((match) => match.metadata.documentId === second.id)).toBe(true);

    // And every returned vector is distinct — a duplicated id would serve the
    // same chunk twice and inflate its apparent support in an answer.
    const ids = matches.map((match) => match.metadata.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the evaluation dataset', () => {
  const dataset = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, 'eval', 'dataset.json'), 'utf8'),
  ) as {
    version: number;
    corpus: { documents: string[] };
    cases: {
      id: string;
      kind: string;
      query: string;
      expectedDocuments: string[];
      expectAbstain: boolean;
    }[];
  };

  it('loads and is versioned', () => {
    expect(dataset.version).toBeGreaterThan(0);
    expect(dataset.cases.length).toBeGreaterThan(0);
  });

  it('has unique case ids', () => {
    // Duplicated ids silently overwrite each other in any per-case report.
    const ids = dataset.cases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references only documents that are in the declared corpus', () => {
    /*
      The guard against the dataset rotting. An expected-evidence reference to
      a file that is not indexed can never be satisfied, so the case would
      report as a permanent retrieval failure and quietly depress recall
      forever.
    */
    for (const testCase of dataset.cases) {
      for (const document of testCase.expectedDocuments) {
        expect(dataset.corpus.documents).toContain(document);
      }
    }
  });

  it('never expects both evidence and abstention', () => {
    // A case that wants both is not a test, it is a contradiction — and it
    // would score as passing under whichever metric is read first.
    for (const testCase of dataset.cases) {
      if (testCase.expectAbstain) expect(testCase.expectedDocuments).toHaveLength(0);
      else expect(testCase.expectedDocuments.length).toBeGreaterThan(0);
    }
  });

  it('covers every documented question kind', () => {
    const kinds = new Set(dataset.cases.map((testCase) => testCase.kind));
    for (const required of [
      'factual',
      'section-specific',
      'multi-chunk',
      'multi-document',
      'citation-sensitive',
      'adversarial',
      'unanswerable',
    ]) {
      expect(kinds).toContain(required);
    }
  });

  it('keeps unanswerable cases genuinely unanswerable, separate from unindexed ones', () => {
    /*
      `unanswerable` means "no document anywhere answers this".
      `off-corpus-current-index` means "the answer exists in a document that is
      not indexed right now". Collapsing them would make abstention accuracy
      improve on its own the moment the missing documents are indexed, which
      would look like a retrieval improvement and be nothing of the sort.
    */
    const unindexed = dataset.cases.filter(
      (testCase) => testCase.kind === 'off-corpus-current-index',
    );
    for (const testCase of unindexed) {
      expect(testCase.expectAbstain).toBe(true);
      expect(testCase).toHaveProperty('answerableInFullCorpus');
    }
  });
});

async function seedOneDocument(accessToken: string) {
  const uploaded = await uploadDocument(accessToken, {
    bytes: FIXTURES.markdown('# Widgets\n\nDurable body text about widgets and gadgets.\n'),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });
  await new IngestionWorker({ workerId: 'seed-one', concurrency: 1 }).drain();
  return uploaded;
}

function chunk(chunkId: string, score = 0.5) {
  return {
    chunkId,
    documentId: 'doc-1',
    documentTitle: 'doc.md',
    text: `text for ${chunkId}`,
    chunkIndex: 0,
    tokenCount: 4,
    pageNumber: null,
    sectionPath: null,
    score,
  };
}

function enqueueIngest(documentId: string, userId: string): Promise<unknown> {
  // Static imports and an explicit executor: a dynamic import here resolves
  // before the integration setup has built the pool, so `db` arrives undefined.
  return jobRepository.enqueue(JOB_TYPES.INGEST_DOCUMENT, { documentId, userId }, db);
}
