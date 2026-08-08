import { env } from '../../src/config/index.js';
import { FakeVectorStore } from '../../src/providers/vector/fake.store.js';
import { collectionFor } from '../../src/providers/vector/vector-store.interface.js';
import { vectorStore } from '../../src/providers/vector/vector.factory.js';

/**
 * Access to the vector index from tests.
 *
 * The suite runs with `VECTOR_STORE=fake` (see `tests/setup/test-env.ts`), so
 * every pipeline test can assert on what was actually indexed without a Chroma
 * container. The real `ChromaVectorStore` is exercised separately, against a
 * live server, in `tests/integration/chroma.store.test.ts`.
 *
 * The narrowing below is a runtime check rather than a cast: if the suite is
 * ever run against a real store by accident, these helpers fail loudly instead
 * of silently asserting on an empty `Map` and passing.
 */
export function fakeVectorStore(): FakeVectorStore {
  if (!(vectorStore instanceof FakeVectorStore)) {
    throw new Error(
      `expected the fake vector store in tests, got "${vectorStore.name}" — check VECTOR_STORE in the test environment`,
    );
  }
  return vectorStore;
}

/** The collection a user's vectors land in, using the configured prefix. */
export function collectionForUser(userId: string): string {
  return collectionFor(userId, env.CHROMA_COLLECTION_PREFIX);
}

/** Every vector indexed for a user. */
export function vectorsForUser(userId: string): ReturnType<FakeVectorStore['recordsIn']> {
  return fakeVectorStore().recordsIn(collectionForUser(userId));
}

/** Vectors belonging to one document, in chunk order. */
export function vectorsForDocument(
  userId: string,
  documentId: string,
): ReturnType<FakeVectorStore['recordsIn']> {
  return vectorsForUser(userId)
    .filter((record) => record.metadata.documentId === documentId)
    .sort((left, right) => left.metadata.chunkIndex - right.metadata.chunkIndex);
}

/**
 * Empties the index between tests.
 *
 * The store is a module-level singleton holding a `Map`, so without this a
 * document indexed in one test is still present in the next — and a test
 * asserting "delete removed the vectors" would pass or fail depending on what
 * ran before it.
 */
export function resetVectorStoreForTests(): void {
  if (vectorStore instanceof FakeVectorStore) vectorStore.clear();
}
