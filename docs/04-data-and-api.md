# 04 — Database, API, Authentication

## 1. Database design

PostgreSQL. Conventions: `snake_case`; UUIDv7 primary keys (time-sortable, so index locality matches insertion order and range scans on creation time stay cheap — UUIDv4 randomizes B-tree inserts and fragments the index); `timestamptz` everywhere, never naked `timestamp`; `created_at`/`updated_at` on every table with an `updated_at` trigger; foreign keys with explicit `ON DELETE` behavior on every relationship.

### 1.1 Schema

```sql
-- ─── identity ────────────────────────────────────────────────────────────

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  email               CITEXT NOT NULL UNIQUE,           -- case-insensitive
  password_hash       TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  email_verified_at   TIMESTAMPTZ,
  token_version       INTEGER NOT NULL DEFAULT 0,       -- bump = invalidate all access tokens
  failed_login_count  INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,        -- SHA-256 of the opaque token; never the token
  family_id    UUID NOT NULL,               -- rotation lineage
  parent_id    UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  revoked_reason TEXT,                      -- 'rotated' | 'logout' | 'reuse_detected' | 'password_change'
  user_agent   TEXT,
  ip_address   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON refresh_tokens (family_id);

CREATE TABLE verification_tokens (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON verification_tokens (user_id, purpose) WHERE consumed_at IS NULL;

-- ─── knowledge base ──────────────────────────────────────────────────────

CREATE TYPE document_status AS ENUM ('queued','parsing','chunking','embedding','ready','failed');

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,              -- user-facing, sanitized
  original_name   TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  content_hash    TEXT NOT NULL,              -- SHA-256 of bytes: dedup + idempotency
  storage_key     TEXT NOT NULL,
  status          document_status NOT NULL DEFAULT 'queued',
  error_code      TEXT,
  error_message   TEXT,
  page_count      INTEGER,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  token_count     INTEGER,
  embedding_model TEXT,                       -- what this doc's vectors were made with
  embedding_dims  INTEGER,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON documents (user_id, created_at DESC);
CREATE UNIQUE INDEX ON documents (user_id, content_hash);   -- same file twice = one document

CREATE TABLE document_chunks (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- denormalized, see note
  chunk_index    INTEGER NOT NULL,
  content        TEXT NOT NULL,
  token_count    INTEGER NOT NULL,
  page_number    INTEGER,
  section_path   TEXT,                        -- "3. Termination > 3.2 Notice"
  char_start     INTEGER,
  char_end       INTEGER,
  vector_id      TEXT,                        -- id in the external vector store
  content_tsv    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)           -- makes re-ingestion idempotent
);
CREATE INDEX ON document_chunks USING GIN (content_tsv);   -- BM25 half of hybrid search
CREATE INDEX ON document_chunks (user_id);
CREATE INDEX ON document_chunks (document_id, chunk_index);
```

`user_id` on `document_chunks` is denormalized on purpose. It is the tenant filter for lexical search; without it every keyword query joins to `documents` to prove ownership, and the join sits in the hot path of the most latency-sensitive operation in the product. The cost is one redundant column kept correct by the fact that chunks are only ever created by the ingestion pipeline, which already holds the owner.

```sql
-- ─── conversations ───────────────────────────────────────────────────────

CREATE TYPE message_role AS ENUM ('user','assistant','system');
CREATE TYPE message_status AS ENUM ('pending','streaming','complete','stopped','failed');

CREATE TABLE conversations (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL DEFAULT 'New conversation',
  title_generated   BOOLEAN NOT NULL DEFAULT false,
  summary           TEXT,                     -- rolling summary for long threads
  summary_upto_seq  INTEGER,
  message_count     INTEGER NOT NULL DEFAULT 0,
  last_message_at   TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations (user_id, last_message_at DESC NULLS LAST)
  WHERE archived_at IS NULL;

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             message_role NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  status           message_status NOT NULL DEFAULT 'complete',
  sequence         INTEGER NOT NULL,          -- stable ordering; ties impossible
  parent_id        UUID REFERENCES messages(id) ON DELETE SET NULL,  -- regeneration lineage
  model            TEXT,
  prompt_tokens    INTEGER,
  completion_tokens INTEGER,
  latency_ms       INTEGER,
  finish_reason    TEXT,
  error_code       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence)
);
CREATE INDEX ON messages (conversation_id, sequence);

CREATE TABLE message_citations (
  id            UUID PRIMARY KEY DEFAULT uuidv7(),
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chunk_id      UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  citation_index INTEGER NOT NULL,            -- the [n] shown to the user
  score          REAL NOT NULL,
  content_snapshot TEXT NOT NULL,             -- see note
  UNIQUE (message_id, citation_index)
);
```

`content_snapshot` duplicates the chunk text at answer time. Reason: if the user later deletes the document, the historical answer must still be able to show what it was based on, and a dangling FK would otherwise make every past citation unresolvable. This is an intentional, bounded denormalization that buys audit integrity. The `ON DELETE CASCADE` on `chunk_id` means the *link* disappears with the document while the snapshot row survives via the message — so deletion still removes the document from the index and from future answers, satisfying the privacy promise, while past conversations remain readable.

```sql
-- ─── jobs & usage ────────────────────────────────────────────────────────

CREATE TYPE job_status AS ENUM ('pending','processing','completed','failed');

CREATE TABLE jobs (
  id           UUID PRIMARY KEY DEFAULT uuidv7(),
  type         TEXT NOT NULL,                  -- 'ingest_document'
  payload      JSONB NOT NULL,
  status       job_status NOT NULL DEFAULT 'pending',
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX ON jobs (status, run_after, priority DESC) WHERE status = 'pending';
CREATE INDEX ON jobs (status, locked_at) WHERE status = 'processing';   -- reaper

CREATE TABLE usage_events (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                   -- 'embedding' | 'completion'
  model       TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros   BIGINT NOT NULL DEFAULT 0,     -- integer money, never float
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_events (user_id, created_at DESC);
```

### 1.2 Notes on deliberate choices

- **Vectors are not in Postgres in Phase 1.** ChromaDB holds embeddings; `document_chunks.vector_id` is the join. This keeps the pgvector extension out of the dependency list while the interface is proven. The migration path is real: `pgvector.store.ts` implements the same interface, the chunk text and metadata already live in Postgres, and switching means re-embedding into a new column and flipping `VECTOR_STORE`. Chroma is treated as a **derived index, never a source of truth** — everything needed to rebuild it lives in Postgres.
- **No soft deletes on documents.** A `deleted_at` column that retains content contradicts the privacy promise in §00/4. Deletion is a real `DELETE` with cascade plus a vector-store purge.
- **Money as `BIGINT` micros.** Floating-point currency is a bug waiting for a spreadsheet.
- **Migrations are forward-only, plain SQL, numerically ordered**, applied in a transaction, tracked in a `schema_migrations` table. No down-migrations: in practice they are written once, never tested, and give false confidence. Rolling back means writing a new forward migration.

---

## 2. API design

REST, `/api/v1` prefix, JSON. Versioned from day one because a breaking change after users exist without a version prefix has no clean path.

Conventions: plural nouns; verbs only for genuine non-CRUD actions (`/refresh`, `/stop`); `200` read, `201` create, `204` delete/no-body, `202` accepted-for-async; cursor pagination (`?cursor=&limit=`) rather than offset, because offset pagination shifts and duplicates rows when new items are inserted at the head — which is exactly what a conversation list does; every mutating endpoint validated by a shared Zod schema; every response envelope-free except errors.

### 2.1 Auth
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/signup` | — | 201. Creates user, sends verification mail, issues both tokens |
| POST | `/auth/login` | — | 200 `{ user, accessToken }` + refresh cookie |
| POST | `/auth/refresh` | cookie | 200 new access token + rotated refresh cookie |
| POST | `/auth/logout` | cookie | 204. Revokes the presented token |
| POST | `/auth/logout-all` | access | 204. Revokes every family, bumps `token_version` |
| POST | `/auth/verify-email` | — | body `{ token }` |
| POST | `/auth/resend-verification` | access | rate-limited, 60s cooldown |
| POST | `/auth/forgot-password` | — | 200 always, regardless of account existence |
| POST | `/auth/reset-password` | — | `{ token, password }`. Revokes all sessions |
| GET | `/auth/me` | access | Current user |

### 2.2 User
`PATCH /users/me` · `POST /users/me/password` (requires current password, revokes other sessions) · `DELETE /users/me` (requires password, cascades everything) · `GET /users/me/usage`.

### 2.3 Documents
| Method | Path | Notes |
|---|---|---|
| POST | `/documents` | multipart, ≤5 files. **202** with document rows in `queued`. Returns immediately; ingestion is a job |
| GET | `/documents` | cursor paginated, `?status=` filter |
| GET | `/documents/:id` | |
| DELETE | `/documents/:id` | 204. Rows + bytes + vectors |
| POST | `/documents/:id/retry` | Re-enqueues a failed document |
| GET | `/documents/events` | **SSE** — status transitions for all of this user's in-flight documents |

### 2.4 Conversations & messages
| Method | Path | Notes |
|---|---|---|
| POST | `/conversations` | 201 |
| GET | `/conversations` | cursor paginated |
| GET | `/conversations/:id` | |
| PATCH | `/conversations/:id` | rename / archive |
| DELETE | `/conversations/:id` | 204 |
| GET | `/conversations/:id/messages` | cursor, ascending by `sequence` |
| POST | `/conversations/:id/messages` | **SSE stream.** Body `{ content }`. The core endpoint |
| POST | `/conversations/:id/messages/:messageId/regenerate` | SSE. Replaces the assistant turn |
| POST | `/conversations/:id/stop` | 204. Aborts the in-flight generation |
| DELETE | `/messages/:id` | 204. Deletes the turn pair |
| POST | `/messages/:id/feedback` | P1 |

`POST /conversations/:id/messages` returning a stream rather than a JSON body is the one place the API departs from plain REST, and it is deliberate: the alternative — create the message, then open a separate SSE connection to watch it — doubles round trips, introduces a race where the stream is opened after generation has begun, and requires a server-side buffer for tokens emitted in the gap. One request, one stream, one lifecycle.

### 2.5 Health
`GET /health` (liveness, no dependencies) · `GET /health/ready` (database, vector store, provider reachability).

---

## 3. Authentication flow

### 3.1 Token strategy

| | Access token | Refresh token |
|---|---|---|
| Format | JWT (HS256) | Opaque 32-byte random, base64url |
| Lifetime | 15 minutes | 30 days |
| Transport | Response body → in-memory | `httpOnly` `Secure` `SameSite=Strict` cookie, path `/api/v1/auth` |
| Storage | Client memory only | Server: SHA-256 hash. Client: cookie only |
| Claims | `sub`, `email`, `emailVerified`, `tokenVersion`, `typ:'access'`, `iat`, `exp`, `jti` | — |
| Revocable | Not individually — mitigated by 15-min TTL + `tokenVersion` | Yes, immediately |

**Why this split.** The access token is stateless so the hot path never touches the database. It is short-lived because it cannot be individually revoked. The refresh token is opaque and server-stored so it *can* be revoked, and it is stored hashed so a database disclosure does not hand over live sessions.

**Why the access token is never in `localStorage`.** Any XSS reads `localStorage` synchronously and exfiltrates the token. In memory, a token dies with the tab and is not reachable by an injected script that runs before the app initializes. The cost is re-authenticating on page load, which the silent refresh makes invisible.

**Why the refresh cookie is `SameSite=Strict` and path-scoped.** `Strict` blocks it from being sent on any cross-site request, which eliminates CSRF for the refresh endpoint outright. Scoping the path to `/api/v1/auth` means it is not attached to every ordinary API call, reducing exposure surface. Because every other endpoint authenticates with an `Authorization` header rather than a cookie, the API is not CSRF-vulnerable by construction — the header cannot be set cross-origin without CORS approval.

### 3.2 Rotation and reuse detection

Every refresh returns a **new** refresh token and revokes the old one with reason `rotated`, keeping `family_id` and setting `parent_id`. If a token that is already revoked is presented, that means it was captured and replayed — the legitimate client has since rotated past it. Response: **revoke the entire family**, force full re-authentication, log a security event.

This is the standard mitigation for stolen refresh tokens and it turns silent, indefinite account access into a session that dies the moment either party uses it twice. Implementing rotation *without* reuse detection is worse than not rotating, since it produces churn with no security gain.

The rotation transaction is serialized per token row (`SELECT … FOR UPDATE`) so two simultaneous refreshes cannot both succeed and cross-revoke. The client-side single-flight promise (§02/6.1) is the matching half of this contract.

### 3.3 Flows

**Signup:** validate → normalize email → check uniqueness (generic conflict message) → argon2id hash → check the password against a breached-password list (k-anonymity range query, so the password never leaves the server) → insert user → create verification token (32-byte random, hashed at rest, 24h TTL) → send mail → issue tokens → 201.

**Login:** look up by email → **always** run a hash verification, using a dummy hash when the user does not exist, so response timing does not reveal account existence → check lockout → verify → on failure increment the counter and apply exponential backoff after 5 → on success reset counters, create a refresh family, issue tokens.

**Password reset:** request → always respond 200 → if the account exists, invalidate prior reset tokens, create one (1h TTL, single-use), mail it. Reset → validate token and expiry, mark consumed atomically (`UPDATE … WHERE consumed_at IS NULL RETURNING` — an atomic conditional update, not read-then-write, which would be racy) → hash the new password → **revoke all refresh families and bump `token_version`** so existing access tokens die too → notify by email that the password changed.

**Email verification:** same token mechanics, 24h TTL. Verification sets `email_verified_at` and issues fresh tokens carrying the updated claim, so the client's `require-verified` gate lifts without a sign-out.

### 3.4 Rate limits

| Endpoint | Limit |
|---|---|
| `/auth/login` | 5 / 15 min per IP+email, plus per-account exponential backoff |
| `/auth/signup` | 3 / hour per IP |
| `/auth/forgot-password` | 3 / hour per email, 10 / hour per IP |
| `/auth/refresh` | 30 / 15 min per IP |
| `/documents` POST | 20 / hour per user |
| `/conversations/:id/messages` | 30 / hour per user (cost control) |
| global | 300 / 15 min per IP |

Phase 1 uses an in-memory store; the limiter is written behind an interface so a shared store slots in when there is more than one process. Documented explicitly as a single-node assumption in §06 risks.

---

## 4. Security summary

Input: Zod validation on every route with unknown-key stripping; parameterized queries only (Kysely makes string concatenation awkward by design); magic-byte file sniffing; upload size caps enforced before the body is buffered; a sanitize allowlist on rendered markdown (`rehype-sanitize`) so a malicious document cannot inject script through a model answer that echoes it.

Output: uniform error shape with no internal detail; no stack traces in production responses; document content excluded from logs.

Headers: helmet defaults plus a strict CSP (`default-src 'self'`, no `unsafe-inline` for scripts, nonce for the theme bootstrap script), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Powered-By` removed.

CORS: explicit origin allowlist from config, `credentials: true`, no wildcard. A wildcard with credentials is rejected by browsers anyway, and reaching for it is the usual sign of a misunderstood CORS failure.

Tenancy: repository-level `user_id` scoping (§03/1) as the primary defense, with route-level ownership assertions as a secondary check. Two independent layers, because IDOR is the most common real vulnerability in applications shaped like this one.
