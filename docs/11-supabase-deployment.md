# 11 — Supabase Deployment

**Status: the application supports this architecture and is verified locally.
Nothing is deployed.** Creating the Supabase project, the Koyeb service, and
the Cloudflare Pages site requires account access that only the repository
owner has. §9 lists exactly what remains.

This supersedes [08](08-production-architecture.md) as the **primary**
deployment target. AWS is retained as a documented alternative, not deleted —
`infra/terraform` and the S3-on-AWS path both still work.

---

## 1. Why Supabase rather than AWS

AWS is cheap only while credits or the twelve-month free tier last, and then it
is not. Supabase's free tier has no clock on it. The pivot cost almost nothing
because of two earlier decisions:

- **pgvector, not a proprietary vector database.** Supabase *is* Postgres with pgvector, so `PgVectorStore`, migration `0008`, the HNSW index, tenant isolation, and Knowledge Base scoping transfer **unchanged**. Had the vector store been Chroma Cloud or Pinecone, this would have been a rewrite.
- **Supabase Storage speaks the S3 protocol.** The existing `S3StorageProvider` drives it with configuration only — no second storage implementation, no duplicated logic.

The entire migration is therefore **configuration plus two relaxed validation
rules**, not a port.

---

## 2. Architecture

```
Browser
   │ HTTPS
   ▼
Cloudflare Pages ─── static bundle, SPA fallback via public/_redirects
   │ VITE_API_URL (public, compiled into the bundle)
   ▼
Koyeb ── one service: Express API + ingestion worker in one process
   │
   ├──▶ Supabase PostgreSQL   users · tokens · documents · chunks ·
   │                          conversations · messages · citations ·
   │                          knowledge bases · memberships · jobs · usage
   ├──▶ Supabase pgvector     document_vectors (derived, rebuildable)
   ├──▶ Supabase Storage      original uploads, private, S3 protocol
   └──▶ Gemini                gemini-embedding-001 · gemini-3.5-flash
```

**API and worker share one process** (`WORKER_ENABLED=true`, the existing
default). docs/09 §6 recommends separating them and still does for a paid
deployment — but Koyeb's free tier **cannot run Worker Services at all**, and
running both in one process needs no code change because that is how local
development already works.

**Supabase Auth is not used.** Lumora has its own argon2id + refresh-rotation
implementation; adopting Supabase Auth would mean rewriting working, tested
security for no gain. Supabase is used as Postgres and object storage only.

---

## 3. Supabase setup

1. Create a project at [supabase.com](https://supabase.com) — free, no card.
2. **Database → Extensions →** enable `vector`. (Migration `0008` also runs `CREATE EXTENSION IF NOT EXISTS vector`, so this is belt and braces.)
3. **Storage → New bucket →** name `documents`, **Public: OFF**.
4. **Storage → S3 Configuration →** create access keys. These are Supabase's own keys and have nothing to do with AWS.
5. **Settings → Database →** copy the connection string.

### Connection string

Use the **pooler** (Supavisor), not the direct connection:

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

Direct connections are IPv6-only on the free plan and many hosts — Koyeb
included — cannot reach them. `sslmode=require` is not optional: the pool
passes the URL straight to `pg`, so **TLS is configured by the URL, not by
code**.

### Migrations

```bash
DATABASE_URL='<pooler url>' npm run migrate
DATABASE_URL='<pooler url>' npm run migrate:status
```

All eight migrations apply unchanged. `0008` creates `document_vectors` with a
`vector(768)` column and an HNSW index.

---

## 4. Environment variables

**Names only. No value appears in this repository.**

| Variable | Value shape | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables every fail-closed rule below |
| `DATABASE_URL` | pooler URL + `sslmode=require` | Supabase Postgres |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` | **Generate fresh — never reuse the development one** |
| `GEMINI_API_KEY` | `AIza…` | Server-side only |
| `LLM_PROVIDER` / `EMBEDDING_PROVIDER` | `gemini` | `fake` is refused in production |
| `EMBEDDING_DIMENSIONS` | `768` | Must match `vector(768)` in migration 0008 |
| `VECTOR_STORE` | `pgvector` | `fake` is refused |
| `STORAGE_DRIVER` | `s3` | `local` is refused in production |
| `S3_ENDPOINT` | `https://<ref>.storage.supabase.co/storage/v1/s3` | Only Supabase hosts are accepted |
| `S3_BUCKET` | `documents` | |
| `S3_REGION` | `us-east-1` | Supabase ignores it; the SDK requires one |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from Storage → S3 Configuration | Required when the endpoint is Supabase |
| `S3_FORCE_PATH_STYLE` | `true` | Supabase requires path-style |
| `S3_SERVER_SIDE_ENCRYPTION` | `none` | Supabase encrypts at rest itself and **rejects** the header |
| `MAIL_DRIVER` + `SMTP_*` | | `console` is refused in production |
| `APP_URL` / `CORS_ORIGINS` | `https://<pages-domain>` | Localhost is refused |
| `WORKER_CONCURRENCY` | `1` | 512 MB — see §7 |
| `CHROMA_URL` | any non-localhost `https://` URL | Vestigial; still validated. Set to `https://unused.invalid` |
| **Frontend** `VITE_API_URL` | `https://<koyeb-domain>` | **Public** — compiled into a world-readable bundle |

### What production refuses to boot with

Verified by twelve tests in `env-production.test.ts`: `fake` LLM / embeddings /
vector store · `local` storage · a **non-Supabase** `S3_ENDPOINT` · Supabase
endpoint with no access keys · `S3_SERVER_SIDE_ENCRYPTION=none` when the
endpoint is *not* Supabase · localhost `APP_URL` / `DATABASE_URL` /
`CORS_ORIGINS` · the `console` mail driver · placeholder-looking secrets.

---

## 5. Deploying the backend to Koyeb

Koyeb builds from the repository `Dockerfile` — the same image docs/09 §5
describes, already built and run in production mode.

1. **Create Service → GitHub →** this repository, branch `main`.
2. **Builder: Dockerfile**, path `./Dockerfile`.
3. **Instance: Free** (512 MB, 0.1 vCPU). Region Frankfurt or Washington.
4. **Port 4000**, health check path `/health`.
5. Add every variable from §4 as a **Secret** (not a plain env var) for anything sensitive.
6. Deploy.

`HOST=0.0.0.0` is already baked into the image — the 127.0.0.1 default
publishes to nothing inside a container.

**Scale-to-zero after 1 hour idle is not disableable on the free instance.**
Lumora tolerates this better than most apps: jobs carry leases and the reaper
reclaims anything a sleeping worker dropped, so an interrupted ingestion
resumes rather than being lost. The visible cost is latency — a document
uploaded just before sleep finishes when the service next wakes.

---

## 6. Deploying the frontend to Cloudflare Pages

1. **Workers & Pages → Create → Pages → Connect to Git.**
2. Build command `npm run build --workspace @lumora/frontend`, output `frontend/dist`.
3. Environment variable `VITE_API_URL` = the Koyeb URL.
4. Deploy.

`public/_redirects` gives the SPA fallback — without it every deep link and
every refresh on `/app/chat/<id>` returns 404. `public/_headers` sets
immutable caching on hashed assets, no-cache on `index.html`, and three
security headers. Both are copied into `dist` by the build.

---

## 7. Free-tier limits — actual, verified from official sources

| Resource | Free limit | What happens at the limit |
|---|---|---|
| Supabase database | **500 MB** | Writes fail. ~10 KB per chunk all-in → roughly **1,500 documents** |
| Supabase storage | **1 GB** | Uploads fail. **The binding constraint in practice** |
| Supabase egress | **5 GB/mo** | Throttling; answers are text so this is not close |
| Supabase pause | **7 days idle** | Project stops; **manual resume required**. Mitigated by `.github/workflows/keepalive.yml` |
| Supabase projects | 2 active | Production + staging exactly fits |
| Koyeb | **512 MB, 0.1 vCPU, one web service** | No Worker Services on free; scale-to-zero after 1 h idle, not disableable |
| Cloudflare Pages | 500 builds/mo, unlimited bandwidth | Builds queue |
| **Gemini free tier** | **20 chat requests/day/model** | 429 `RESOURCE_EXHAUSTED`. **Hit repeatedly during development** — the single most limiting quota for a demo |

Supabase's own docs warn that **HNSW with a filter can return fewer rows than
requested** — which is exactly the Knowledge Base scoping path. The existing
scope tests would catch it; if it appears, the fix is a scoped over-fetch in
`PgVectorStore` only. **Not yet observed against real Supabase.**

---

## 8. Backups and recovery

**The free plan has no point-in-time recovery and no automated backup
guarantee suitable for production.** Do not claim otherwise. PITR is a paid
add-on; daily backups begin on Pro.

| Layer | Free-plan reality | Recovery |
|---|---|---|
| PostgreSQL | No PITR; take your own `pg_dump` | **Manual.** RPO = time since your last dump |
| Storage originals | No versioning on free | None if deleted — **treat as irreplaceable** |
| Vector index | n/a | **Rebuildable** — `npm run reindex --user <email>` |

The invariant, stated accurately:

> **PostgreSQL + object storage = authoritative. Vectors are derived.**
> `reindex` re-enqueues `INGEST_DOCUMENT`, so the worker re-reads the
> **original from storage** — chunks alone are not sufficient. This was
> verified locally by deleting the entire `document_vectors` table and
> rebuilding it from object storage; retrieval and citations returned.

For anything resembling real production, schedule a `pg_dump` to storage you
control, or move to Pro for PITR.

---

## 9. Cost

| Users | Supabase | Backend | Frontend | Gemini | Total |
|---|---|---|---|---|---|
| 0 | $0 | $0 | $0 | $0 | **$0** |
| 10 | $0 | $0 | $0 | ~$1 | **~$1** |
| 100 | $0 (storage near the 1 GB cap) | $0 | $0 | $5–15 | **$5–15** |
| 1,000 | Pro $25 + overage | $3–10 | $0 | $50–150 | **$80–190** |

Domain excluded — both platforms provide a working subdomain. Free tier
realistically carries to **~100 users**; storage binds before the database.

---

## 10. Rollback

Configuration only, because nothing is provider-specific:

- **Backend** — Koyeb redeploys the previous image; roll back in the dashboard.
- **Frontend** — Cloudflare Pages keeps every deployment; promote a previous one.
- **Off Supabase entirely** — point `DATABASE_URL` and the `S3_*` variables back at Docker/MinIO. No code changes.
- **To AWS** — `infra/terraform` is retained and unmodified; set `S3_ENDPOINT` unset and `S3_SERVER_SIDE_ENCRYPTION=AES256`.

Database rollback is the asymmetric one: an expand migration is safe to leave,
a contract migration has already destroyed data and needs a restore.

---

## 11. Local development is unchanged

Docker Postgres (`pgvector/pgvector:pg17`), Docker Chroma, local filesystem
storage, fake providers in tests. **Nothing local depends on Supabase.**
`docker compose up` plus `npm run dev` works exactly as before.
