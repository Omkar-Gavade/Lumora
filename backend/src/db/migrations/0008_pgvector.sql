-- The production vector store (docs/08-production-architecture.md §6).
--
-- Collapsing the vector index into the application database removes an entire
-- stateful service: no second container to run, no second backup story, no
-- second failure mode, and the index falls under the same point-in-time
-- recovery as everything else. docs/06-roadmap.md already lists this under
-- Phase 2 ("pgvector migration to collapse to a single datastore") and R5
-- concedes Chroma's operational story is the weaker one.
--
-- This table is a DERIVED index and never a source of truth. Every column here
-- is reconstructible from `document_chunks` plus `documents`, which is what
-- makes losing it a re-embedding cost rather than data loss (`npm run reindex`).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_vectors (
  /*
    The `VectorStore` interface is collection-oriented because Chroma is. Here
    a collection is a column rather than a schema object — `user_{userId}` —
    which keeps the interface identical across both backends while letting one
    table hold every tenant.
  */
  collection  TEXT NOT NULL,

  /*
    Deterministic: `{documentId}:{chunkIndex}` (docs/03-backend.md §7). This is
    what makes a retry after a partial embedding run overwrite rather than
    append, so the composite primary key IS the upsert semantics.
  */
  id          TEXT NOT NULL,

  /*
    Fixed at 768 because that is `gemini-embedding-001`, and because an HNSW
    index requires a known dimension — an unconstrained `vector` column cannot
    be indexed, which would make every search a sequential scan.

    Changing EMBEDDING_MODEL to something with a different width therefore
    needs a migration, not just a config change. That is the honest shape of
    the constraint: embedding spaces are not comparable across models anyway
    (docs/05-rag-and-chat.md §2.4), so a dimension change is already a full
    re-index rather than a rolling upgrade.
  */
  embedding   vector(768) NOT NULL,

  /*
    Stored alongside the vector even though `document_chunks` already holds it,
    exactly as the Chroma adapter does: rendering a source panel from a search
    result must not require a second query on the hot path (§2.5). The
    duplication is bounded and rebuildable.
  */
  text        TEXT NOT NULL,

  -- The documented metadata list (§2.5), as columns rather than JSONB so the
  -- filters retrieval actually uses are indexable.
  chunk_id      UUID NOT NULL,
  document_id   UUID NOT NULL,
  user_id       UUID NOT NULL,
  document_name TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  page_number   INTEGER,
  section_path  TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (collection, id)
);

/*
  HNSW rather than IVFFlat.

  IVFFlat needs training data to build its lists and degrades badly when the
  table is small or grows past the size it was tuned for — it must be rebuilt
  as the corpus changes, which for a product where users upload continuously is
  an operational chore with a silent recall penalty when skipped. HNSW builds
  incrementally, needs no training, and has better recall at the corpus sizes
  this product will see first (thousands to low millions of chunks). It costs
  more memory and a slower build, neither of which binds here.

  `vector_cosine_ops` because the retrieval layer compares cosine similarity
  and the relevance floor is expressed in that space.
*/
CREATE INDEX document_vectors_embedding_idx
  ON document_vectors USING hnsw (embedding vector_cosine_ops);

/*
  The scope filter. Every search is `WHERE collection = $1` and most are
  additionally filtered by document (Knowledge Base scoping, docs/07 §6), so
  the two travel together.
*/
CREATE INDEX document_vectors_scope_idx
  ON document_vectors (collection, document_id);

/*
  Tenant isolation as a queryable column.

  Chroma got this structurally — one collection per user, so a cross-tenant
  read was impossible rather than unlikely. In one shared table that guarantee
  becomes a predicate, so `user_id` is stored redundantly (it is already
  encoded in `collection`) and the repository filters on it as a second,
  independent check. Cheap, and it means a malformed collection name cannot by
  itself leak another tenant's vectors.
*/
CREATE INDEX document_vectors_by_user_idx
  ON document_vectors (user_id);

/*
  No foreign key to `document_chunks`.

  Deliberate: this table is a derived index that must tolerate being rebuilt,
  truncated, and written out of order by the reindex script. A cascade from
  chunks would be convenient and would also mean a chunk delete silently
  rewrites the index behind the adapter's back — the adapter owns its own
  deletion (`deleteByDocument`), and that is the only path that should touch it.
*/
