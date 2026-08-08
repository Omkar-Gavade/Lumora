import {
  VectorStoreError,
  type MetadataFilter,
  type VectorMatch,
  type VectorRecord,
  type VectorStore,
} from './vector-store.interface.js';

/**
 * pgvector — **a deliberate stub** (docs/03-backend.md §4 lists it as
 * `pgvector.store.ts (stub — proves the interface holds)`; docs/06-roadmap.md
 * R5: "the pgvector implementation is stubbed so the interface is proven
 * against two backends rather than shaped around one").
 *
 * The value is entirely in the type-checking. Writing the signatures against a
 * second backend with genuinely different mechanics — SQL and a `vector`
 * column instead of an HTTP collection API — is what proves the interface is
 * not just a description of Chroma. Two things it caught:
 *
 * - `deleteCollection` is coherent here only as "delete every row for this
 *   user", not as dropping a table. The interface survives that because it
 *   names an *outcome*, not a DDL operation.
 * - Metadata is a JSONB column rather than scalar-only fields, so the
 *   `null`-omission the Chroma adapter needs is Chroma's problem and correctly
 *   lives there rather than in the interface.
 *
 * **Every method throws.** A stub whose methods return empty arrays type-checks,
 * satisfies the factory, and silently indexes nothing — the exact failure mode
 * the storage factory's comment rejects for S3. Throwing means selecting
 * `VECTOR_STORE=pgvector` fails immediately and unmistakably instead of
 * producing a corpus of zero vectors that looks healthy.
 *
 * Migrating is real work, not a flip: `CREATE EXTENSION vector`, a `vector`
 * column on `document_chunks`, an HNSW index, and a re-embed. The chunk text
 * and metadata already live in Postgres, which is what makes it a re-index
 * rather than a data migration.
 */
export class PgVectorStore implements VectorStore {
  readonly name = 'pgvector';

  upsert(_collection: string, _records: VectorRecord[]): Promise<void> {
    return Promise.reject(notImplemented('upsert'));
  }

  query(
    _collection: string,
    _embedding: number[],
    _k: number,
    _filter?: MetadataFilter,
  ): Promise<VectorMatch[]> {
    return Promise.reject(notImplemented('query'));
  }

  deleteByDocument(_collection: string, _documentId: string): Promise<void> {
    return Promise.reject(notImplemented('deleteByDocument'));
  }

  deleteCollection(_collection: string): Promise<void> {
    return Promise.reject(notImplemented('deleteCollection'));
  }

  health(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    // Reports unhealthy rather than throwing, so the startup check prints a
    // clear reason instead of a stack trace.
    return Promise.resolve({
      ok: false,
      latencyMs: 0,
      message: 'pgvector is a stub — set VECTOR_STORE=chroma or fake',
    });
  }
}

function notImplemented(operation: string): VectorStoreError {
  return new VectorStoreError(
    'pgvector',
    `${operation} is not implemented — pgvector is a stub proving the VectorStore interface holds against a second backend. Set VECTOR_STORE=chroma or VECTOR_STORE=fake.`,
    // Not retryable: no number of attempts writes code.
    false,
  );
}
