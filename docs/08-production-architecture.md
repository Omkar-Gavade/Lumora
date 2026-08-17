# 08 — Production Cloud Architecture

**CURRENT:** local development on Docker.
**TARGET:** managed cloud deployment serving real multi-user traffic.
**STATUS: planning complete; implementation not started.**

No cloud resource exists. No infrastructure code exists. Nothing in this
document has been built. It exists so the deployment is executed from a plan
rather than improvised.

> Filed as `08-…` in the flat numbered set rather than `docs/architecture/production.md`.
> The repository's convention is one numbered document per concern at the root
> of `docs/`, cross-linked from [README.md](README.md); a lone nested directory
> would be the only one and would hide this file from that index.

> **A premise worth correcting.** Lumora does not "already use AWS concepts."
> There is no AWS SDK, no S3 client, no IAM, and no cloud dependency anywhere
> in the repository — `STORAGE_DRIVER` is `z.enum(['local'])` and the only
> implementation is `local.storage.ts`. AWS is recommended below on its merits,
> not on an existing footprint.

---

## 1. Current architecture, exactly as it exists

```
Developer machine (8 GB RAM, Docker limited to ~2 GB)
├── Vite dev server         :5273   (frontend, VITE_API_URL only)
├── Node/Express API        :4000   (tsx watch; worker in-process)
│     └── backend/uploads/{userId}/{documentId}   ← original files, local disk
├── lumora-pg               :5432   docker volume lumora-postgres-data
└── lumora-chroma           :8000   docker volume lumora-chroma-data
                                     collection per user: user_{userId}
External: Gemini (gemini-embedding-001 @768, gemini-3.5-flash), SMTP, HIBP
```

### 1.1 What each table stores

| Table | Contents |
|---|---|
| `users` | `email` (citext, unique), `password_hash`, `display_name`, `token_version`, `failed_login_count`, `locked_until` |
| `refresh_tokens` | **SHA-256 hash** of the opaque token (unique), rotation `family`, expiry |
| `verification_tokens` | **SHA-256 hash** of email-verify / password-reset tokens |
| `documents` | filename, mime, size, `content_hash`, `storage_key`, status, page/chunk counts |
| `document_chunks` | **the chunk text**, `content_tsv` (generated), `vector_id`, page/section locators |
| `conversations` | title, `title_generated`, summary, `message_count`, `last_message_at` |
| `messages` | role, content, status, latency, error code |
| `message_citations` | citation index → chunk, plus `content_snapshot` |
| `jobs` | ingestion queue, claimed with `FOR UPDATE SKIP LOCKED`, leases + heartbeats |
| `usage_events` | token and cost accounting |

### 1.2 Production blockers in the current setup

| # | Blocker | Evidence |
|---|---|---|
| B-1 | Uploads on container-local disk | `STORAGE_LOCAL_ROOT=./uploads` |
| B-2 | **No S3 driver exists** | `STORAGE_DRIVER: z.enum(['local'])` — the factory's `switch` has no `default`, deliberately, so adding `'s3'` is a compile error until implemented |
| B-3 | Postgres and Chroma in local Docker volumes | `docker-compose.yml` |
| B-4 | **In-memory rate limiting** | `MemoryRateLimitStore`; behind a `RateLimitStore` interface, so swappable |
| B-5 | **In-process abort registry** | `Map<string, AbortController>` in `abort-registry.ts` |
| B-6 | Dev secrets in local `.env` | four `.env` files, all gitignored |

B-4 and B-5 are [06-roadmap.md](06-roadmap.md) **R7**, named in advance:
*"In-memory rate limiting, the in-process abort registry, and the in-process
worker are all incorrect the moment there are two instances… Phase 1 is
explicitly single-node."* This is the single most important constraint on the
target architecture and §7 addresses it head-on.

---

## 2. Source of truth

The proposed model is **correct**, and the repository already enforces it.

```
AUTHORITATIVE                                DERIVED
─────────────                                ───────
Object storage → original uploaded files     Vector index → embeddings
PostgreSQL     → users, auth, documents,
                 chunk text, conversations,
                 messages, citations,
                 jobs, usage
```

`vector-store.interface.ts` states it outright: *"The store is a derived index,
never a source of truth… Everything needed to rebuild it lives in Postgres,
which is what makes switching backends a re-index rather than a data
migration."*

**The rebuild path is not theoretical — it already ships.** `backend/scripts/reindex.ts`
exists as an operational command, written after M7 hit a real version of this
(an 8-dimension index under a 768-dimension configuration). Vector ids are
deterministic (`{documentId}:{chunkIndex}`), so a rebuild overwrites rather
than duplicates.

**Losing the vector index costs a re-embedding bill and some minutes. Losing
Postgres or object storage is unrecoverable.** Backup priority follows.

---

## 3. Data mapping

| Data | Current | Production | Authority | Backup |
|---|---|---|---|---|
| Users, **emails** | `users` @ Docker PG | Managed PostgreSQL | **Authoritative** | Automated + PITR |
| **Plaintext passwords** | **never stored** | **never stored** | — | — |
| **Password hashes** | `users.password_hash` (argon2id) | Managed PostgreSQL | **Authoritative** | Automated + PITR |
| Refresh tokens | SHA-256 hash | Managed PostgreSQL | Authoritative | PITR (short-lived) |
| Verification tokens | SHA-256 hash | Managed PostgreSQL | Authoritative | PITR (short-lived) |
| Document metadata | `documents` | Managed PostgreSQL | Authoritative | Automated + PITR |
| **Original files** | `backend/uploads/…` | **Object storage (S3)** | **Authoritative** | Versioning + cross-region |
| **Chunk text** | `document_chunks.content` | **Managed PostgreSQL** | **Authoritative** | Automated + PITR |
| `content_tsv` | generated column | Managed PostgreSQL | Derived (in-row) | With the table |
| **Embeddings** | Chroma volume | Vector store (§6) | **Derived** | **Optional — re-indexable** |
| `vector_id` | `document_chunks.vector_id` | Managed PostgreSQL | Authoritative | With the table |
| Conversations, messages | PG | Managed PostgreSQL | Authoritative | Automated + PITR |
| Citations (+ snapshots) | `message_citations` | Managed PostgreSQL | Authoritative | Automated + PITR |
| Jobs | `jobs` | Managed PostgreSQL | Authoritative (transient) | PITR |
| Usage events | `usage_events` | Managed PostgreSQL | Authoritative | Automated + PITR |
| **Secrets** | local `.env` | **Secrets manager** | Authoritative | Managed by the service |

---

## 4. Authentication in production

**No redesign.** The current implementation has no production blocker — it is
the strongest part of the codebase and changing it would add risk for nothing.

Preserved exactly: argon2id at `m=19456, t=2, p=1` (OWASP profile) · SHA-256
hashed refresh tokens with rotation families and reuse detection ·
`token_version` revocation · HIBP k-anonymity breach checks · per-IP+email rate
limits · timing-equalized login.

- **Email → PostgreSQL** (`users.email`, `citext`, unique).
- **Password → nowhere.** Never stored, never logged, never in a backup.
- **Password hash → PostgreSQL** (`users.password_hash`).

Production requirements layered on top:

| Control | Requirement |
|---|---|
| In transit | TLS 1.2+ everywhere. HSTS. `DATABASE_URL` must carry `sslmode=require` — the pool passes `connectionString` straight through, so **TLS is configured by the URL, not by code** |
| At rest | Storage-level encryption on the database instance and bucket |
| DB access | Private subnet, no public endpoint; security group admits only the API and worker |
| Least privilege | App role owns its schema; no superuser. Separate migration role |
| Credentials | Secrets manager; never in an image, never in `VITE_*` |
| Rotation | Rotate `JWT_ACCESS_SECRET` deliberately — it invalidates every live access token (≤15 min of friction), which is acceptable and should be exercised once before it is needed |
| Cookies | `Secure`, `HttpOnly`, `SameSite`, and a single parent domain for API and app |

---

## 5. Object storage

**Recommendation: AWS S3**, private, with the backend brokering access.

Evaluated: S3 (mature SDK, presigned URLs, free same-region egress to the API,
lifecycle and versioning built in) · Cloudflare R2 (no egress fees — the better
choice if the backend is *not* on AWS) · GCS (no advantage here).

### 5.1 Key structure

Keep the existing shape. `documents.storage_key` already holds a relative key
and `local.storage.ts` already refuses keys escaping the root:

```
users/{userId}/documents/{documentId}/original
```

`userId` first makes an IAM/bucket-policy prefix condition expressible, and
makes an account-deletion purge a single prefix delete — which the deletion
service already needs to do.

### 5.2 Access model

**Private bucket. Public access blocked at the bucket and account level. No
object is ever public.**

| Operation | Mechanism | Why |
|---|---|---|
| Upload | **Through the backend** (as today) | The API must see the bytes: it computes `content_hash` for dedup, sniffs the real type with `file-type`, and enforces the 25 MB / 5-file limits. A presigned PUT bypasses all three, so the first malicious upload is discovered at parse time |
| Download / preview | **Short-lived presigned GET (≤5 min)**, issued after an ownership check | Streaming through Node works but burns a request-handler slot for the length of a 25 MB transfer on a single-instance API (§7). Presigned URLs move the bytes to S3 while the authorization decision stays in the backend |

Deletion is a real delete (`docs/04` §1.2: no soft deletes). Orphans — an S3
object with no `documents` row — are possible if a write fails between the two;
a periodic reconciliation job keyed on `storage_key` is the remedy, and it is
**not needed for V1** at this volume.

Limits stay as they are: `MAX_FILE_BYTES = 25 MB`, `MAX_FILES_PER_UPLOAD = 5`.

---

## 6. Vector storage — the biggest decision

| | Hosted Chroma | Self-hosted Chroma | **pgvector on the app database** | Qdrant/Pinecone |
|---|---|---|---|---|
| Fits current code | Native | Native | **Stub exists** (`pgvector.store.ts`) | New adapter |
| Tenant isolation | Per-user collection (**structural**) | Same | Row filter + RLS | Per-collection or filter |
| Persistence | Managed | EBS you manage | **With Postgres** | Managed |
| Backups | Provider | **You build it** | **Free — same PITR** | Provider |
| Ops complexity | Low | **High** (R5: single-node, weak ops story) | **Lowest — no second service** | Low |
| Cost | Subscription | Instance + EBS | **≈ zero marginal** | From ~$25/mo |
| Migration effort | Low | Low | **Implement the stub** | Medium |

**Recommendation: collapse onto `pgvector` in the production PostgreSQL.**

This is the documented direction, not an invention — [06-roadmap.md](06-roadmap.md)
Phase 2 lists *"pgvector migration to collapse to a single datastore,"* and R5
already concedes Chroma's operational story is the weaker one, mitigated only
by the interface that makes this swap a re-index.

For a first deployment it removes an entire stateful service, its backup story,
its failure mode, and its bill. At the corpus size of a first production
(thousands of chunks), an HNSW index is comfortably sufficient.

**The honest cost: tenant isolation weakens from structural to enforced.**
`vector-store.interface.ts` argues per-user collections make cross-tenant leaks
*"impossible rather than unlikely."* Under pgvector that becomes a `WHERE
user_id = $1`. Two mitigations, and both should be taken: put the filter in the
repository layer where every other query already scopes (the lexical half
already does exactly this), **and** enable Postgres **row-level security** on
`document_chunks` so the guarantee is restored at the engine rather than in
application code.

**If the pgvector stub is not implemented before launch**, the fallback is
self-hosted Chroma on a small instance with an EBS volume and scheduled
snapshots — noted as open decision **O-2**, because it changes the launch
critical path.

---

## 7. Compute

### 7.1 The single-instance constraint

**The API must run as exactly one instance at launch.** R7 is not a style note:

- **Rate limiting is per-process.** Two instances behind a load balancer means each client gets *N×* the intended limit — a silent weakening of a security control, worst on the auth endpoints.
- **The abort registry is per-process.** Stop-generation only works if the stop request reaches the instance holding the stream. With two instances it fails ~50% of the time.

Scale vertically first (Fargate task size). Horizontal scaling requires, in
order: a shared `RateLimitStore` (the interface already exists — a Postgres
table is sufficient at this scale and needs no Redis), then either sticky
sessions or a shared abort signal. **Neither is required for launch** and
neither should be built before the traffic justifies it.

### 7.2 Recommended shape

| Component | Service | Size |
|---|---|---|
| Frontend | S3 + CloudFront, or Cloudflare Pages | Static |
| API | **ECS Fargate, 1 task** behind an ALB (TLS terminates at the ALB) | 0.5 vCPU / 1 GB |
| Worker | **ECS Fargate, 1 task, separate service** | 0.5 vCPU / **2 GB** |
| Database | **RDS PostgreSQL 17**, single-AZ, private | db.t4g.micro/small, 20 GB gp3 |
| Objects | S3, private, versioned | — |

A materially cheaper and simpler alternative — **Render or Fly.io + Neon +
Cloudflare R2** — is a legitimate first-production choice and roughly halves
both the bill and the setup. It is the right answer if AWS-native is not a
requirement (open decision **O-1**).

`/health` is deliberately **liveness only** — the controller comments explain
that a database check there converts a 30-second blip into a restart storm. Use
`/health` for the ALB liveness probe and the deeper `checks.database` endpoint
for readiness/alerting, never for liveness.

### 7.3 Worker: separate deployment

**Recommendation: B — separate service.** Reasons:

1. **It needs no code change.** `WORKER_ENABLED=false` on the API plus `npm run worker` in a second container is already supported; `server.ts` says nothing in the worker depends on co-location.
2. **Memory profiles differ.** Parsing a 25 MB PDF holds its page tree, fonts, and text at once — `WORKER_CONCURRENCY=2` exists precisely because over-parallelising gets the worker OOM-killed. Co-locating means an OOM takes the API down with it.
3. **Scaling axes differ.** An ingestion backlog and a traffic spike are unrelated events.
4. **Deploys differ.** The API drains in seconds; a worker mid-document should finish its lease.

**Keep the PostgreSQL job queue. It is sufficient and it is correct.** `FOR
UPDATE SKIP LOCKED` with leases, heartbeats, and an idempotent reaper sweep is
a proven pattern well past this scale. Adding Redis or BullMQ would introduce a
second stateful service, a second failure mode, and a second backup story to
buy nothing this workload needs — [06-roadmap.md](06-roadmap.md) §3 already
records "no Redis" as a considered decision. **Multiple worker instances are
safe** whenever they are wanted: `SKIP LOCKED` is exactly the mechanism that
makes concurrent claiming correct, and it is the one component here that scales
horizontally today.

---

## 8. Frontend

Static build, CDN, HTTPS, custom domain. Build-time config only:

```
VITE_API_URL=https://api.<domain>
```

**Everything in a `VITE_*` variable is compiled into a public JavaScript bundle
and is world-readable.** No API key, database URL, JWT secret, or SMTP
credential may ever appear there. The Gemini key in particular stays
server-side — the browser never calls Gemini.

Same parent domain for app and API so refresh cookies work without third-party
cookie exposure.

---

## 9. Secrets

| Secret | Consumer |
|---|---|
| `DATABASE_URL` (with `sslmode=require`) | API, worker |
| `JWT_ACCESS_SECRET` | API |
| `GEMINI_API_KEY` | API, worker |
| `SMTP_PASSWORD` (+ host/user) | API |
| S3 credentials | API, worker — **prefer an IAM task role over static keys** |
| Vector store credentials | Only if not pgvector |
| `POSTGRES_PASSWORD` | Database provisioning only |

Development keeps local `.env` files (all gitignored, verified). Production
uses AWS Secrets Manager or SSM Parameter Store, injected as environment
variables at task start. **No secret in an image, in `VITE_*`, in a log, or in
this document.** The existing pino redaction list already covers content
fields; extend it to any new secret-bearing field.

---

## 10. Multi-tenant isolation

| Layer | Mechanism | Status |
|---|---|---|
| API | `authenticate` on every route; `req.actor.userId` never from the body | **Exists** |
| PostgreSQL | Every repository query filters `user_id`; 404 not 403 | **Exists** |
| Object storage | Key prefixed `users/{userId}/…`; presigned URLs issued only after an ownership check; bucket never public | **New** |
| Vector | Per-user collection today; **row filter + RLS under pgvector** | Changes with §6 |
| Retrieval | Lexical `c.user_id = $1`; vector via collection or filter | **Exists** |
| Documents | Ownership checked before any storage read | **Exists** |

Future Knowledge Base scoping is a **third, narrower** filter inside the user's
own data — never the only one ([07-knowledge-base.md](07-knowledge-base.md) §8).

The one isolation regression in this plan is the pgvector move (§6). It is
deliberate, and it is the reason RLS is a requirement rather than a nicety.

---

## 11. Backups and disaster recovery

| Layer | Backup | RPO | RTO | If lost entirely |
|---|---|---|---|---|
| PostgreSQL | Automated daily + PITR, 7–14 day retention | **≈5 min** | 30–60 min | **Catastrophic.** Accounts, chunks, conversations gone. The one layer that must never be lost |
| Object storage | Versioning + 11-nines durability | **0** | 0 | Originals gone; chunks survive, so chat still works but re-processing is impossible |
| Vector index | **None required** | n/a | Minutes–hours | **Fully rebuildable** — `scripts/reindex.ts` re-embeds from `document_chunks`. Costs a re-embedding bill, not data |
| API | None (stateless) | 0 | ~5 min | Redeploy |
| Worker | None (stateless) | 0 | ~5 min | Redeploy; leases expire and jobs are reclaimed by the reaper |

**Is the vector rebuild actually possible with the current implementation? Yes
— verified.** Chunk text lives in `document_chunks.content`, ids are
deterministic, upsert semantics make retries safe, and the operational script
already exists. Under the pgvector recommendation this layer stops needing an
independent backup at all, because it is inside the database that already has
PITR.

**Restore drill: run one before launch and once per quarter.** An untested
backup is a hypothesis.

---

## 12. Monitoring

Minimum viable, deliberately small: uptime check on `/health` · ALB 5xx rate
and p95 latency · database CPU, connections, free storage, replication lag ·
**failed job count** (the clearest ingestion signal) · document processing
failure rate by `error_code` · Gemini failure and 503 rate — *observed three
times across two sessions, so alert on it* · vector query failure rate · S3
4xx/5xx · authentication failure and lockout rate (credential-stuffing signal)
· task CPU/memory, especially worker memory against the 25 MB parse ceiling.

Logs: pino JSON to CloudWatch, already carrying request ids. Error tracking
(Sentry) is worth its small cost. Skip tracing until there is a latency
question the logs cannot answer.

---

## 13. Cost

Ranges, not estimates. Small deployment: tens of users, hundreds of documents.

**Fixed infrastructure**

| Item | Monthly |
|---|---|
| ALB | $16–20 |
| API task (0.5 vCPU / 1 GB) | $10–15 |
| Worker task (0.5 vCPU / 2 GB) | $12–18 |
| RDS db.t4g.micro + 20 GB gp3 | $15–25 |
| S3 (few GB) + CloudFront | $1–5 |
| Secrets, CloudWatch | $2–5 |
| **Subtotal** | **≈ $56–88** |

Dropping the ALB (App Runner) or moving to Render/Fly + Neon + R2 brings the
floor to roughly **$79–110/yr–$25/mo territory**; the ALB is the single largest
fixed line item and buys little at one instance.

**Usage-based**

| Item | Driver |
|---|---|
| Gemini embeddings | One-off per document; a 50-page PDF ≈ 150 chunks. Cents per document |
| Gemini chat | Per turn, dominated by retrieved context. Low single-digit dollars/month at tens of users |
| S3 storage / egress | ~$0.023/GB-month; egress free to same-region API |
| Vector | **$0 under pgvector**; $25+/mo for a managed alternative |

**Realistic total: $60–120/month**, of which fixed infrastructure dominates at
low usage. Gemini only overtakes it under heavy chat. Pricing changes — verify
before committing.

---

## 14. Environments

| | Development | Staging | Production |
|---|---|---|---|
| Database | Docker `lumora-pg` | Separate instance/branch | **Own instance** |
| Objects | Local disk | Own bucket | **Own bucket** |
| Vectors | Docker Chroma | Own store/schema | **Own store** |
| Secrets | Local `.env` | Own set | **Own set** |
| Gemini key | Shared dev key | Dev key | **Separate key** |

**Production shares nothing.** Not a bucket, not a database, not a collection
prefix, not a secret. `CHROMA_COLLECTION_PREFIX` exists for exactly this reason
but is not sufficient on its own — separate infrastructure is.

Staging is optional for a first launch; if it is skipped, say so deliberately
rather than discovering it during an incident.

---

## 15. Migration

### 15.1 Recommended: start production with a clean database

**This decision must not be made silently, so it is stated plainly.**

The local database holds **6 users, all synthetic** — `mobileux+…@example.test`,
`doc-…@example.com`, and similar fixtures — plus 17 conversations and 2
documents from testing. There is **no real user data to preserve.**

Migrating it would put test accounts with known-weak passwords into production,
carry fixture rows into `usage_events` and `jobs`, and import an 89-row
`refresh_tokens` table of dead sessions. Start clean: run migrations against
the empty production database, register the first real account through the
normal signup flow.

The procedure below is documented for the case where real data exists later —
a staging promotion, or a second production region.

### 15.2 Procedure (not to be run now)

1. **Freeze writes** — scale API to zero or enable maintenance mode.
2. **Export** — `pg_dump -Fc`; verify the file restores locally before trusting it.
3. **Provision** — RDS instance, private subnet, TLS enforced, backups on.
4. **Import** — `pg_restore`; run `migrate:status` and confirm all applied.
5. **Upload originals** — sync `backend/uploads/` to `s3://…/users/{userId}/documents/{documentId}/original`.
6. **Reconcile references** — confirm every `documents.storage_key` resolves to an existing object; **count both sides and require equality**.
7. **Rebuild vectors** — `npm run reindex`. Mandatory when moving to pgvector; the index is derived and is not migrated.
8. **Verify counts** — per table, source vs destination. Any mismatch stops the cutover.
9. **Verify auth** — log in as a known account; confirm refresh rotation and reuse detection.
10. **Verify retrieval** — a known question returns the expected chunk with the correct citation.
11. **Verify citations** — resolve to the right document and page.
12. **Smoke test** — the full register → upload → ingest → chat → cite path against production.
13. **Cut over** — DNS to the production ALB.
14. **Rollback** — keep the old stack running and untouched for 48 hours; rollback is a DNS revert. Do not delete source data until production has taken real writes and been backed up.

---

## 16. Knowledge Base compatibility

The target architecture supports [07-knowledge-base.md](07-knowledge-base.md)
with **no change to this plan.** Knowledge Base adds two PostgreSQL tables and
one nullable column, and its retrieval scope is a `documentIds` filter the
pipeline already accepts. It introduces no new storage layer, no new service,
and no new secret. Under the pgvector recommendation the KB filter becomes a
second predicate in the same query — if anything, simpler than under Chroma.

---

## 17. Architecture diagram

```
                          ┌───────────────────────────────┐
                          │  Browser (untrusted)          │
                          │  VITE_API_URL only — no keys  │
                          └───────────────┬───────────────┘
                                     HTTPS │
        ══════════════════ TRUST BOUNDARY ═══════════════════
                                          │
        ┌─────────────────────────────────┼──────────────────────────┐
        │ Public edge                     │                          │
        │  CDN ── static bundle           ▼                          │
        │                        ALB (TLS terminate)                 │
        └─────────────────────────────────┬──────────────────────────┘
                                          │
        ══════════════ TRUST BOUNDARY (private subnet) ═══════════════
                                          │
        ┌─────────────────────────────────▼──────────────────────────┐
        │  API task  (1 instance — R7)        Worker task (separate) │
        │  SECRETS in env from secrets manager                       │
        └───┬───────────────┬──────────────┬──────────────┬──────────┘
            │               │              │              │
            ▼               ▼              ▼              ▼
   ┌────────────────┐ ┌───────────┐ ┌────────────┐ ┌─────────────┐
   │  PostgreSQL    │ │    S3     │ │  Vectors   │ │   Gemini    │
   │                │ │           │ │            │ │  (external) │
   │ AUTH DATA      │ │ ORIGINAL  │ │ EMBEDDINGS │ │             │
   │  email         │ │  FILES    │ │            │ │ egress only │
   │  password_hash │ │           │ │ DERIVED —  │ │ no user data│
   │  token hashes  │ │ private,  │ │ rebuildable│ │ at rest     │
   │ DOCUMENT DATA  │ │ versioned │ │ via        │ └─────────────┘
   │ CHUNK TEXT     │ │ presigned │ │ reindex.ts │
   │ CONVERSATIONS  │ │ GET only  │ │            │
   │ CITATIONS      │ └───────────┘ │ ▲ pgvector │
   │ JOBS · USAGE   │               │ │ = same DB │
   │ AUTHORITATIVE  │◀──────────────┴─┘           │
   └────────────────┘                             │
            ▲                                     │
            └──── SECRETS MANAGER ────────────────┘
                  (no secret in image or bundle)
```

---

## 18. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| **O-1** | AWS-native, or Render/Fly + Neon + R2? | Either is defensible. AWS if you want one vendor; the alternative is ~half the cost and materially less setup |
| **O-2** | Implement `pgvector` before launch, or ship self-hosted Chroma? | **Implement pgvector** — it removes a stateful service and a backup story. If it slips, Chroma on EBS is the fallback |
| O-3 | Staging environment at launch? | Skip only as an explicit choice |
| O-4 | Presigned GET, or stream through the API? | Presigned, on a single-instance API |
| O-5 | Custom domain and email deliverability (SPF/DKIM/DMARC)? | Required before real signups; Gmail SMTP will not survive volume |
| O-6 | Retention for `refresh_tokens`? | Add a reaper — 89 rows against 6 users locally shows it grows unbounded |

## 19. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **R7 single-node** | Rate limits multiply; stop-generation breaks at N>1 | One instance; scale vertically; shared store before scaling out |
| **No S3 driver exists** | Real implementation work, not configuration | `StorageProvider` + factory already anticipate `'s3'`; the compile error is the guardrail |
| **pgvector isolation regression** | Structural → enforced | Repository-layer filter **and** RLS |
| **No CI** | Deploying unverified code | **Build CI before the first deploy** — the checks already exist |
| Untested restore | Backups may not work | Drill before launch |
| Gemini 503s | Failed turns | Observed 3× in two sessions; add provider retry (already flagged) |
| Cost drift | Surprise bill | Budget alarm from day one |

## 20. Recommended implementation order

1. **CI** — lint/typecheck/test on every push. Before any deploy.
2. **S3 storage driver** — implement `'s3'`, keep `local` for development.
3. **pgvector store** — implement the stub; verify recall parity against Chroma.
4. Provision infrastructure (IaC preferred, but by hand is acceptable for one environment if documented).
5. Secrets manager; remove every secret from local production config.
6. Deploy API + worker as separate services; confirm `WORKER_ENABLED=false` on the API.
7. Frontend to CDN; wire the custom domain and TLS.
8. Backups on; **run a restore drill**.
9. Monitoring and alerts.
10. Production smoke test: register → upload → ingest → chat → cite → delete.
11. Cut over.

---

## 21. Direct answers

| Question | Answer |
|---|---|
| Where is a real user's **email** stored? | PostgreSQL, `users.email` (citext, unique) |
| Where is the **password** stored? | **Nowhere. Never stored in any form.** |
| Where is the **password hash** stored? | PostgreSQL, `users.password_hash` — argon2id `m=19456,t=2,p=1` |
| Where is the **uploaded PDF** stored? | S3, private: `users/{userId}/documents/{documentId}/original` |
| Where is **chunk text** stored? | PostgreSQL, `document_chunks.content` |
| Where are **embeddings** stored? | The vector store — recommended: `pgvector` in the same PostgreSQL. **Derived** |
| Where are **conversations/messages** stored? | PostgreSQL, `conversations` and `messages` |
| Where are **citations** stored? | PostgreSQL, `message_citations`, incl. `content_snapshot` |
| Where are **secrets** stored? | Secrets manager, injected at task start. Never in an image, a bundle, or a repo |
| **Backend server deleted?** | No data loss — it is stateless. Redeploy, ~5 min. In-flight streams drop; leased jobs are reclaimed by the reaper |
| **Vector database deleted?** | No permanent loss. Chunks and originals survive; `npm run reindex` rebuilds. Costs re-embedding and minutes. Chat degrades to lexical-only meanwhile |
| **PostgreSQL deleted?** | **Catastrophic** — accounts, chunk text, conversations, and citations are all there. Recoverable only from backup: PITR to ≈5 min before the loss, 30–60 min to restore. This is the layer that must never be lost |
