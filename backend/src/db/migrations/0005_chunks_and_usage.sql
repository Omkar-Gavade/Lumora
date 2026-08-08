-- The remaining tables from docs/04-data-and-api.md §1.1.
--
-- **Neither is written by this milestone.** M4a implements the queue, the
-- worker, and parsing; chunk rows appear when the chunker lands and usage rows
-- when embedding does. They are created now because the schema is documented
-- verbatim and the immediately-following milestone fills both — and because
-- the generated tsvector column and its GIN index are schema work that belongs
-- with the schema rather than being bolted on beside the code that needs them.

-- ─── document_chunks ─────────────────────────────────────────────────────────
CREATE TABLE document_chunks (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  /*
    Denormalized on purpose (docs/04-data-and-api.md §1.1).

    This is the tenant filter for lexical search. Without it every keyword
    query joins to `documents` to prove ownership, and that join sits in the
    hot path of the most latency-sensitive operation in the product. The cost
    is one redundant column kept correct by the fact that chunks are only ever
    written by the ingestion pipeline, which already holds the owner.
  */
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  chunk_index    INTEGER NOT NULL,
  content        TEXT NOT NULL,
  token_count    INTEGER NOT NULL,

  -- What makes a citation point somewhere specific rather than at a whole
  -- document (docs/05-rag-and-chat.md §2.3).
  page_number    INTEGER,
  section_path   TEXT,
  char_start     INTEGER,
  char_end       INTEGER,

  -- The id in the external vector store. Null until the vectors are written,
  -- which is what makes a partially-embedded document identifiable.
  vector_id      TEXT,

  content_tsv    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  /*
    The idempotency contract (docs/03-backend.md §7): "chunks are written with
    a deterministic id derived from (document_id, chunk_index) and upserted".

    This constraint is what turns a retry after a partial embedding run into a
    no-op instead of a duplicate. Without it, re-running a job that died
    halfway appends a second copy of every chunk it had already written, and
    retrieval starts returning the same passage twice.
  */
  UNIQUE (document_id, chunk_index)
);

-- The BM25 half of hybrid search.
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING GIN (content_tsv);
CREATE INDEX document_chunks_by_user_idx ON document_chunks (user_id);
CREATE INDEX document_chunks_by_document_idx ON document_chunks (document_id, chunk_index);

-- ─── usage_events ────────────────────────────────────────────────────────────
--
-- Recorded from M3 onward per docs/06-roadmap.md R3, "so cost is visible
-- rather than discovered on a bill".
CREATE TABLE usage_events (
  id            UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Integer money. Floating-point currency is a bug waiting for a spreadsheet.
  cost_micros   BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX usage_events_by_user_idx ON usage_events (user_id, created_at DESC);
