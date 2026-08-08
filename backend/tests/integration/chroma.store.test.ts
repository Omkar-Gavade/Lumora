import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChromaClient } from 'chromadb';
import { env } from '../../src/config/index.js';
import { ChromaVectorStore } from '../../src/providers/vector/chroma.store.js';
import type { VectorRecord } from '../../src/providers/vector/vector-store.interface.js';

/**
 * `ChromaVectorStore` against a **real Chroma server**.
 *
 * The rest of the suite runs on `FakeVectorStore`, which is the right default —
 * ingestion must be verifiable without a second service. But a fake can only
 * prove the pipeline calls the interface correctly; it cannot prove the Chroma
 * adapter speaks Chroma. Upsert semantics, metadata round-tripping, and
 * delete-by-filter are all properties of the server, and the only honest way to
 * check them is to ask the server.
 *
 * **Skipped, not failed, when Chroma is unreachable.** A developer without the
 * container should still get a green suite; the skip is visible in the output,
 * so it cannot be mistaken for a pass. Start it with:
 *
 *   docker run -d --name lumora-chroma -p 8000:8000 chromadb/chroma:1.0.0
 */
const store = new ChromaVectorStore(env.CHROMA_URL);

/** Raw connection details, for assertions the adapter must not make about itself. */
const chromaUrl = new URL(env.CHROMA_URL);
const host = chromaUrl.hostname;
const port = Number(chromaUrl.port === '' ? 8000 : chromaUrl.port);

const reachable = await store
  .health()
  .then((health) => health.ok)
  .catch(() => false);

/** A collection unique to this run, so a stale one cannot make a test pass. */
const collection = `test_${randomUUID().replace(/-/g, '')}`;

function record(overrides: Partial<VectorRecord> = {}): VectorRecord {
  return {
    id: 'doc-1:0',
    embedding: [1, 0, 0, 0],
    text: 'The notice period is thirty days.',
    metadata: {
      chunkId: randomUUID(),
      documentId: 'doc-1',
      userId: 'user-1',
      documentName: 'agreement.pdf',
      chunkIndex: 0,
      pageNumber: 3,
      sectionPath: '3. Termination > 3.2 Notice',
    },
    ...overrides,
  };
}

describe.skipIf(!reachable)('ChromaVectorStore (live server)', () => {
  beforeAll(async () => {
    // Prove reachability loudly rather than letting the first assertion fail
    // with something that looks like a logic error.
    expect((await store.health()).ok).toBe(true);
  });

  afterAll(async () => {
    await store.deleteCollection(collection);
  });

  it('creates a collection on first write and stores the vector', async () => {
    await store.upsert(collection, [record()]);

    const matches = await store.query(collection, [1, 0, 0, 0], 5);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe('doc-1:0');
    expect(matches[0]?.text).toBe('The notice period is thirty days.');
  });

  it('round-trips every metadata field a citation needs', async () => {
    /*
      docs/05-rag-and-chat.md §2.5 lists these so "the UI can render a citation
      without a second database round trip on the hot path". A field silently
      dropped by the store would only surface as a citation with no page number,
      months later.
    */
    const matches = await store.query(collection, [1, 0, 0, 0], 1);
    const metadata = matches[0]?.metadata;

    expect(metadata).toMatchObject({
      documentId: 'doc-1',
      userId: 'user-1',
      documentName: 'agreement.pdf',
      chunkIndex: 0,
      pageNumber: 3,
      sectionPath: '3. Termination > 3.2 Notice',
    });
  });

  it('overwrites on a repeated id rather than appending', async () => {
    /*
      The property the whole retry story rests on. Vector ids are deterministic
      (`{documentId}:{chunkIndex}`), so every retry re-issues ids it has already
      written — an append-only store would multiply the corpus per attempt.
    */
    const id = 'doc-1:0';

    await store.upsert(collection, [record({ id, text: 'first version' })]);
    await store.upsert(collection, [record({ id, text: 'second version' })]);

    const matches = await store.query(collection, [1, 0, 0, 0], 10);
    const hits = matches.filter((match) => match.id === id);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe('second version');
  });

  it('omits null metadata rather than sending it', async () => {
    // Chroma rejects `null` metadata values in some versions. Omission is
    // correct in all of them, and reads back as `null`.
    await store.upsert(collection, [
      record({
        id: 'doc-1:99',
        embedding: [0, 0, 0, 1],
        metadata: { ...record().metadata, pageNumber: null, sectionPath: null },
      }),
    ]);

    const matches = await store.query(collection, [0, 0, 0, 1], 1);

    expect(matches[0]?.metadata.pageNumber).toBeNull();
    expect(matches[0]?.metadata.sectionPath).toBeNull();
  });

  it('ranks by cosine similarity, with the score higher for a closer vector', async () => {
    // The collection is created with `hnsw:space: cosine` explicitly — Chroma's
    // default is L2, and for normalized embeddings the two rank differently.
    const scoped = `${collection}_rank`;

    await store.upsert(scoped, [
      record({ id: 'aligned', embedding: [1, 0, 0, 0] }),
      record({ id: 'orthogonal', embedding: [0, 1, 0, 0] }),
    ]);

    const matches = await store.query(scoped, [1, 0, 0, 0], 2);

    expect(matches[0]?.id).toBe('aligned');
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 1);

    await store.deleteCollection(scoped);
  });

  it('deletes every vector of one document and leaves the others', async () => {
    const scoped = `${collection}_delete`;

    await store.upsert(scoped, [
      record({ id: 'doc-a:0', metadata: { ...record().metadata, documentId: 'doc-a' } }),
      record({ id: 'doc-a:1', metadata: { ...record().metadata, documentId: 'doc-a' } }),
      record({ id: 'doc-b:0', metadata: { ...record().metadata, documentId: 'doc-b' } }),
    ]);

    await store.deleteByDocument(scoped, 'doc-a');

    const remaining = await store.query(scoped, [1, 0, 0, 0], 10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.metadata.documentId).toBe('doc-b');

    await store.deleteCollection(scoped);
  });

  it('treats deleting from a collection that never existed as success', async () => {
    // A user who never completed an ingestion has no collection, and failing
    // here would leave a document row they cannot delete.
    await expect(
      store.deleteByDocument(`never_created_${randomUUID().replace(/-/g, '')}`, 'doc-1'),
    ).resolves.toBeUndefined();
  });

  it('does not create the collection it was asked to delete from', async () => {
    /*
      The first version of this adapter reached for `getOrCreateCollection`
      here, so every delete for a user with no collection quietly created one —
      invisible in the product, permanent in Chroma, and growing by one per
      deleted document. Asserting on `resolves` alone did not catch it, because
      the wrong implementation also resolves.
    */
    const name = `never_created_${randomUUID().replace(/-/g, '')}`;

    await store.deleteByDocument(name, 'doc-1');

    // Asked of the server directly: the adapter's own methods would be judging
    // their own behaviour.
    const client = new ChromaClient({ host, port, ssl: false });
    const names = (await client.listCollections()).map((entry) =>
      typeof entry === 'string' ? entry : entry.name,
    );

    expect(names).not.toContain(name);
  });

  it('returns no matches for a collection that does not exist, without creating one', async () => {
    // Same leak on the read path: a query for a user with no indexed documents
    // is ordinary, and the honest answer is no matches.
    const name = `never_queried_${randomUUID().replace(/-/g, '')}`;

    expect(await store.query(name, [1, 0, 0, 0], 5)).toEqual([]);

    const client = new ChromaClient({ host, port, ssl: false });
    const names = (await client.listCollections()).map((entry) =>
      typeof entry === 'string' ? entry : entry.name,
    );

    expect(names).not.toContain(name);
  });

  it('treats deleting an absent collection as success', async () => {
    // Chroma reports a missing collection as an error; treating that as a
    // failure would make deletion non-idempotent.
    const scoped = `${collection}_absent`;

    await store.upsert(scoped, [record()]);
    await store.deleteCollection(scoped);

    await expect(store.deleteCollection(scoped)).resolves.toBeUndefined();
  });

  it('keeps tenants apart by collection', async () => {
    /*
      Tenant isolation is structural here, not a metadata filter that could be
      forgotten (§2.5). Two users' vectors live in two collections, so a query
      against one physically cannot see the other.
    */
    const alice = `${collection}_alice`;
    const bob = `${collection}_bob`;

    await store.upsert(alice, [record({ id: 'a:0', text: "alice's document" })]);
    await store.upsert(bob, [record({ id: 'b:0', text: "bob's document" })]);

    const fromAlice = await store.query(alice, [1, 0, 0, 0], 10);

    expect(fromAlice).toHaveLength(1);
    expect(fromAlice[0]?.text).toBe("alice's document");

    await store.deleteCollection(alice);
    await store.deleteCollection(bob);
  });

  it('handles an empty upsert without a round trip', async () => {
    await expect(store.upsert(collection, [])).resolves.toBeUndefined();
  });

  it('reports health with a latency', async () => {
    const health = await store.health();

    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(reachable)('ChromaVectorStore (server unavailable)', () => {
  it('reports unhealthy rather than throwing', async () => {
    // The startup check needs a reason to print, not a stack trace.
    const health = await store.health();

    expect(health.ok).toBe(false);
    expect(health.message).toBeDefined();
  });
});
