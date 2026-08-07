# 03 — Backend Architecture

## 1. Layered architecture

Four layers, strictly one-directional dependencies:

```
HTTP  →  Route  →  Controller  →  Service  →  Repository  →  Database
                                      ↓
                              Provider adapters
                       (LLM, embeddings, vector store, storage, mail)
```

| Layer | Owns | Forbidden |
|---|---|---|
| **Route** | Path, method, middleware chain, validation schema binding | Any logic |
| **Controller** | Read validated input, call one service, map result to an HTTP response | Business rules, SQL, direct provider calls |
| **Service** | All business logic, orchestration, authorization decisions, transactions | Express types (`Request`, `Response`), raw SQL |
| **Repository** | SQL, row↔domain mapping, tenant scoping | Business rules, HTTP concepts |
| **Provider** | External systems behind an interface | Knowledge of Lumora's domain |

**The rule that makes this real: services never import from `express`.** A service takes plain arguments and an actor context and returns a plain value or throws a typed `AppError`. This means every business rule is unit-testable without an HTTP server, and swapping Express for Fastify later touches only the two thin outer layers. In most "layered" Node codebases the service takes `(req, res)` and the layering is decorative — that is what this rule prevents.

**Repositories always scope by owner.** Every query that touches user data carries `user_id` in its `WHERE` clause. Not `findById(id)` then an ownership check in the service — `findByIdForUser(id, userId)`. An ownership check that lives in a service can be forgotten by the next endpoint; a repository signature that *requires* the user id cannot be. This makes IDOR structurally difficult rather than merely prohibited.

**Why not an ORM.** Postgres accessed through `pg` + `Kysely` (type-safe query builder). Kysely gives compile-time-checked SQL against a generated schema type with no runtime cost and no hidden query generation. Prisma was considered and rejected: RAG work needs full SQL control (CTEs, `FOR UPDATE SKIP LOCKED`, `ts_rank_cd`, window functions), and Prisma's escape hatch to raw SQL loses exactly the type safety that justified it. TypeORM rejected for its decorator-driven active-record patterns, which entangle the domain with persistence.

---

## 2. Folder structure

```
backend/
├── src/
│   ├── server.ts                   process entry: config load, DB connect, listen, graceful shutdown
│   ├── app.ts                      Express app assembly (no listen — makes supertest trivial)
│   │
│   ├── config/
│   │   ├── env.ts                  Zod-validated environment; throws at boot on anything missing
│   │   ├── database.ts             pool config
│   │   ├── constants.ts            limits, TTLs, chunking parameters
│   │   └── index.ts
│   │
│   ├── api/
│   │   ├── routes/
│   │   │   ├── index.ts            mounts /api/v1
│   │   │   ├── auth.routes.ts
│   │   │   ├── user.routes.ts
│   │   │   ├── document.routes.ts
│   │   │   ├── conversation.routes.ts
│   │   │   ├── message.routes.ts
│   │   │   └── health.routes.ts
│   │   ├── controllers/            one per route file
│   │   ├── middleware/
│   │   │   ├── authenticate.ts     verify access token → req.actor
│   │   │   ├── require-verified.ts
│   │   │   ├── validate.ts         Zod on body/query/params
│   │   │   ├── rate-limit.ts       per-route limiter factory
│   │   │   ├── upload.ts           multer: memory, size cap, magic-byte sniff
│   │   │   ├── request-context.ts  request id, timing, child logger
│   │   │   ├── error-handler.ts    terminal handler
│   │   │   ├── not-found.ts
│   │   │   └── security.ts         helmet, CORS, body limits
│   │   └── validators/             Zod schemas re-exported from shared/
│   │
│   ├── services/
│   │   ├── auth/
│   │   │   ├── auth.service.ts         signup, login, logout
│   │   │   ├── token.service.ts        issue, verify, rotate, reuse detection
│   │   │   ├── password.service.ts     argon2id hash/verify, breach check
│   │   │   └── verification.service.ts email verify + password reset tokens
│   │   ├── user/user.service.ts
│   │   ├── document/
│   │   │   ├── document.service.ts     upload, list, delete, quota
│   │   │   └── quota.service.ts
│   │   ├── ingestion/
│   │   │   ├── ingestion.service.ts    pipeline orchestration
│   │   │   ├── parser.service.ts       format dispatch → normalized text
│   │   │   ├── chunker.service.ts      structure-aware splitting
│   │   │   └── embedding.service.ts    batching, dedup, retry
│   │   ├── retrieval/
│   │   │   ├── retrieval.service.ts    hybrid search + fusion
│   │   │   ├── query-transform.service.ts  history-aware rewrite
│   │   │   └── context-builder.service.ts  token-budgeted packing
│   │   ├── chat/
│   │   │   ├── chat.service.ts         turn orchestration + streaming
│   │   │   ├── conversation.service.ts CRUD, titling
│   │   │   ├── memory.service.ts       history window + summarization
│   │   │   └── prompt.service.ts       template assembly
│   │   └── jobs/
│   │       ├── job.service.ts          enqueue, claim, complete, fail
│   │       └── worker.ts               poll loop + handler registry
│   │
│   ├── repositories/
│   │   ├── base.repository.ts          shared transaction helpers
│   │   ├── user.repository.ts
│   │   ├── refresh-token.repository.ts
│   │   ├── verification-token.repository.ts
│   │   ├── document.repository.ts
│   │   ├── chunk.repository.ts         includes BM25 lexical search
│   │   ├── conversation.repository.ts
│   │   ├── message.repository.ts
│   │   ├── citation.repository.ts
│   │   └── job.repository.ts
│   │
│   ├── providers/
│   │   ├── llm/
│   │   │   ├── llm-provider.interface.ts
│   │   │   ├── gemini.provider.ts
│   │   │   ├── openai.provider.ts
│   │   │   └── llm.factory.ts
│   │   ├── embedding/
│   │   │   ├── embedding-provider.interface.ts
│   │   │   ├── gemini-embedding.provider.ts
│   │   │   ├── openai-embedding.provider.ts
│   │   │   └── embedding.factory.ts
│   │   ├── vector/
│   │   │   ├── vector-store.interface.ts
│   │   │   ├── chroma.store.ts
│   │   │   ├── pgvector.store.ts        (stub — proves the interface holds)
│   │   │   └── vector.factory.ts
│   │   ├── storage/
│   │   │   ├── storage-provider.interface.ts
│   │   │   └── local-disk.storage.ts
│   │   └── mail/
│   │       ├── mail-provider.interface.ts
│   │       ├── console.mail.ts          dev: logs the link
│   │       ├── smtp.mail.ts
│   │       └── templates/
│   │
│   ├── domain/
│   │   ├── entities/                   plain domain types
│   │   ├── errors/
│   │   │   ├── app-error.ts            base with httpStatus + code
│   │   │   ├── auth-errors.ts
│   │   │   ├── resource-errors.ts
│   │   │   ├── validation-errors.ts
│   │   │   └── error-codes.ts          shared with frontend
│   │   └── events/                     in-process emitter contracts
│   │
│   ├── db/
│   │   ├── pool.ts
│   │   ├── schema.d.ts                 generated Kysely types
│   │   ├── migrations/                 NNNN_name.sql, forward-only
│   │   ├── migrate.ts                  runner
│   │   └── seeds/
│   │
│   ├── lib/
│   │   ├── logger.ts                   pino + redaction
│   │   ├── crypto.ts                   random tokens, hashing
│   │   ├── tokenizer.ts                token counting
│   │   ├── text.ts                     normalization, cleanup
│   │   ├── sse.ts                      SSE writer + heartbeat
│   │   ├── result.ts                   Result<T,E> for expected failures
│   │   └── async.ts                    retry, backoff, concurrency limiter
│   │
│   └── types/
│       ├── express.d.ts                Request augmentation: actor, requestId, log
│       └── common.ts
│
├── tests/  { unit, integration, fixtures }
├── uploads/                            local file storage (gitignored)
├── .env.example
├── tsconfig.json
├── eslint.config.js
└── package.json
```

---

## 3. Middleware chain

Order matters and is deliberate:

```
1  helmet                    security headers before anything can respond
2  cors                      strict origin allowlist, credentials: true
3  request-context           request id (accept inbound X-Request-Id or generate), child logger, hrtime
4  body parsers              json 1MB / urlencoded — small, because uploads use multipart
5  cookie-parser
6  rate-limit (global)       coarse per-IP ceiling
7  routes                    per-route: rate-limit → authenticate → require-verified → validate → upload → controller
8  not-found                 404 for unmatched paths
9  error-handler             terminal, four arguments
```

**`authenticate`** verifies the access token's signature, expiry, `typ: 'access'` claim, and token version, then attaches `req.actor = { userId, email, emailVerified, tokenVersion }`. It never queries the database — that is the entire point of a stateless access token. Revocation is handled by the short 15-minute lifetime plus a `token_version` claim compared against a value the JWT already carries, incremented on password change or global sign-out, meaning tokens issued before the change fail verification without a per-request lookup.

**`validate`** takes `{ body?, query?, params? }` Zod schemas and *replaces* `req.body` with the parsed output. Replacement matters: parsed output is stripped of unknown keys and coerced to the correct types, so a downstream service can never accidentally read an unvalidated field.

**`upload`** uses multer memory storage with a hard size limit, then sniffs magic bytes (`file-type`) and rejects any mismatch with the declared extension. Extension and client `Content-Type` are both attacker-controlled and are never trusted.

---

## 4. Error model

One base class; everything thrown by services is a subclass.

```ts
class AppError extends Error {
  constructor(
    readonly code: ErrorCode,        // machine-readable, shared with the frontend
    readonly httpStatus: number,
    message: string,                 // safe to show a user
    readonly details?: unknown,      // field errors etc.
    readonly cause?: unknown,        // internal only — logged, never serialized
  ) { super(message); }
}
```

Subclasses: `UnauthorizedError` 401 · `ForbiddenError` 403 · `NotFoundError` 404 · `ConflictError` 409 · `ValidationError` 422 · `RateLimitError` 429 · `ProviderError` 502 · `QuotaExceededError` 403.

Wire format is uniform for every failure:
```json
{ "error": { "code": "DOCUMENT_NOT_FOUND", "message": "Document not found.",
             "details": null, "requestId": "req_01H…" } }
```

Terminal handler rules: `AppError` → its own status and code. Zod error → 422 with field details. Anything unrecognized → 500 with code `INTERNAL_ERROR` and a **generic** message, with the real error and stack logged against the request id. Stack traces and provider messages never cross the wire — leaking them hands an attacker the internals map. The `requestId` in the response is what lets a user report a problem that engineers can trace.

`asyncHandler` wraps every controller so a rejected promise reaches the terminal handler instead of becoming an unhandled rejection.

---

## 5. Configuration

`config/env.ts` parses `process.env` through Zod at boot and **exits non-zero on any failure**. Fail-fast beats discovering at 2am that `JWT_SECRET` was undefined and tokens were signed with `"undefined"`. Nothing else in the codebase reads `process.env` — a lint rule forbids it outside this file, so every configuration value is typed and its existence is proven.

```
NODE_ENV  PORT  APP_URL  API_URL  CORS_ORIGINS
DATABASE_URL  DATABASE_POOL_MAX
JWT_ACCESS_SECRET  JWT_ACCESS_TTL=15m  REFRESH_TOKEN_TTL_DAYS=30
LLM_PROVIDER=gemini|openai  GEMINI_API_KEY  OPENAI_API_KEY  LLM_MODEL  LLM_MAX_TOKENS
EMBEDDING_PROVIDER  EMBEDDING_MODEL  EMBEDDING_DIMENSIONS
VECTOR_STORE=chroma|pgvector  CHROMA_URL
STORAGE_DRIVER=local  UPLOAD_DIR
MAIL_DRIVER=console|smtp  SMTP_*  MAIL_FROM
MAX_FILE_SIZE_MB=25  MAX_FILES_PER_USER=100  MAX_TOTAL_BYTES_MB=500
RATE_LIMIT_*  LOG_LEVEL
```

Secrets are validated for minimum length. In production the schema additionally refuses known development defaults.

---

## 6. Logging

`pino`, structured JSON, one child logger per request carrying `requestId` and `userId`.

**Redaction is configured at the logger, not left to call sites**: `password`, `token`, `refreshToken`, `authorization`, `cookie`, `apiKey`, and — critically — any field carrying document text or message content. A logger that prints a user's contract is a privacy incident, so the redaction list treats content fields as secrets.

What gets logged: request start/finish with method, path, status, duration, and byte count; every 5xx with its full cause and stack; auth events (login success/failure, refresh rotation, reuse detection) without credentials; ingestion job transitions with document id, phase, and durations; provider calls with model, token counts, latency, and cost estimate — **never prompt or completion bodies**.

Log levels: `error` needs human attention · `warn` is degraded but handled (provider retry, rate limit hit) · `info` is a state change · `debug` is development only.

A `Logger` interface wraps pino so the implementation can change without touching call sites. Tracing and metrics are deliberately out of scope for Phase 1, but the request-id plumbing is the seam that makes adding them later a small change.

---

## 7. Background jobs — durable, in Postgres

Ingestion cannot run inside the upload request: parsing and embedding a 200-page PDF takes minutes, and an HTTP request that long will be killed by a proxy, will hold a connection, and will lose all progress on a client disconnect.

**Decision: a job table in Postgres claimed with `FOR UPDATE SKIP LOCKED`, polled by an in-process worker.** No Redis, no BullMQ, no external broker.

Justification: adding Redis for a single queue at Phase 1 scale is infrastructure the project explicitly does not want yet, and it introduces a second datastore with its own persistence semantics. `SKIP LOCKED` is a purpose-built Postgres feature for exactly this; it gives atomic claiming, durability, and transactional consistency with the document rows the jobs mutate — meaning a job and its document status update commit together or not at all, which a separate Redis queue cannot guarantee. It comfortably handles thousands of jobs per minute, far beyond Phase 1 need.

The worker is a module started by `server.ts` but written with **zero coupling to the HTTP layer**. Moving it to its own process later is changing an entry point, not refactoring.

```
claim:     UPDATE jobs SET status='processing', locked_at=now(), locked_by=$worker,
             attempts=attempts+1
           WHERE id = (SELECT id FROM jobs
                       WHERE status='pending' AND run_after <= now()
                       ORDER BY priority DESC, created_at
                       FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING *
success:   status='completed', completed_at=now()
failure:   attempts < max → status='pending', run_after = now() + backoff(attempts)
           attempts >= max → status='failed', persist error, mark document failed with reason
reaper:    rows in 'processing' with locked_at older than the lease → returned to 'pending'
```

Retries use exponential backoff with jitter. Handlers must be **idempotent** — a retry after a partial embedding run must not double-insert vectors, so chunks are written with a deterministic id derived from `(document_id, chunk_index)` and upserted.

Concurrency is bounded (default 2 concurrent ingestion jobs) because embedding calls are rate-limited upstream and unbounded parallelism just converts provider 429s into failures.

Graceful shutdown: `SIGTERM` stops claiming new jobs, waits for in-flight ones up to a timeout, releases their leases, then closes the pool and the HTTP server. Without this, a restart strands documents in `processing` until the reaper runs.

---

## 8. Real-time delivery — SSE, not WebSockets

Two streams: chat generation, and document ingestion status.

**Server-Sent Events chosen over WebSockets.** Both flows are strictly server→client; there is no client→server message channel to justify a bidirectional protocol. SSE is plain HTTP, so it inherits the existing auth middleware, CORS policy, rate limiting, and logging unchanged, and it passes through proxies that mishandle upgrade requests. WebSockets would require a parallel authentication path (tokens in query strings or a post-connect handshake — both worse), a separate connection lifecycle, and heartbeat/reconnect logic that SSE gives natively.

Implementation notes: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` (defeats proxy buffering, which otherwise makes streaming arrive in one chunk at the end and silently destroys the entire feature), a 15s comment heartbeat to keep intermediaries from timing the connection out, and a `close` listener on the request that aborts the provider call so a user who navigates away stops incurring generation cost immediately.

Named events give the client a typed protocol rather than string sniffing:
```
event: status     data: {"phase":"retrieving"}
event: sources    data: {"sources":[…]}
event: token      data: {"text":"Revenue "}
event: citation   data: {"index":1,"chunkId":"…"}
event: done       data: {"messageId":"…","usage":{…},"finishReason":"stop"}
event: error      data: {"code":"PROVIDER_ERROR","message":"…"}
```

`sources` is sent **before** the first token deliberately: the UI can render the source list while the model is still writing, which removes the perception of a stall during the slowest part of the request.

---

## 9. Testing

- **Unit** — services with mocked repositories and providers. This is where the "no Express in services" rule pays off: business logic tests need no server, no supertest, no HTTP fixtures.
- **Integration** — real Postgres (a dedicated test database), each test wrapped in a transaction rolled back afterward, so tests are isolated without truncation between them. Repositories and full route flows via supertest against `app.ts`.
- **Contract** — every response validated against the shared Zod schema in tests, so an accidental field rename fails the backend test suite rather than the frontend at runtime.
- Providers are always faked in tests. Deterministic fake embeddings (hash-derived vectors) make retrieval assertions stable and free.
- Priority: token service (rotation and reuse detection) → auth flows → ownership scoping on every resource route → chunker boundaries → retrieval fusion → job claim/retry/idempotency.
