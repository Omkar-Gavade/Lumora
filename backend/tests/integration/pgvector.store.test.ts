import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgVectorStore } from '../../src/providers/vector/pgvector.store.js';
import {
  collectionFor,
  vectorIdFor,
  VectorStoreError,
  type VectorRecord,
} from '../../src/providers/vector/vector-store.interface.js';
import { db } from '../helpers/database.js';

/**
 * The production vector store, against a real pgvector database
 * (docs/08-production-architecture.md §6).
 *
 * These run against Postgres with the `vector` extension rather than a fake,
 * because the questions worth asking are whether *pgvector* honours the
 * distance operator, the dimension constraint, and the filters — none of which
 * a stand-in can answer. The dev compose file pins `pgvector/pgvector:pg17`
 * for exactly this reason.
 *
 * Tenant isolation gets the most attention here. Chroma had it structurally,
 * one collection per user; in a single shared table it is a predicate, and a
 * predicate can be forgotten. Every isolation test below would have passed
 * trivially under Chroma and is load-bearing under this backend.
 */

const DIMENSIONS = 768;
const store = new PgVectorStore();

const ALICE = randomUUID();
const BOB = randomUUID();
const PREFIX = 'test_user_';

const aliceCollection = collectionFor(ALICE, PREFIX);
const bobCollection = collectionFor(BOB, PREFIX);

/**
 * A unit vector pointing mostly along one axis.
 *
 * Distinct axes give predictable cosine ordering without hand-computing
 * distances: a query along axis N ranks the record built on axis N first.
 */
function vectorOn(axis: number): number[] {
  const values = new Array<number>(DIMENSIONS).fill(0.001);
  values[axis % DIMENSIONS] = 1;
  return values;
}

function record(overrides: {
  documentId: string;
  userId: string;
  chunkIndex?: number;
  axis?: number;
  text?: string;
}): VectorRecord {
  const chunkIndex = overrides.chunkIndex ?? 0;

  return {
    id: vectorIdFor(overrides.documentId, chunkIndex),
    embedding: vectorOn(overrides.axis ?? 0),
    text: overrides.text ?? 'The notice period is thirty days.',
    metadata: {
      chunkId: randomUUID(),
      documentId: overrides.documentId,
      userId: overrides.userId,
      documentName: 'agreement.pdf',
      chunkIndex,
      pageNumber: 3,
      sectionPath: '3. Termination',
    },
  };
}

const docA = randomUUID();
const docB = randomUUID();
const docBob = randomUUID();

beforeEach(async () => {
  await store.upsert(aliceCollection, [
    record({ documentId: docA, userId: ALICE, chunkIndex: 0, axis: 0 }),
    record({ documentId: docA, userId: ALICE, chunkIndex: 1, axis: 1 }),
    record({ documentId: docB, userId: ALICE, chunkIndex: 0, axis: 2 }),
  ]);

  await store.upsert(bobCollection, [
    record({ documentId: docBob, userId: BOB, chunkIndex: 0, axis: 0, text: "Bob's private contract." }),
  ]);
});

afterEach(async () => {
  await store.deleteCollection(aliceCollection);
  await store.deleteCollection(bobCollection);
});

describe('PgVectorStore — writes', () => {
  it('stores a vector and returns it with its metadata intact', async () => {
    const matches = await store.query(aliceCollection, vectorOn(0), 1);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.metadata).toMatchObject({
      documentId: docA,
      userId: ALICE,
      documentName: 'agreement.pdf',
      chunkIndex: 0,
      pageNumber: 3,
      sectionPath: '3. Termination',
    });
    expect(matches[0]?.text).toContain('notice period');
  });

  it('**upserts rather than appends, so a retry cannot duplicate a chunk**', async () => {
    /*
      The pipeline re-issues vectors it already wrote on every retry. Ids are
      deterministic, so the same chunk must overwrite — an append-only store
      multiplies the corpus by the number of attempts and retrieval then
      returns the same passage several times.
    */
    await store.upsert(aliceCollection, [
      record({ documentId: docA, userId: ALICE, chunkIndex: 0, axis: 0, text: 'Rewritten.' }),
    ]);

    const rows = await db
      .selectFrom('document_vectors')
      .select(['id', 'text'])
      .where('collection', '=', aliceCollection)
      .where('id', '=', vectorIdFor(docA, 0))
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('Rewritten.');
  });

  it('accepts an empty batch without a round trip', async () => {
    await expect(store.upsert(aliceCollection, [])).resolves.toBeUndefined();
  });

  it('rejects an embedding of the wrong width', async () => {
    // The column is `vector(768)`. A model swap that changes the width has to
    // be a migration and a re-index, not a silent write of incomparable
    // vectors (docs/05 §2.4).
    const wrong = record({ documentId: docA, userId: ALICE, chunkIndex: 9 });
    wrong.embedding = [1, 2, 3];

    await expect(store.upsert(aliceCollection, [wrong])).rejects.toBeInstanceOf(VectorStoreError);
  });
});

describe('PgVectorStore — search', () => {
  it('ranks by cosine similarity, nearest first', async () => {
    const matches = await store.query(aliceCollection, vectorOn(1), 3);

    expect(matches[0]?.metadata.chunkIndex).toBe(1);
    // Similarity, not distance — the relevance floor and RRF fusion both
    // assume higher is better, exactly as the Chroma adapter returns.
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 1);
    expect(matches[0]?.score).toBeGreaterThan(0.9);
  });

  it('honours the requested k', async () => {
    expect(await store.query(aliceCollection, vectorOn(0), 2)).toHaveLength(2);
  });

  it('returns nothing for a collection that has never been written', async () => {
    // Ordinary, not an error: a user with no indexed documents has no matches.
    const matches = await store.query(collectionFor(randomUUID(), PREFIX), vectorOn(0), 5);

    expect(matches).toEqual([]);
  });
});

describe('PgVectorStore — filtering', () => {
  it('restricts to a single document by equality', async () => {
    const matches = await store.query(aliceCollection, vectorOn(0), 10, { documentId: docB });

    expect(matches.map((match) => match.metadata.documentId)).toEqual([docB]);
  });

  it('restricts to several documents with $in', async () => {
    // The Knowledge Base scope (docs/07 §6) — a base is a list of documents.
    const matches = await store.query(aliceCollection, vectorOn(0), 10, {
      documentId: { $in: [docA, docB] },
    });

    expect(new Set(matches.map((match) => match.metadata.documentId))).toEqual(
      new Set([docA, docB]),
    );
  });

  it('keeps real ids when the set also names one that does not exist', async () => {
    const matches = await store.query(aliceCollection, vectorOn(0), 10, {
      documentId: { $in: [docA, randomUUID()] },
    });

    expect(new Set(matches.map((match) => match.metadata.documentId))).toEqual(new Set([docA]));
  });

  it('**returns nothing for an empty $in, never everything**', async () => {
    /*
      An empty Knowledge Base. The filter must be impossible rather than
      absent — treating "scoped to nothing" as "unscoped" answers from
      documents the conversation was never scoped to (docs/07 §6.3).
    */
    const matches = await store.query(aliceCollection, vectorOn(0), 10, {
      documentId: { $in: [] },
    });

    expect(matches).toEqual([]);
  });

  it('refuses a filter on a field it does not index', async () => {
    // An allowlist, so a filter key can never reach the statement as SQL.
    await expect(
      store.query(aliceCollection, vectorOn(0), 10, { nonsense: 'value' }),
    ).rejects.toBeInstanceOf(VectorStoreError);
  });
});

describe('PgVectorStore — tenant isolation', () => {
  it("**never returns another tenant's vectors**", async () => {
    /*
      The single most important test for this backend. Under Chroma a
      cross-tenant read was impossible by construction; here it is prevented by
      `WHERE collection = $1`, and this asserts that predicate is actually
      present. Bob's vector sits on the same axis as Alice's best match, so a
      missing filter would rank it first.
    */
    const matches = await store.query(aliceCollection, vectorOn(0), 20);

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.metadata.userId).toBe(ALICE);
      expect(match.text).not.toContain('private');
    }
  });

  it("a document filter cannot reach across collections", async () => {
    // Naming another tenant's document id explicitly still returns nothing:
    // the collection predicate is applied first and independently.
    const matches = await store.query(aliceCollection, vectorOn(0), 10, {
      documentId: docBob,
    });

    expect(matches).toEqual([]);
  });

  it("deleting one tenant's document leaves the other's alone", async () => {
    await store.deleteByDocument(aliceCollection, docA);

    expect(await store.query(bobCollection, vectorOn(0), 5)).toHaveLength(1);
  });

  it("dropping one tenant's collection leaves the other's alone", async () => {
    await store.deleteCollection(aliceCollection);

    expect(await store.query(aliceCollection, vectorOn(0), 5)).toEqual([]);
    expect(await store.query(bobCollection, vectorOn(0), 5)).toHaveLength(1);
  });
});

describe('PgVectorStore — deletion', () => {
  it('removes every vector of one document and no others', async () => {
    await store.deleteByDocument(aliceCollection, docA);

    const remaining = await store.query(aliceCollection, vectorOn(0), 10);
    expect(remaining.map((match) => match.metadata.documentId)).toEqual([docB]);
  });

  it('deleting a document that has no vectors is not an error', async () => {
    await expect(
      store.deleteByDocument(aliceCollection, randomUUID()),
    ).resolves.toBeUndefined();
  });
});

describe('PgVectorStore — rebuildability', () => {
  it('**a dropped index can be rewritten from the same records**', async () => {
    /*
      The invariant that makes this store safe to lose (docs/08 §2): everything
      here is derived from `document_chunks` plus `documents`, so wiping it
      costs a re-embedding rather than data. This is the store-level half of
      that guarantee — deterministic ids mean a rebuild converges on exactly
      the same rows rather than a second copy.
    */
    const before = await store.query(aliceCollection, vectorOn(0), 10);

    await store.deleteCollection(aliceCollection);
    expect(await store.query(aliceCollection, vectorOn(0), 10)).toEqual([]);

    await store.upsert(aliceCollection, [
      record({ documentId: docA, userId: ALICE, chunkIndex: 0, axis: 0 }),
      record({ documentId: docA, userId: ALICE, chunkIndex: 1, axis: 1 }),
      record({ documentId: docB, userId: ALICE, chunkIndex: 0, axis: 2 }),
    ]);

    const after = await store.query(aliceCollection, vectorOn(0), 10);

    expect(after.map((match) => match.id)).toEqual(before.map((match) => match.id));
  });
});

describe('PgVectorStore — health', () => {
  it('reports healthy when the extension is installed', async () => {
    const health = await store.health();

    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
