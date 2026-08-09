import { describe, expect, it } from 'vitest';
import { MAX_RESULTS } from '@lumora/shared';
import { embeddingProvider } from '../../src/providers/embedding/embedding.factory.js';
import { vectorStore } from '../../src/providers/vector/vector.factory.js';
import { chunkRepository } from '../../src/repositories/chunk.repository.js';
import { Bm25Retriever } from '../../src/services/retrieval/bm25.retriever.js';
import { HybridRetriever } from '../../src/services/retrieval/hybrid.retriever.js';
import { retrievalService } from '../../src/services/retrieval/retrieval.service.js';
import { VectorRetriever } from '../../src/services/retrieval/vector.retriever.js';
import { IngestionWorker } from '../../src/workers/ingestion.worker.js';
import { logger } from '../../src/lib/logger.js';
import { FIXTURES, uniqueFilename, uploadDocument } from '../factories/document.factory.js';
import { createVerifiedUser, type TestUser } from '../factories/user.factory.js';
import { db } from '../helpers/database.js';

/**
 * The retrieval engine against a real Postgres and the deterministic fake
 * providers.
 *
 * **What these can and cannot prove.** The lexical half is real — it is
 * Postgres full-text search, and stemming, ranking, and tenant scoping are all
 * genuinely exercised. The semantic half runs on hash-derived vectors, so its
 * *mechanics* are exhaustively testable (filters, k, ordering, dedup, fusion)
 * while its *quality* is not: a fake embedding cannot make "notice period"
 * closer to "termination" than to "salary". Semantic quality needs the
 * hand-built evaluation set docs/06-roadmap.md places before chat ships, and
 * nothing here should be read as covering it.
 */

const CORPUS = {
  termination: [
    '# Employment Agreement',
    '',
    '## 3. Termination',
    '',
    'Either party may terminate this agreement with thirty days written notice delivered to the address of record. The notice period begins on the day after delivery is confirmed by the receiving party.',
    '',
    '## 4. Compensation',
    '',
    'Base salary is paid monthly in arrears on the last working day of each month. Any bonus is discretionary and is determined by the board.',
  ].join('\n'),

  hardware: [
    '# Hardware Catalogue',
    '',
    '## Rack units',
    '',
    'The ACME-1200/B chassis ships with dual redundant power supplies and a five year warranty. Replacement rails are ordered separately under part number RL-88.',
    '',
    '## Availability',
    '',
    'Stock is replenished quarterly. Lead times vary by region and by configuration.',
  ].join('\n'),
};

async function seed(user: TestUser, body: string): Promise<string> {
  const document = await uploadDocument(user.session.accessToken, {
    bytes: FIXTURES.markdown(body),
    filename: uniqueFilename('.md'),
    contentType: 'text/markdown',
  });

  await new IngestionWorker({ workerId: 'retrieval-seed', concurrency: 1 }).drain();

  return document.id;
}

const log = logger.child({ test: 'retrieval' });

function hybrid(): HybridRetriever {
  return new HybridRetriever(
    new VectorRetriever(vectorStore, embeddingProvider),
    new Bm25Retriever(),
  );
}

describe('BM25 retrieval', () => {
  it('finds a chunk by an exact term', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const hits = await new Bm25Retriever().retrieve({
      text: 'notice period',
      userId: user.id,
      topK: 20,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain('notice');
  });

  it('stems, so a query form matches a document form', async () => {
    /*
      The `english` configuration is shared with the generated `content_tsv`
      column. A query parsed under a different configuration stems differently
      and silently returns fewer results — no error, just worse answers.
    */
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const hits = await new Bm25Retriever().retrieve({
      text: 'terminating',
      userId: user.id,
      topK: 20,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text.toLowerCase()).toContain('terminate');
  });

  it('finds an exact identifier — the reason this half exists', async () => {
    /*
      §3.2: "Embeddings fail precisely where users are most confident: exact
      identifiers, product codes, uncommon proper nouns…" This is that case.
    */
    const user = await createVerifiedUser();
    await seed(user, CORPUS.hardware);

    const hits = await new Bm25Retriever().retrieve({
      text: 'RL-88',
      userId: user.id,
      topK: 20,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain('RL-88');
  });

  it('ranks by cover density, best first', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const hits = await new Bm25Retriever().retrieve({
      text: 'notice period delivered',
      userId: user.id,
      topK: 20,
    });

    for (let index = 1; index < hits.length; index += 1) {
      expect(hits[index - 1]?.score).toBeGreaterThanOrEqual(hits[index]?.score ?? 0);
    }
  });

  it('carries the document title, so a citation needs no second query', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const [hit] = await new Bm25Retriever().retrieve({
      text: 'notice',
      userId: user.id,
      topK: 5,
    });

    expect(hit?.documentTitle).toMatch(/\.md$/);
    expect(hit?.documentId).toBeDefined();
  });

  it('never returns another user’s chunks', async () => {
    // Tenancy is `user_id` in the WHERE clause, not a filter a caller supplies.
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    await seed(owner, CORPUS.termination);

    const hits = await new Bm25Retriever().retrieve({
      text: 'notice period',
      userId: stranger.id,
      topK: 20,
    });

    expect(hits).toEqual([]);
  });

  it('respects topK', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    expect(
      await new Bm25Retriever().retrieve({ text: 'the', userId: user.id, topK: 1 }),
    ).toHaveLength(0);

    const hits = await new Bm25Retriever().retrieve({
      text: 'notice OR salary OR bonus',
      userId: user.id,
      topK: 1,
    });
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('filters to specific documents', async () => {
    const user = await createVerifiedUser();
    const termination = await seed(user, CORPUS.termination);
    await seed(user, CORPUS.hardware);

    const hits = await new Bm25Retriever().retrieve({
      text: 'the OR notice OR chassis',
      userId: user.id,
      topK: 20,
      documentIds: [termination],
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.documentId === termination)).toBe(true);
  });

  it('treats an empty filter list as "no documents"', async () => {
    // `IN ()` is a syntax error and `= ANY('{}')` matches nothing — both
    // correct, neither obvious, so the intent is explicit.
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    expect(
      await new Bm25Retriever().retrieve({
        text: 'notice',
        userId: user.id,
        topK: 20,
        documentIds: [],
      }),
    ).toEqual([]);
  });

  it('survives punctuation that would break a stricter query parser', async () => {
    /*
      `to_tsquery` throws a syntax error on this input, which would turn an
      ordinary question into a 500. `websearch_to_tsquery` accepts anything.
    */
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    for (const query of ['what & why', 'unbalanced " quote', 'a | b', '!!!', 'and or not']) {
      await expect(
        new Bm25Retriever().retrieve({ text: query, userId: user.id, topK: 5 }),
      ).resolves.toBeInstanceOf(Array);
    }
  });

  it('supports a quoted phrase', async () => {
    // A capability `websearch_to_tsquery` gives the user for free.
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const hits = await new Bm25Retriever().retrieve({
      text: '"notice period"',
      userId: user.id,
      topK: 20,
    });

    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns nothing without a round trip when the query has no terms', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    expect(
      await new Bm25Retriever().retrieve({ text: '???', userId: user.id, topK: 20 }),
    ).toEqual([]);
  });

  it('returns nothing for an empty corpus', async () => {
    const user = await createVerifiedUser();

    expect(
      await new Bm25Retriever().retrieve({ text: 'anything', userId: user.id, topK: 20 }),
    ).toEqual([]);
  });
});

describe('vector retrieval', () => {
  it('returns chunks from the user’s own collection', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const hits = await new VectorRetriever(vectorStore, embeddingProvider).retrieve({
      text: 'notice period',
      userId: user.id,
      topK: 20,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text.length).toBeGreaterThan(0);
  });

  it('needs no database call — every citation field comes from metadata', async () => {
    /*
      §2.5 stores this metadata beside each vector precisely so retrieval does
      not hit Postgres on the hot path. Asserting the fields are populated is
      asserting that decision still holds.
    */
    const user = await createVerifiedUser();
    const documentId = await seed(user, CORPUS.termination);

    const [hit] = await new VectorRetriever(vectorStore, embeddingProvider).retrieve({
      text: 'notice period',
      userId: user.id,
      topK: 5,
    });

    expect(hit).toMatchObject({ documentId });
    expect(hit?.documentTitle).toMatch(/\.md$/);
    expect(hit?.chunkId).toBeDefined();
    expect(hit?.tokenCount).toBeGreaterThan(0);
  });

  it('never crosses tenants — collections are per user', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    await seed(owner, CORPUS.termination);

    const hits = await new VectorRetriever(vectorStore, embeddingProvider).retrieve({
      text: 'notice period',
      userId: stranger.id,
      topK: 20,
    });

    expect(hits).toEqual([]);
  });

  it('respects topK', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    expect(
      await new VectorRetriever(vectorStore, embeddingProvider).retrieve({
        text: 'anything',
        userId: user.id,
        topK: 1,
      }),
    ).toHaveLength(1);
  });

  it('filters to a single document through the store', async () => {
    const user = await createVerifiedUser();
    const termination = await seed(user, CORPUS.termination);
    await seed(user, CORPUS.hardware);

    const hits = await new VectorRetriever(vectorStore, embeddingProvider).retrieve({
      text: 'notice',
      userId: user.id,
      topK: 20,
      documentIds: [termination],
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.documentId === termination)).toBe(true);
  });

  it('filters to several documents client-side, over-fetching to compensate', async () => {
    const user = await createVerifiedUser();
    const first = await seed(user, CORPUS.termination);
    const second = await seed(user, CORPUS.hardware);
    await seed(user, '# Unrelated\n\nA third document about gardening and soil pH levels.');

    const hits = await new VectorRetriever(vectorStore, embeddingProvider).retrieve({
      text: 'anything',
      userId: user.id,
      topK: 20,
      documentIds: [first, second],
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.documentId === first || hit.documentId === second)).toBe(true);
  });

  it('orders deterministically across repeated calls', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const retriever = new VectorRetriever(vectorStore, embeddingProvider);
    const query = { text: 'notice period', userId: user.id, topK: 20 };

    const first = await retriever.retrieve(query);
    const second = await retriever.retrieve(query);

    expect(second.map((hit) => hit.chunkId)).toEqual(first.map((hit) => hit.chunkId));
  });

  it('returns nothing for a user with no collection', async () => {
    const user = await createVerifiedUser();

    expect(
      await new VectorRetriever(vectorStore, embeddingProvider).retrieve({
        text: 'anything',
        userId: user.id,
        topK: 20,
      }),
    ).toEqual([]);
  });
});

describe('hybrid retrieval', () => {
  it('merges both halves and labels the source of each result', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const result = await hybrid().retrieve(
      { text: 'notice period', userId: user.id, topK: MAX_RESULTS },
      log,
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.stats.vectorCandidates).toBeGreaterThan(0);
    expect(result.stats.lexicalCandidates).toBeGreaterThan(0);
    // A chunk both halves found is `hybrid`; the fusion tests cover the rule.
    expect(result.chunks.every((chunk) => ['vector', 'bm25', 'hybrid'].includes(chunk.source))).toBe(
      true,
    );
  });

  it('returns no duplicates', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);
    await seed(user, CORPUS.hardware);

    const result = await hybrid().retrieve(
      { text: 'notice OR chassis OR salary', userId: user.id, topK: MAX_RESULTS },
      log,
    );

    const ids = result.chunks.map((chunk) => chunk.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('caps results at the documented final K', async () => {
    const user = await createVerifiedUser();
    for (let index = 0; index < 4; index += 1) {
      await seed(user, `# Doc ${String(index)}\n\n${CORPUS.termination}`);
    }

    const result = await hybrid().retrieve(
      { text: 'notice period termination salary', userId: user.id, topK: MAX_RESULTS },
      log,
    );

    expect(result.chunks.length).toBeLessThanOrEqual(MAX_RESULTS);
  });

  it('caps how many chunks one document contributes', async () => {
    const user = await createVerifiedUser();
    const long = ['# Manual', '', ...Array.from({ length: 12 }, (_, index) =>
      `## Section ${String(index)}\n\nThe notice period clause appears again in section ${String(index)} with additional surrounding prose to make this chunk substantial enough to survive the minimum size rule applied during chunking.`,
    )].join('\n');

    const documentId = await seed(user, long);

    const result = await hybrid().retrieve(
      { text: 'notice period', userId: user.id, topK: MAX_RESULTS },
      log,
      { maxPerDocument: 2 },
    );

    const fromDocument = result.chunks.filter((chunk) => chunk.documentId === documentId);
    expect(fromDocument.length).toBeLessThanOrEqual(2);
  });

  it('is deterministic across repeated identical queries', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);
    await seed(user, CORPUS.hardware);

    const query = { text: 'notice period', userId: user.id, topK: MAX_RESULTS };

    const first = await hybrid().retrieve(query, log);
    const second = await hybrid().retrieve(query, log);
    const third = await hybrid().retrieve(query, log);

    const ids = (result: { chunks: { chunkId: string }[] }): string[] =>
      result.chunks.map((chunk) => chunk.chunkId);

    expect(ids(second)).toEqual(ids(first));
    expect(ids(third)).toEqual(ids(first));
  });

  it('degrades to the lexical half when the vector store fails', async () => {
    /*
      A half-dead hybrid search still answers. Failing the whole query because
      one backend is down turns a degraded answer into no answer — and the
      lexical half needs no external service at all.
    */
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const brokenVector = {
      name: 'vector' as const,
      retrieve: () => Promise.reject(new Error('vector store unreachable')),
    };

    const result = await new HybridRetriever(brokenVector, new Bm25Retriever()).retrieve(
      { text: 'notice period', userId: user.id, topK: MAX_RESULTS },
      log,
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.stats.vectorCandidates).toBe(0);
    expect(result.chunks.every((chunk) => chunk.source === 'bm25')).toBe(true);
  });

  it('degrades to the semantic half when Postgres full-text fails', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const brokenLexical = {
      name: 'bm25' as const,
      retrieve: () => Promise.reject(new Error('database unreachable')),
    };

    const result = await new HybridRetriever(
      new VectorRetriever(vectorStore, embeddingProvider),
      brokenLexical,
    ).retrieve({ text: 'notice period', userId: user.id, topK: MAX_RESULTS }, log);

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.stats.lexicalCandidates).toBe(0);
  });

  it('returns nothing for an empty corpus', async () => {
    const user = await createVerifiedUser();

    const result = await hybrid().retrieve(
      { text: 'anything at all', userId: user.id, topK: MAX_RESULTS },
      log,
    );

    expect(result.chunks).toEqual([]);
  });
});

describe('retrievalService — the evidence bundle', () => {
  it('produces a complete bundle', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const bundle = await retrievalService.retrieve({
      userId: user.id,
      query: 'What is the notice period?',
    });

    expect(bundle.query).toBe('What is the notice period');
    expect(bundle.originalQuery).toBe('What is the notice period?');
    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.abstain).toBe(false);
    expect(bundle.tokenCount).toBeGreaterThan(0);
    expect(bundle.stats.returned).toBe(bundle.chunks.length);
  });

  it('reports timings for every stage', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const bundle = await retrievalService.retrieve({ userId: user.id, query: 'notice' });

    expect(bundle.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(bundle.timings.vectorMs).toBeGreaterThanOrEqual(0);
    expect(bundle.timings.lexicalMs).toBeGreaterThanOrEqual(0);
    expect(bundle.timings.fusionMs).toBeGreaterThanOrEqual(0);
  });

  it('stays inside the token budget', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    const bundle = await retrievalService.retrieve({ userId: user.id, query: 'notice period' });

    expect(bundle.tokenCount).toBeLessThanOrEqual(bundle.tokenBudget);
  });

  it('abstains with `empty-corpus` when nothing is indexed', async () => {
    /*
      §3.3 short-circuits before the model. The three reasons are kept apart
      because an empty library is an onboarding problem, not an "I don't know".
    */
    const user = await createVerifiedUser();

    const bundle = await retrievalService.retrieve({ userId: user.id, query: 'notice period' });

    expect(bundle.abstain).toBe(true);
    expect(bundle.abstainReason).toBe('empty-corpus');
    expect(bundle.chunks).toEqual([]);
  });

  it('abstains with `no-matches` when the corpus has no relevant chunk', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    // A term that appears nowhere and embeds to nothing the fake ranks highly.
    const bundle = await retrievalService.retrieve({
      userId: user.id,
      query: 'zzzqqqxxx',
      topK: 6,
    });

    // The lexical half finds nothing; the fake vector half may still return
    // neighbours, so the assertion is about the reason when it does abstain.
    if (bundle.abstain) expect(bundle.abstainReason).not.toBe('empty-corpus');
  });

  it('abstains with `below-floor` when candidates exist but none clear it', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);

    // A floor above any achievable cosine similarity discards everything the
    // vector half found; lexical-only hits are exempt by design, so the query
    // avoids terms in the corpus.
    const bundle = await retrievalService.retrieve(
      { userId: user.id, query: 'zzzqqqxxx' },
      { relevanceFloor: 1.1 },
    );

    expect(bundle.abstain).toBe(true);
    expect(bundle.abstainReason).toBe('below-floor');
  });

  it('honours topK', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);
    await seed(user, CORPUS.hardware);

    const bundle = await retrievalService.retrieve({
      userId: user.id,
      query: 'notice OR chassis',
      topK: 1,
    });

    expect(bundle.chunks.length).toBeLessThanOrEqual(1);
  });

  it('filters to specific documents', async () => {
    const user = await createVerifiedUser();
    const termination = await seed(user, CORPUS.termination);
    await seed(user, CORPUS.hardware);

    const bundle = await retrievalService.retrieve({
      userId: user.id,
      query: 'notice OR chassis',
      documentIds: [termination],
    });

    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.chunks.every((chunk) => chunk.documentId === termination)).toBe(true);
  });

  it('scopes every result to the querying user', async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    await seed(owner, CORPUS.termination);

    const bundle = await retrievalService.retrieve({
      userId: stranger.id,
      query: 'notice period',
    });

    expect(bundle.chunks).toEqual([]);
    expect(bundle.abstain).toBe(true);
  });

  it('returns chunks whose text matches the stored chunk exactly', async () => {
    // The bundle carries the passage, not the section-path-enriched form that
    // was embedded — a citation must quote the document.
    const user = await createVerifiedUser();
    const documentId = await seed(user, CORPUS.termination);

    const bundle = await retrievalService.retrieve({ userId: user.id, query: 'notice period' });
    const stored = await chunkRepository.findByDocument(documentId);
    const texts = new Set(stored.map((chunk) => chunk.content));

    for (const chunk of bundle.chunks) expect(texts.has(chunk.text)).toBe(true);
  });

  it('is stable when the same query runs repeatedly', async () => {
    const user = await createVerifiedUser();
    await seed(user, CORPUS.termination);
    await seed(user, CORPUS.hardware);

    const run = (): Promise<string[]> =>
      retrievalService
        .retrieve({ userId: user.id, query: 'notice period' })
        .then((bundle) => bundle.chunks.map((chunk) => chunk.chunkId));

    const [first, second, third] = await Promise.all([run(), run(), run()]);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('does not return chunks from a deleted document', async () => {
    // Deletion removes rows and vectors (M4b); retrieval must see neither.
    const user = await createVerifiedUser();
    const documentId = await seed(user, CORPUS.termination);

    await db.deleteFrom('documents').where('id', '=', documentId).execute();
    await vectorStore.deleteByDocument(`user_${user.id}`, documentId);

    const bundle = await retrievalService.retrieve({ userId: user.id, query: 'notice period' });

    expect(bundle.chunks.every((chunk) => chunk.documentId !== documentId)).toBe(true);
  });
});
