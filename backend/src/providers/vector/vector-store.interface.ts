/**
 * One indexed vector and the metadata that travels with it.
 *
 * The metadata list is docs/05-rag-and-chat.md §2.5 verbatim: `chunkId`,
 * `documentId`, `userId`, `documentName`, `pageNumber`, `sectionPath`,
 * `chunkIndex` — "enough for the UI to render a citation without a second
 * database round trip on the hot path".
 *
 * `text` is stored alongside the vector even though Postgres already holds it.
 * That is the same trade: rendering a source panel from a search result should
 * not require a second query, and the duplication is bounded and rebuildable
 * because Postgres remains the source of truth.
 */
export interface VectorRecord {
  /**
   * Deterministic: `{documentId}:{chunkIndex}` (docs/03-backend.md §7 —
   * "chunks are written with a deterministic id derived from `(document_id,
   * chunk_index)` and upserted").
   *
   * This is the property that makes a retry after a partial embedding run
   * overwrite rather than append. A random id would turn every retry into a
   * duplicate set of vectors that retrieval then returns twice.
   */
  id: string;
  embedding: number[];
  text: string;
  metadata: VectorMetadata;
}

export interface VectorMetadata {
  chunkId: string;
  documentId: string;
  userId: string;
  documentName: string;
  chunkIndex: number;
  pageNumber: number | null;
  sectionPath: string | null;
}

/** A retrieval hit. Declared for the documented interface; unused in M4b. */
export interface VectorMatch {
  id: string;
  score: number;
  text: string;
  metadata: VectorMetadata;
}

/**
 * Equality, or membership in a set, over stored metadata.
 *
 * `$in` is here for exactly one caller — a Knowledge Base scope is a list of
 * document ids, and expressing it as equality is impossible
 * (docs/07-knowledge-base.md §6.3, D-2). Before it existed the vector half
 * over-fetched by four and filtered in memory, which silently returned fewer
 * than `topK` results whenever the scoped documents were a small slice of a
 * large corpus.
 *
 * **Deliberately not a query language.** No `$gt`, no `$or`, no nesting. Every
 * operator added here has to be implemented by every store — including the
 * fake, which is what keeps tests honest — so the bar for a second one is a
 * caller that cannot be served by these two.
 */
export type MetadataFilterValue = string | number | boolean | { $in: string[] };

export type MetadataFilter = Record<string, MetadataFilterValue>;

/**
 * The vector index, behind an interface (docs/05-rag-and-chat.md §2.5).
 *
 * The declaration is the documented one, unchanged:
 *
 * ```ts
 * interface VectorStore {
 *   upsert(collection, records): Promise<void>;
 *   query(collection, embedding, k, filter?): Promise<VectorMatch[]>;
 *   deleteByDocument(collection, documentId): Promise<void>;
 *   deleteCollection(collection): Promise<void>;
 * }
 * ```
 *
 * **Collections are per user** (`user_{userId}`). Tenant isolation is
 * structural rather than dependent on a metadata filter being present on every
 * query — a forgotten filter in a shared collection leaks another user's
 * documents into an answer, which is the worst failure this product has. Per
 * user collections make that class of bug impossible rather than unlikely.
 *
 * **The store is a derived index, never a source of truth** (docs/04 §1.2).
 * Everything needed to rebuild it lives in Postgres, which is what makes
 * switching backends a re-index rather than a data migration.
 */
export interface VectorStore {
  /** Provider name, for logs. */
  readonly name: string;

  /**
   * Creates the collection if absent and writes the records.
   *
   * Upsert semantics on `id`: writing the same record twice leaves one copy.
   * The pipeline depends on this — every retry re-issues the vectors it
   * already wrote, and an append-only store would multiply them per attempt.
   */
  upsert(collection: string, records: VectorRecord[]): Promise<void>;

  /**
   * Nearest neighbours.
   *
   * **Nothing in M4b calls this.** It is implemented because it is part of the
   * documented interface, and an interface that ships half-implemented is one
   * whose second half gets shaped around whatever the first consumer happens
   * to need. Retrieval — fusion, the relevance floor, diversity caps — is M4c.
   */
  query(
    collection: string,
    embedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<VectorMatch[]>;

  /**
   * Removes every vector belonging to one document.
   *
   * Deletion is a real delete (docs/04 §1.2: "No soft deletes"). A document
   * removed from Postgres but left in the index would keep appearing in
   * answers, which breaks the privacy promise in a way the user cannot see.
   */
  deleteByDocument(collection: string, documentId: string): Promise<void>;

  /** Drops a whole collection — account deletion, or a full re-index. */
  deleteCollection(collection: string): Promise<void>;

  /**
   * Reports whether the store is reachable.
   *
   * Not in the documented four, and added for the same reason `MailProvider`
   * has one: startup needs to say whether a dependency is usable, and an
   * `instanceof ChromaVectorStore` check at the call site would have to be
   * revisited for every backend added after it.
   */
  health(): Promise<{ ok: boolean; latencyMs: number; message?: string }>;
}

/** Builds the per-user collection name. One definition, so it cannot drift. */
export function collectionFor(userId: string, prefix: string): string {
  return `${prefix}${userId}`;
}

/** The deterministic vector id for a chunk (docs/03-backend.md §7). */
export function vectorIdFor(documentId: string, chunkIndex: number): string {
  return `${documentId}:${String(chunkIndex)}`;
}

/** Raised when the vector store cannot be reached or refuses a write. */
export class VectorStoreError extends Error {
  constructor(
    readonly store: string,
    message: string,
    /**
     * Almost always `true`. An unreachable index is an infrastructure problem,
     * and failing a document permanently over one is how a user loses a file
     * to a container restart.
     */
    readonly retryable = true,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'VectorStoreError';
    this.cause = cause;
  }
}
