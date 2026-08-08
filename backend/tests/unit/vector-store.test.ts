import { describe, expect, it } from 'vitest';
import { FakeVectorStore } from '../../src/providers/vector/fake.store.js';
import { PgVectorStore } from '../../src/providers/vector/pgvector.store.js';
import {
  VectorStoreError,
  collectionFor,
  vectorIdFor,
  type VectorRecord,
} from '../../src/providers/vector/vector-store.interface.js';

function record(overrides: Partial<VectorRecord> = {}): VectorRecord {
  return {
    id: 'doc-1:0',
    embedding: [1, 0, 0],
    text: 'chunk text',
    metadata: {
      chunkId: 'chunk-uuid-1',
      documentId: 'doc-1',
      userId: 'user-1',
      documentName: 'notes.txt',
      chunkIndex: 0,
      pageNumber: 1,
      sectionPath: 'A > B',
    },
    ...overrides,
  };
}

describe('vectorIdFor', () => {
  it('derives the id from document and chunk index', () => {
    /*
      docs/03-backend.md §7: "chunks are written with a deterministic id
      derived from `(document_id, chunk_index)` and upserted."

      This is the single property that makes a retry after a partial embedding
      run overwrite rather than append. A random id would turn every retry into
      a duplicate set of vectors that retrieval then returns twice.
    */
    expect(vectorIdFor('doc-1', 0)).toBe('doc-1:0');
    expect(vectorIdFor('doc-1', 42)).toBe('doc-1:42');
  });

  it('is stable across calls', () => {
    expect(vectorIdFor('doc-1', 7)).toBe(vectorIdFor('doc-1', 7));
  });

  it('never collides across documents at the same index', () => {
    expect(vectorIdFor('doc-1', 0)).not.toBe(vectorIdFor('doc-2', 0));
  });
});

describe('collectionFor', () => {
  it('builds a per-user collection name', () => {
    /*
      One collection per user (docs/05-rag-and-chat.md §2.5). Tenant isolation
      is structural rather than dependent on a metadata filter being present on
      every query — a forgotten filter in a shared collection leaks another
      user's documents into an answer.
    */
    expect(collectionFor('abc-123', 'user_')).toBe('user_abc-123');
  });

  it('honours the configured prefix, so environments cannot collide', () => {
    expect(collectionFor('abc', 'staging_')).toBe('staging_abc');
  });

  it('gives different users different collections', () => {
    expect(collectionFor('a', 'user_')).not.toBe(collectionFor('b', 'user_'));
  });
});

describe('FakeVectorStore', () => {
  it('stores records under their collection', async () => {
    const store = new FakeVectorStore();
    await store.upsert('user_1', [record()]);

    expect(store.countIn('user_1')).toBe(1);
    expect(store.countIn('user_2')).toBe(0);
  });

  it('upserts rather than appends', async () => {
    /*
      The behaviour the pipeline's retry semantics require, mirrored from
      Chroma. Getting this wrong here would make every duplicate-prevention
      test pass against a store that does not behave like the real one.
    */
    const store = new FakeVectorStore();

    await store.upsert('user_1', [record({ text: 'first version' })]);
    await store.upsert('user_1', [record({ text: 'second version' })]);

    expect(store.countIn('user_1')).toBe(1);
    expect(store.recordsIn('user_1')[0]?.text).toBe('second version');
  });

  it('keeps records with different ids apart', async () => {
    const store = new FakeVectorStore();

    await store.upsert('user_1', [
      record({ id: 'doc-1:0' }),
      record({ id: 'doc-1:1' }),
      record({ id: 'doc-2:0' }),
    ]);

    expect(store.countIn('user_1')).toBe(3);
  });

  it('deletes every vector of one document and leaves the rest', async () => {
    // Deletion is a real delete (docs/04 §1.2). A document removed from
    // Postgres but left in the index keeps appearing in answers.
    const store = new FakeVectorStore();

    await store.upsert('user_1', [
      record({ id: 'doc-1:0' }),
      record({ id: 'doc-1:1' }),
      record({
        id: 'doc-2:0',
        metadata: { ...record().metadata, documentId: 'doc-2' },
      }),
    ]);

    await store.deleteByDocument('user_1', 'doc-1');

    expect(store.countIn('user_1')).toBe(1);
    expect(store.recordsIn('user_1')[0]?.metadata.documentId).toBe('doc-2');
  });

  it('treats deleting from an unknown collection as success', async () => {
    // A user who never completed an ingestion has no collection, and failing
    // here would leave a row they cannot delete.
    const store = new FakeVectorStore();

    await expect(store.deleteByDocument('never-created', 'doc-1')).resolves.toBeUndefined();
  });

  it('drops a whole collection', async () => {
    const store = new FakeVectorStore();
    await store.upsert('user_1', [record()]);

    await store.deleteCollection('user_1');

    expect(store.collectionNames()).not.toContain('user_1');
  });

  it('ranks query results by cosine similarity', async () => {
    /*
      Real similarity, not insertion order. Mirroring Chroma's ranking means a
      future retrieval test written against the fake fails for the same reasons
      it would against the real store.
    */
    const store = new FakeVectorStore();

    await store.upsert('user_1', [
      record({ id: 'aligned', embedding: [1, 0, 0] }),
      record({ id: 'orthogonal', embedding: [0, 1, 0] }),
      record({ id: 'opposed', embedding: [-1, 0, 0] }),
    ]);

    const matches = await store.query('user_1', [1, 0, 0], 3);

    expect(matches.map((match) => match.id)).toEqual(['aligned', 'orthogonal', 'opposed']);
    expect(matches[0]?.score).toBeCloseTo(1, 6);
  });

  it('respects k', async () => {
    const store = new FakeVectorStore();
    await store.upsert('user_1', [
      record({ id: 'a' }),
      record({ id: 'b' }),
      record({ id: 'c' }),
    ]);

    expect(await store.query('user_1', [1, 0, 0], 2)).toHaveLength(2);
  });

  it('applies a metadata filter', async () => {
    const store = new FakeVectorStore();
    await store.upsert('user_1', [
      record({ id: 'doc-1:0' }),
      record({
        id: 'doc-2:0',
        metadata: { ...record().metadata, documentId: 'doc-2' },
      }),
    ]);

    const matches = await store.query('user_1', [1, 0, 0], 10, { documentId: 'doc-2' });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe('doc-2:0');
  });

  it('returns nothing from a collection that does not exist', async () => {
    const store = new FakeVectorStore();

    expect(await store.query('missing', [1, 0, 0], 5)).toEqual([]);
  });

  it('reports healthy', async () => {
    expect(await new FakeVectorStore().health()).toMatchObject({ ok: true });
  });
});

describe('PgVectorStore (stub)', () => {
  /*
    docs/06-roadmap.md R5: "the pgvector implementation is stubbed so the
    interface is proven against two backends rather than shaped around one."

    Every method throws rather than returning an empty result, because a stub
    that returns `[]` type-checks, satisfies the factory, and silently indexes
    nothing — a corpus of zero vectors that reports `ready`.
  */
  const store = new PgVectorStore();

  it('refuses to upsert, loudly', async () => {
    await expect(store.upsert('user_1', [])).rejects.toBeInstanceOf(VectorStoreError);
  });

  it('refuses every other operation too', async () => {
    await expect(store.query('user_1', [1], 5)).rejects.toThrow(/not implemented/);
    await expect(store.deleteByDocument('user_1', 'doc-1')).rejects.toThrow(/not implemented/);
    await expect(store.deleteCollection('user_1')).rejects.toThrow(/not implemented/);
  });

  it('marks its failures non-retryable', async () => {
    // No number of attempts writes code.
    await expect(store.upsert('user_1', [])).rejects.toMatchObject({ retryable: false });
  });

  it('reports unhealthy instead of throwing, so startup prints a reason', async () => {
    await expect(store.health()).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('stub') as unknown as string,
    });
  });

  it('names the fix in its error message', async () => {
    // An operator hitting this needs to know what to set, not just that it
    // failed.
    await expect(store.upsert('user_1', [])).rejects.toThrow(/VECTOR_STORE=chroma/);
  });
});
