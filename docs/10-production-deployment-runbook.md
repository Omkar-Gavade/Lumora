# 10 — Production Deployment Runbook

**Status: the application is production-capable; no production exists.**

This document describes what is **actually implemented and verified**, and
says plainly where the line is. Nothing has been deployed. No AWS resource has
been created — the credentials on the development machine were invalid
(`InvalidClientTokenId`), so every cloud step below is written but unexecuted.

Companion documents: [08](08-production-architecture.md) decides where data
lives, [09](09-devops-cicd-deployment.md) decides how code gets there.

---

## 1. What changed, and what it means

| Capability | Before | Now |
|---|---|---|
| Original documents | Local disk only | **S3 driver**, verified against a live S3 API |
| Vector index | Chroma only | **pgvector**, verified against real pgvector |
| Production config | Rejected fake providers and localhost URLs | Also rejects **local storage**, a **custom S3 endpoint**, and **disabled encryption** |
| Container | None | **Backend image**, built and run in production mode |
| CI | None | **GitHub Actions**, six jobs, needs no production secret |
| IaC | None | **Terraform** for S3 and RDS — written, never applied |

### The invariant, stated accurately

docs/08 §2 claimed Postgres alone could rebuild the vector index. **That is not
true of the shipped implementation**, and the difference matters for recovery
planning:

```
reindex → re-enqueues INGEST_DOCUMENT → worker reads the ORIGINAL from storage
        → extract → chunk → embed → vector store
```

So the real invariant is:

> **Postgres (chunks, metadata) + object storage (originals) → vectors are
> rebuildable. Postgres alone is not sufficient.**

This makes the bucket load-bearing for recovery, which is why versioning is
enabled on it in Terraform rather than treated as optional. Verified end to
end: the entire `document_vectors` table was deleted, `reindex --user` was run,
the worker re-ingested from object storage, and retrieval returned evidence and
citations again.

---

## 2. Environment variables

**Names only. No values appear in this repository or in any document.**

| Variable | Where it comes from | Notes |
|---|---|---|
| `DATABASE_URL` | Secrets Manager | Must carry `sslmode=require`; TLS is configured by the URL, not by code |
| `JWT_ACCESS_SECRET` | Secrets Manager | ≥32 chars; production rejects placeholder-looking values |
| `GEMINI_API_KEY` | Secrets Manager | API and worker both need it |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` | Secrets Manager | `MAIL_DRIVER=console` is refused in production |
| `STORAGE_DRIVER` | Task definition | Must be `s3`; `local` is refused in production |
| `S3_BUCKET` / `S3_REGION` | Task definition | Required whenever the driver is `s3`, in every environment |
| `S3_SERVER_SIDE_ENCRYPTION` | Task definition | Defaults to `AES256`; `none` is refused in production |
| `S3_ENDPOINT` | **unset in production** | Refused — it exists for S3-compatible test servers |
| `VECTOR_STORE` | Task definition | `pgvector` in production; `fake` is refused |
| `EMBEDDING_PROVIDER` / `LLM_PROVIDER` | Task definition | `gemini`; `fake` is refused |
| `APP_URL` / `CORS_ORIGINS` | Task definition | Localhost is refused in production |
| `WORKER_ENABLED` | Task definition | `false` on the API task, default on the worker task |
| `VITE_API_URL` | Frontend build arg | **Public** — compiled into a world-readable bundle |

**No AWS credentials are configured for the application.** The SDK's default
provider chain resolves them, which in production means an ECS task role.

---

## 3. Object key structure

The application's existing scheme, unchanged:

```
{userId}/{documentId}.{ext}
```

docs/08 §5.1 proposed `users/{userId}/documents/{documentId}/original`. The
shipped keys do not use that shape, and rewriting them was rejected: the key
is stored in `documents.storage_key`, so changing the template means migrating
every existing row and every existing object for a cosmetic gain. Both shapes
are user-prefixed, which is the property an IAM condition needs.

`assertSafeKey` rejects empty keys, leading slashes, `..`, null bytes, and
backslashes before any request is made — verified by six negative tests.

---

## 4. Deployment sequence

Nothing below has been executed.

1. **Provision** — `terraform apply` in `infra/terraform/environments/production` (S3 + RDS only; networking, ECS, ALB, CloudFront and ECR are not yet modelled).
2. **Secrets** — populate Secrets Manager. Never through Terraform variables: they land in state.
3. **Build and push** — one image, tagged with the git SHA. Never `latest`.
4. **Migrate** — a one-off task from that same image (`npm run migrate`). Migrations ship inside it via `copy-assets.mjs`. **Run once, not per replica.**
5. **Deploy the API** — `WORKER_ENABLED=false`, one instance (see §6).
6. **Deploy the worker** — same image, `node backend/dist/worker.js`.
7. **Smoke test** — register → upload → ingest → chat → cite → delete.
8. **Frontend** — build with `VITE_API_URL`, sync to the bucket, invalidate the CDN.

### Rollback

Redeploy the previous SHA — images are immutable and the application is
stateless, so this is a complete revert in about five minutes. **Database
rollback is not symmetric**: an expand migration is safe to leave in place, and
a contract migration has already destroyed data, so reverting it needs PITR and
discards every write since. Contract steps ship alone, a release after the code
that stopped using the column.

---

## 5. Recovery

| Layer | RPO | RTO | Mechanism | Verified? |
|---|---|---|---|---|
| PostgreSQL | ~5 min | 30–60 min | RDS PITR + daily snapshot, 14-day retention | **No — no RDS exists** |
| S3 originals | 0 | 0 | Versioning, 90-day noncurrent retention | **No — no bucket exists** |
| Vector index | n/a | minutes | `reindex --user` / `--all`, re-ingests from storage | **Yes — full index deleted and rebuilt, retrieval restored** |
| API / worker | 0 | ~5 min | Redeploy a known tag | Image start/stop verified locally |

The RPO/RTO figures for Postgres and S3 are **AWS's published characteristics,
not measurements**. A restore drill has not been run because there is nothing to
restore from.

---

## 6. Known production limits

**The API must run as exactly one instance.** Two process-local pieces of state
make a second replica incorrect, and neither was changed:

- **Rate limiting** is a per-process `Map`. N replicas multiply every limit by N — a silent weakening of an auth control.
- **The abort registry** is a per-process `Map`. Stop-generation only works if the request lands on the instance holding the stream.

The `RateLimitStore` interface already exists, so the first is a
Postgres-backed implementation rather than a redesign, and needs no Redis. The
worker has no such constraint: `FOR UPDATE SKIP LOCKED` makes concurrent
claiming correct, and multiple worker tasks are safe today.

**Do not run two workers with different `STORAGE_DRIVER` settings against one
database.** Both poll the same `jobs` table, and a worker configured for local
disk will claim a job whose object is in S3 and fail it three times. This was
hit twice during verification; it is a configuration hazard, not a bug.

---

## 7. Cost

Approximate, monthly, unverified against a real bill.

| | Development | Staging | Production |
|---|---|---|---|
| Compute (API + worker) | $0 | $12–20 | $22–33 |
| ALB | — | $16–20 | $16–20 |
| RDS | $0 (Docker) | $15–25 | $15–25 |
| S3 + CloudFront | $0 (MinIO) | $1–3 | $1–5 |
| ECR / logs / secrets | — | $3–6 | $5–13 |
| **Fixed subtotal** | **$0** | **$47–74** | **$59–96** |
| Gemini | Free tier | Free tier | Usage-based |

The ALB is the largest single fixed line and buys little at one instance.
Dropping it (App Runner) or moving to Render/Fly + Neon + R2 roughly halves the
total. **Gemini's free tier is 20 chat requests/day per model** — that limit was
hit during this work and is a real constraint on any demo.

---

## 8. What is NOT done

- No cloud resource of any kind exists.
- Terraform covers S3 and RDS only, and has **not been validated** — the CLI is not installed on the development machine.
- No VPC, ECS, ALB, CloudFront, ECR, IAM, or Secrets Manager configuration.
- SES is not integrated; the SMTP driver is what production would use today.
- No CD workflow — CI builds and validates the image but does not push or deploy.
- No monitoring, alerting, or log aggregation beyond structured stdout.
- No restore drill.
- The frontend has no production hosting.
