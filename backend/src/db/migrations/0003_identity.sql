-- Identity tables, copied from docs/04-data-and-api.md §1.1.

-- ─── users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  -- CITEXT, so uniqueness and lookup are case-insensitive in the database
  -- rather than depending on every call site lowercasing first. That is how
  -- accounts differing only by capitalisation get created.
  email               CITEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  -- Nullable timestamp rather than a boolean: "when" is strictly more
  -- information than "whether", and FR-5 needs to distinguish a never-verified
  -- account from one verified long ago.
  email_verified_at   TIMESTAMPTZ,
  -- Bumping this invalidates every access token issued before the bump, with
  -- no per-request lookup (docs/04-data-and-api.md §3.1).
  token_version       INTEGER NOT NULL DEFAULT 0,
  failed_login_count  INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── refresh_tokens ──────────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the opaque token, never the token. A database disclosure hands
  -- over hashes, not live sessions.
  token_hash     TEXT NOT NULL UNIQUE,
  -- Rotation lineage. Every token descended from one sign-in shares a family,
  -- so detecting a replay lets the whole lineage be revoked at once.
  family_id      UUID NOT NULL,
  parent_id      UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT,
  user_agent     TEXT,
  ip_address     INET,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The application only ever writes these four; the constraint keeps a future
  -- hand-written UPDATE from inventing a fifth that nothing can interpret.
  CONSTRAINT refresh_tokens_revoked_reason_valid CHECK (
    revoked_reason IS NULL
    OR revoked_reason IN ('rotated', 'logout', 'reuse_detected', 'password_change')
  ),
  -- A revocation with no reason is an audit trail that cannot answer the one
  -- question it exists for.
  CONSTRAINT refresh_tokens_revocation_complete CHECK (
    (revoked_at IS NULL) = (revoked_reason IS NULL)
  )
);

-- Partial: only live tokens are ever listed, and excluding revoked rows keeps
-- the index small as rotation accumulates history.
CREATE INDEX refresh_tokens_active_by_user_idx
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Reuse detection revokes by family, so this is on the hot path of the
-- security response rather than of ordinary reads.
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- Lets expired rows be swept without a sequential scan.
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- ─── verification_tokens ─────────────────────────────────────────────────────
CREATE TABLE verification_tokens (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial on unconsumed rows: issuing a new token invalidates prior ones for
-- the same purpose, which is a lookup over exactly this set.
CREATE INDEX verification_tokens_pending_idx
  ON verification_tokens (user_id, purpose) WHERE consumed_at IS NULL;

CREATE INDEX verification_tokens_expires_at_idx ON verification_tokens (expires_at);
