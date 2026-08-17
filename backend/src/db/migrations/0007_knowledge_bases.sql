-- Knowledge Base, from docs/07-knowledge-base.md §5.
--
-- Two tables and one nullable column. The whole feature is a named subset of a
-- user's documents that a conversation can be scoped to; nothing here touches
-- chunks, vectors, or embeddings, because retrieval already accepts a document
-- filter and a Knowledge Base is only a way of computing one.
--
-- Additive by construction: every column added to an existing table is
-- nullable with no default behaviour change, so code running against this
-- schema before the feature ships behaves exactly as it did.

-- ─── knowledge_bases ─────────────────────────────────────────────────────────
CREATE TABLE knowledge_bases (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  /*
    Length is enforced in Zod rather than as a CHECK, matching how `documents`
    handles filenames: the API returns a field-level validation error the
    client can render, where a constraint violation arrives as a 500 with a
    Postgres error string nobody can act on.
  */
  name        TEXT NOT NULL,

  -- Nullable, not defaulted to ''. "No description" and "an empty description"
  -- must not be two representations of the same thing.
  description TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
  Matches the only query the list page makes: a user's knowledge bases, most
  recently touched first. `updated_at` rather than `created_at` because the
  list is ordered by when a base was last worked on.
*/
CREATE INDEX knowledge_bases_by_user_idx
  ON knowledge_bases (user_id, updated_at DESC);

/*
  Names are deliberately NOT unique per user (docs/07 §10).

  They are labels, not identifiers: nothing joins on a name, and a uniqueness
  constraint would reject "AWS" for a user who already has "AWS" archived under
  a different base and genuinely wants both.
*/

-- ─── knowledge_base_documents ────────────────────────────────────────────────
/*
  Many-to-many (docs/07 §2.1).

  One document belongs to as many bases as apply. The alternative — a
  `knowledge_base_id` column on `documents` — would force a user to upload the
  same file twice to file it under two subjects, which doubles storage, doubles
  the embedding cost that docs/06 R3 exists to control, and is rejected outright
  by the `content_hash` dedup on `documents`.
*/
CREATE TABLE knowledge_base_documents (
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,

  /*
    CASCADE, so deleting a document removes its memberships. The reverse is not
    true and must never be: removing a membership is a filing decision, and
    deleting the user's file over it would be a data-loss bug wearing the
    costume of a feature.
  */
  document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  /*
    The composite primary key IS the deduplication mechanism. Adding a document
    that is already a member cannot create a second row, so idempotency is a
    property of the schema rather than of a check the service has to remember
    to perform.
  */
  PRIMARY KEY (knowledge_base_id, document_id)
);

/*
  The reverse direction. Without it, deleting a document sequentially scans the
  join table to find the rows to cascade, and "which bases contain this
  document" — which the document picker asks for every row — has no index.
*/
CREATE INDEX knowledge_base_documents_by_document_idx
  ON knowledge_base_documents (document_id);

-- ─── conversations.knowledge_base_id ─────────────────────────────────────────
/*
  NULL means unscoped, which is exactly what every existing conversation is and
  what every existing conversation stays. This column is the whole
  backward-compatibility guarantee of the feature: retrieval reads it, finds
  NULL, and takes the path it has always taken.

  ON DELETE SET NULL rather than CASCADE or RESTRICT. CASCADE would delete a
  user's chat history as a side effect of tidying up their documents, which is
  catastrophic and surprising. RESTRICT would make a base undeletable once it
  had been used, which in practice means never deletable. SET NULL degrades the
  conversation to unscoped: it keeps its transcript, keeps working, and simply
  searches the whole corpus from then on.
*/
ALTER TABLE conversations
  ADD COLUMN knowledge_base_id UUID
    REFERENCES knowledge_bases(id) ON DELETE SET NULL;

/*
  Partial, because the overwhelming majority of rows are NULL and indexing them
  would be pages of nothing. Serves the delete-impact count ("N conversations
  will become unscoped") and any future per-base conversation listing.
*/
CREATE INDEX conversations_by_knowledge_base_idx
  ON conversations (knowledge_base_id)
  WHERE knowledge_base_id IS NOT NULL;
