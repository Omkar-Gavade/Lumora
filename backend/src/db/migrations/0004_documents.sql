-- Documents and the job queue, from docs/04-data-and-api.md §1.1.
--
-- `document_chunks` and `usage_events` are documented in the same section but
-- are not created here: nothing in this milestone writes to them, and a table
-- with no writer is schema that drifts from the code it claims to serve. They
-- arrive with the chunker and the embedding service.

-- ─── documents ───────────────────────────────────────────────────────────────
--
-- The status sequence is the one FR-13 shows to users verbatim, so the enum and
-- the UI cannot disagree about what a document is doing.
CREATE TYPE document_status AS ENUM (
  'queued',
  'parsing',
  'chunking',
  'embedding',
  'ready',
  'failed'
);

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- `filename` is the sanitized, user-facing name; `original_name` is exactly
  -- what the browser sent. Keeping both means the display name can be made
  -- safe without destroying the evidence of what was actually uploaded.
  filename        TEXT NOT NULL,
  original_name   TEXT NOT NULL,

  -- Determined by magic-byte sniffing, never from the client's Content-Type
  -- or the file extension — both are attacker-controlled.
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,

  -- SHA-256 of the bytes. Serves two purposes (docs/05 §2.1): uploading the
  -- same file twice returns the existing document instead of paying to embed
  -- it again, and a retried job is provably operating on the same input.
  content_hash    TEXT NOT NULL,

  -- Opaque key into the StorageProvider. Never a filesystem path, so swapping
  -- local disk for object storage is a provider change and not a migration.
  storage_key     TEXT NOT NULL,

  status          document_status NOT NULL DEFAULT 'queued',

  -- A machine code plus the human sentence FR-13 requires. The code is what
  -- the frontend maps to copy; the message is what an operator reads.
  error_code      TEXT,
  error_message   TEXT,

  page_count      INTEGER,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  token_count     INTEGER,

  -- Recorded per document because embedding spaces are not comparable across
  -- models (docs/05 §2.4). Without this, a provider change silently degrades
  -- every answer instead of being detectable.
  embedding_model TEXT,
  embedding_dims  INTEGER,

  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT documents_size_positive CHECK (size_bytes > 0),
  -- A failure with no reason is a status the UI cannot explain, and FR-13
  -- requires the reason to be shown.
  CONSTRAINT documents_failure_explained CHECK (
    status <> 'failed' OR error_code IS NOT NULL
  )
);

CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The list query: this user's documents, newest first.
CREATE INDEX documents_by_user_idx ON documents (user_id, created_at DESC);

-- Same file twice is one document. The uniqueness is per user, not global:
-- two people uploading the same public PDF each own their own copy, and a
-- global constraint would leak the existence of one user's file to another.
CREATE UNIQUE INDEX documents_user_content_hash_idx ON documents (user_id, content_hash);

-- Supports `?status=` filtering without scanning a user's whole corpus.
CREATE INDEX documents_by_user_status_idx ON documents (user_id, status);

-- ─── jobs ────────────────────────────────────────────────────────────────────
--
-- Created now, with no worker. docs/05 §2.1 requires the row insert and the
-- enqueue to share a transaction, so the queue has to exist the moment
-- uploads do — otherwise the first thing M4 does is retrofit atomicity onto
-- an upload path that already shipped without it.
CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE jobs (
  id           UUID PRIMARY KEY DEFAULT uuidv7(),
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  status       job_status NOT NULL DEFAULT 'pending',
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Claimed by a worker with FOR UPDATE SKIP LOCKED. `locked_by` names the
  -- worker so a crashed lease can be attributed, and `locked_at` is what the
  -- reaper compares against.
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,

  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- The claim query. Partial, because a worker only ever looks at pending rows
-- and the index should not carry the completed history.
CREATE INDEX jobs_claimable_idx
  ON jobs (status, run_after, priority DESC) WHERE status = 'pending';

-- The reaper: processing rows whose lease has expired.
CREATE INDEX jobs_reaper_idx ON jobs (status, locked_at) WHERE status = 'processing';
