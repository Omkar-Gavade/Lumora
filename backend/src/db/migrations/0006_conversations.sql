-- The conversation schema from docs/04-data-and-api.md §1.1, verbatim.
--
-- Three tables and two enums, all of which the chat orchestrator in
-- docs/05-rag-and-chat.md §7 depends on existing before a single turn can run.

CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');

/*
  `pending` and `streaming` exist because a message row is written *before* the
  model is called (§7 step 3), not after.

  A design that only inserts the assistant message on success loses everything
  on a disconnect and leaves the thread with a user turn and no reply — "both a
  data bug and a visible product defect". These two states are what make the
  row exist while it is still being filled in.
*/
CREATE TYPE message_status AS ENUM ('pending', 'streaming', 'complete', 'stopped', 'failed');

-- ─── conversations ───────────────────────────────────────────────────────────
CREATE TABLE conversations (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL DEFAULT 'New conversation',

  /*
    Distinguishes a title the model wrote from the placeholder above.

    Without it, titling cannot tell "never titled" from "titled, and the model
    happened to produce the default string", so a retitle would either run on
    every turn or never run again.
  */
  title_generated   BOOLEAN NOT NULL DEFAULT false,

  /*
    The rolling summary from §4.4.

    Created now and **not written by this milestone**. `summary_upto_seq` marks
    how far the summary covers, which is what makes summarization incremental
    rather than a re-summarization of the whole thread on every turn — the
    column exists so that change is a service addition, not a migration.
  */
  summary           TEXT,
  summary_upto_seq  INTEGER,

  message_count     INTEGER NOT NULL DEFAULT 0,
  last_message_at   TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
  Partial index, matching the only query the sidebar makes: a user's
  unarchived conversations, most recent first.

  `NULLS LAST` because a conversation created but never used has no
  `last_message_at`, and it belongs at the bottom rather than the top.
*/
CREATE INDEX conversations_by_user_idx
  ON conversations (user_id, last_message_at DESC NULLS LAST)
  WHERE archived_at IS NULL;

CREATE TRIGGER conversations_set_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── messages ────────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  /*
    Denormalized, like `document_chunks.user_id` and for the same reason: every
    read of a message is scoped by owner, and a join to `conversations` on the
    hot path of the most latency-sensitive operation in the product buys
    nothing. Kept correct by the fact that messages are only ever written by
    the chat service, which already holds the owner.
  */
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  role              message_role NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  status            message_status NOT NULL DEFAULT 'complete',

  /*
    Stable ordering, and the reason ties are impossible.

    `created_at` is not enough: a user message and its assistant placeholder are
    inserted in the same transaction and can share a microsecond, and a thread
    that renders the reply above the question is broken in a way no amount of
    client-side sorting fixes.
  */
  sequence          INTEGER NOT NULL,

  /*
    Regeneration lineage (§7): a regenerated answer is a *new* row pointing at
    the one it replaced, never a mutation in place. That preserves history and
    keeps a version switcher available without a schema change.
  */
  parent_id         UUID REFERENCES messages(id) ON DELETE SET NULL,

  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        INTEGER,
  finish_reason     TEXT,
  error_code        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (conversation_id, sequence)
);

CREATE INDEX messages_by_conversation_idx ON messages (conversation_id, sequence);

-- ─── message_citations ───────────────────────────────────────────────────────
CREATE TABLE message_citations (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  message_id        UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,

  /*
    `ON DELETE CASCADE` on the chunk, deliberately (docs/04 §1.1).

    Deleting a document removes it from the index and from future answers,
    which is the privacy promise. The *link* disappears with it while
    `content_snapshot` survives on this row via the message — so past
    conversations stay readable and past citations stay verifiable.
  */
  chunk_id          UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  /** The `[n]` the user sees. Numbered in the prompt exactly as in the UI. */
  citation_index    INTEGER NOT NULL,
  score             REAL NOT NULL,

  /*
    The chunk's text at answer time (docs/04 §1.1).

    An intentional, bounded denormalization that buys audit integrity: "if the
    user later deletes the document, the historical answer must still be able
    to show what it was based on, and a dangling FK would otherwise make every
    past citation unresolvable."
  */
  content_snapshot  TEXT NOT NULL,

  UNIQUE (message_id, citation_index)
);

CREATE INDEX message_citations_by_message_idx ON message_citations (message_id);
