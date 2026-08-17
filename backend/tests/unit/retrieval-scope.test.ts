import { describe, expect, it } from 'vitest';
import { FakeEmbeddingProvider } from '../../src/providers/embedding/fake-embedding.provider.js';
import { FakeVectorStore } from '../../src/providers/vector/fake.store.js';
import { vectorIdFor, type VectorRecord } from '../../src/providers/vector/vector-store.interface.js';
import { VectorRetriever } from '../../src/services/retrieval/vector.retriever.js';

/**
 * The document-scope contract (docs/07-knowledge-base.md §6.3).
 *
 * Three states, and the distinction between the first two is the whole point:
 *
 *   undefined → unscoped, the user's whole corpus
 *   []        → scoped to nothing, no results, never a fallback to the corpus
 *   [...]     → scoped to exactly those documents
 *
 * The middle case previously returned the entire corpus from this retriever
 * while returning nothing from the lexical one. A conversation scoped to an
 * empty Knowledge Base was therefore answerable from documents it was never
 * scoped to. These tests exist so that cannot come back.
 */

const USER = 'user-1';
const PREFIX = 'user_';
const REAL_A = '019fe2e4-0000-7000-8000-00000000000a';
const REAL_B = '019fe2e4-0000-7000-8000-00000000000b';
const REAL_C = '019fe2e4-0000-7000-8000-00000000000c';
const ABSENT = '019fe2e4-0000-7000-8000-0000000000ff';

const embeddings = new FakeEmbeddingProvider({ dimensions: 8, model: 'fake-embedding-001' });

function chunk(documentId: string, chunkIndex: number, text: string): VectorRecord {
  return {
    id: vectorIdFor(documentId, chunkIndex),
    embedding: [],
    text,
    metadata: {
      chunkId: `${documentId}:${String(chunkIndex)}`,
      documentId,
      userId: USER,
      documentName: `${documentId}.pdf`,
      chunkIndex,
      pageNumber: 1,
      sectionPath: null,
    },
  };
}

/** A store holding three documents, two chunks each. */
async function seededStore(): Promise<FakeVectorStore> {
  const store = new FakeVectorStore();
  const records: VectorRecord[] = [];

  for (const documentId of [REAL_A, REAL_B, REAL_C]) {
    for (const index of [0, 1]) {
      const record = chunk(documentId, index, `notice period clause ${String(index)}`);
      record.embedding = await embeddings.embed([record.text]).then((rows) => rows[0] ?? []);
      records.push(record);
    }
  }

  await store.upsert(`${PREFIX}${USER}`, records);
  return store;
}

async function retrieveWith(documentIds: string[] | undefined) {
  const store = await seededStore();
  const retriever = new VectorRetriever(store, embeddings, PREFIX);

  return retriever.retrieve({
    text: 'notice period',
    userId: USER,
    topK: 10,
    documentIds,
  });
}

function documentsIn(chunks: { documentId: string }[]): string[] {
  return [...new Set(chunks.map((entry) => entry.documentId))].sort();
}

describe('vector retrieval document scope', () => {
  it('searches the whole corpus when the scope is undefined', async () => {
    // The existing, unscoped behaviour. Every conversation without a Knowledge
    // Base takes this path, and it must not change.
    const chunks = await retrieveWith(undefined);

    expect(documentsIn(chunks)).toEqual([REAL_A, REAL_B, REAL_C].sort());
  });

  it('returns nothing for an empty scope, and never the whole corpus', async () => {
    /*
      The defect this feature had to fix. An empty Knowledge Base produces an
      empty list, and the honest answer is "no evidence", not "here is
      everything you own".
    */
    const chunks = await retrieveWith([]);

    expect(chunks).toEqual([]);
  });

  it('restricts to a single document by equality', async () => {
    const chunks = await retrieveWith([REAL_B]);

    expect(documentsIn(chunks)).toEqual([REAL_B]);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('restricts to several documents', async () => {
    const chunks = await retrieveWith([REAL_A, REAL_C]);

    // B is excluded even though it matches the query text just as well — the
    // scope is a boundary, not a ranking preference.
    expect(documentsIn(chunks)).toEqual([REAL_A, REAL_C].sort());
  });

  it('ignores ids that match nothing, keeping the ones that do', async () => {
    const chunks = await retrieveWith([REAL_A, ABSENT]);

    expect(documentsIn(chunks)).toEqual([REAL_A]);
  });

  it('returns nothing when every id in the scope matches nothing', async () => {
    // Distinguishes a filter that was applied and matched nothing from a
    // filter that was quietly dropped.
    const chunks = await retrieveWith([ABSENT]);

    expect(chunks).toEqual([]);
  });

  it('does not over-fetch to compensate for filtering afterwards', async () => {
    /*
      The filter is evaluated inside the store now, so a scoped search asks for
      exactly `topK`. The previous implementation asked for `topK × 4` and
      filtered the result, which returned fewer than `topK` survivors whenever
      the scoped documents were a small slice of a large corpus.
    */
    const store = await seededStore();
    const asked: number[] = [];
    const original = store.query.bind(store);

    store.query = async (collection, embedding, k, filter) => {
      asked.push(k);
      return original(collection, embedding, k, filter);
    };

    const retriever = new VectorRetriever(store, embeddings, PREFIX);
    await retriever.retrieve({
      text: 'notice period',
      userId: USER,
      topK: 5,
      documentIds: [REAL_A, REAL_B],
    });

    expect(asked).toEqual([5]);
  });
});

describe('FakeVectorStore $in', () => {
  // The fake has to understand every operator the real store does, or a test
  // written against it passes while the same filter changes nothing in Chroma.

  it('matches any id in the set', async () => {
    const store = await seededStore();
    const embedding = (await embeddings.embed(['notice period']))[0] ?? [];

    const matches = await store.query(`${PREFIX}${USER}`, embedding, 10, {
      documentId: { $in: [REAL_A, REAL_C] },
    });

    expect(documentsIn(matches.map((match) => match.metadata))).toEqual(
      [REAL_A, REAL_C].sort(),
    );
  });

  it('matches nothing for an empty set', async () => {
    const store = await seededStore();
    const embedding = (await embeddings.embed(['notice period']))[0] ?? [];

    const matches = await store.query(`${PREFIX}${USER}`, embedding, 10, {
      documentId: { $in: [] },
    });

    expect(matches).toEqual([]);
  });
});
