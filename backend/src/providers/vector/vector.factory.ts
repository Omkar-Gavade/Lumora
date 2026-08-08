import { env } from '../../config/index.js';
import { ChromaVectorStore } from './chroma.store.js';
import { FakeVectorStore } from './fake.store.js';
import { PgVectorStore } from './pgvector.store.js';
import type { VectorStore } from './vector-store.interface.js';

/**
 * Resolves the configured vector store — the one place a backend is chosen
 * (docs/05-rag-and-chat.md §8: the `VectorStore` seam).
 *
 * No `default` arm. `VECTOR_STORE` is a Zod enum, so adding `qdrant` without
 * adding a case is a compile error rather than a silent fallback to the
 * in-memory fake, which would index a corpus into a `Map` that dies with the
 * process while every status said `ready`.
 */
export function createVectorStore(): VectorStore {
  switch (env.VECTOR_STORE) {
    case 'chroma':
      return new ChromaVectorStore(env.CHROMA_URL);
    case 'fake':
      return new FakeVectorStore();
    case 'pgvector':
      return new PgVectorStore();
  }
}

export const vectorStore: VectorStore = createVectorStore();
