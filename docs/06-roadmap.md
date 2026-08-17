# 06 — Milestones, Standards, Risks, Roadmap

## 1. Development milestones

Ordered by dependency and by risk. Each milestone has an exit criterion that is demonstrable, not a checkbox. Estimates assume one engineer working focused days.

### M0 — Foundation (2–3 days)
Workspace setup (`frontend/`, `backend/`, `shared/`), TypeScript strict configs, ESLint + Prettier + import-boundary rules, Tailwind with the full token set from §01, Postgres running with the migration runner, `env.ts` validation on both sides, pino logger, the `AppError` hierarchy, the error handler, and a `/health` endpoint the frontend calls to prove the two halves talk.

**Exit:** `npm run dev` starts both; the homepage fetches `/health` successfully; a deliberately invalid env var kills the server at boot with a readable message.

**Why first:** every convention established here is copied hundreds of times. Fixing lint rules and folder boundaries in week 4 means touching every file.

### M1 — Design system (3–4 days)
All Tier 1 primitives with every variant and all five interaction states, `cn()`, `cva` variants, theme provider with the pre-paint bootstrap script, the four layouts, and a `/dev/components` gallery route (development-only) rendering every primitive in every state in both themes.

**Exit:** the gallery renders completely; keyboard traversal works throughout; `jest-axe` passes on every primitive; contrast assertions pass in both themes.

**Why before features:** building primitives while building a feature produces primitives shaped by one caller. The gallery is also the fastest way to catch dark-theme and focus-state gaps, which are otherwise found weeks later, one screen at a time.

### M2 — Authentication end to end (4–5 days)
Backend: users and tokens schema, argon2id, token service with rotation and reuse detection, all auth endpoints, verification and reset flows, mail provider (console driver in development), rate limiting, `authenticate` and `require-verified` middleware.
Frontend: all five auth screens, forms with shared Zod schemas, `AuthProvider`, the three route guards, the single-flight refresh interceptor.

**Exit:** signup → verify → login → refresh → logout works end to end; a manually replayed refresh token revokes the family; login timing is indistinguishable between an existing and a non-existing account; auth rate limits fire.

**Why this early:** every subsequent endpoint depends on `req.actor`. Retrofitting auth means revisiting every route and every query.

### M3 — Documents and ingestion (5–6 days)
Documents and chunks schema, jobs table with `SKIP LOCKED` claiming, the worker, storage provider, parsers for all four formats, the structure-aware chunker, embedding service, the `VectorStore` interface with the Chroma implementation, upload/list/delete/retry endpoints, the status SSE stream, quotas.
Frontend: documents page, dropzone, live status rows, delete confirmation, quota meter, all empty and error states.

**Exit:** a 50-page PDF ingests to `ready` with sensible chunk boundaries verified by eye; killing the server mid-ingestion and restarting resumes without duplicate chunks; deleting a document removes its vectors; a scanned PDF fails with the specific `NO_TEXT_LAYER` message.

**Chunk quality is inspected manually here, not assumed.** Everything downstream inherits it.

### M4 — Retrieval (3–4 days)
Query rewriting, semantic search, BM25 over `content_tsv`, RRF fusion, the relevance floor, per-document diversity caps, context builder with token budgeting, and a development-only endpoint that returns retrieval results without generation.

**Exit:** on a hand-built evaluation set of ~30 questions over ~10 real documents, the correct chunk appears in the top 5 for the large majority; an off-corpus question returns nothing above the floor; a question containing an exact identifier that embeddings miss is found by the lexical half.

**The retrieval-only endpoint is the most valuable debugging tool in the project.** Without it, "the answer is wrong" is unattributable between retrieval and generation.

### M5 — Chat (6–8 days) — the largest and highest-risk milestone
Backend: conversations and messages schema, the provider abstraction with both adapters, prompt assembly, the streaming orchestrator including abort and partial persistence, citation validation, titling, memory and summarization, all conversation and message endpoints.
Frontend: chat layout, sidebar with grouped history, message thread, streaming markdown renderer with the incomplete-block guard, code blocks with highlighting and copy, citation chips, source panel, composer with draft persistence, message actions, stop generation, autoscroll with detach, the Zustand streaming store, and every empty/loading/error/stopped state.

**Exit:** streamed answers render cleanly with no mid-stream markdown flicker; stop preserves partial text across a reload; a killed provider produces an inline error with a working retry; citations open the correct chunk; the whole surface is operable by keyboard; a screen reader announces answers coherently.

**Suggested sequencing inside M5:** non-streaming turn first (prove retrieval → prompt → answer → persistence), then streaming, then citations, then message actions, then polish. Attempting streaming and citations simultaneously makes every bug ambiguous.

### M6 — Homepage (3–4 days)
All sections from §00/8.1, the product screenshot, scroll reveals honoring reduced-motion, responsive passes at 320/768/1024/1440, FAQ accordion, footer, legal pages, meta tags and Open Graph.

**Exit:** LCP under budget on throttled Fast 3G; marketing bundle under 120KB gzipped; Lighthouse ≥95 on performance and 100 on accessibility; no layout shift.

**Deliberately late.** The homepage's strongest asset is a real screenshot of a real product. Building it first means designing marketing around an imagined interface, then rebuilding it.

### M7 — Settings, polish, hardening (3–4 days)
Settings sections, change password, delete account, theme, command palette, all keyboard shortcuts, error boundaries at all three levels, the full accessibility pass, the responsive pass, loading and empty state audit across every screen, security headers, and a dependency audit.

**Exit:** every screen has a designed empty, loading, and error state; keyboard-only operation of every flow; no console errors or warnings.

### M8 — Documentation and demo (2 days)
README with architecture diagrams and setup, seed data, a scripted demo path, an architecture decision record capturing the choices in these documents.

**Total: ~31–40 focused days.**

---

## 2. Feature priorities

**P0 — Phase 1 ships without any of these missing:** email auth with verification and reset · document upload for four formats with honest live status · hybrid retrieval with abstention · streamed grounded chat with clickable citations · conversation history · stop generation · markdown and code rendering · light/dark theme · responsive to 320px · WCAG AA · the homepage.

**P1 — next:** collections and per-conversation scoping (**specified** as Knowledge Base in [07-knowledge-base.md](07-knowledge-base.md) — planning complete, implementation not started) · message feedback · conversation export · reranking · active session management · usage dashboard · document rename and re-index · Playwright E2E · virtualized history for very long threads.

**P2 — later, and only if justified by real use:** shared conversations · workspaces and teams · OAuth and 2FA · OCR · more file types and URL ingestion · a public API with keys · multi-model selection · an answer-quality evaluation harness in CI.

**Explicitly out of scope, with reasons:** real-time collaborative editing (wrong product), agentic tool use (an unbounded scope that dilutes the RAG story), mobile native apps (the responsive web app is sufficient), a self-hosted local model (an infrastructure project wearing an application costume), and billing (an entirely separate domain that adds no engineering signal here).

---

## 3. Coding standards

### TypeScript
`strict: true`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`. **No `any` in committed code** — `unknown` plus narrowing instead; the one legitimate `any` is at an untyped third-party boundary, and it is isolated in an adapter and commented. No non-null assertions except immediately after a proven check. Type inference preferred over annotation except at exported boundaries, where explicit signatures are documentation. Discriminated unions over optional-field soup — `{ status: 'loading' } | { status: 'error', error: E } | { status: 'ready', data: D }` makes the impossible state unrepresentable, where three optional fields make it inevitable. Branded types for IDs (`UserId`, `DocumentId`) so a document id cannot be passed where a user id is expected.

### Principles, applied concretely rather than cited
- **SOLID** — single responsibility means a service does one domain's work, so `ChatService` does not parse PDFs. Dependency inversion means services depend on `LLMProvider`, never on `gemini.provider.ts`; that one rule is what makes provider swapping trivial and the services testable. Interface segregation means `VectorStore` has four methods, not a kitchen sink.
- **DRY, with a limit** — extract on the third occurrence, not the second. Two similar-looking things that change for different reasons are not duplication, and merging them creates a shared abstraction with two masters. Premature DRY causes more damage in practice than a little repetition.
- **KISS** — the simplest thing that satisfies the requirement. Every abstraction must name the concrete change it makes cheaper.
- **YAGNI** — this is why there is no Redis, no LangChain, no microservices, no GraphQL, and no plugin system. Each was considered and each fails the question "what does this buy today."
- **Composition over inheritance** — no class hierarchies beyond the `AppError` tree, which is genuinely an is-a relationship.

### Naming
Booleans read as assertions (`isLoading`, `hasDocuments`, `canRegenerate`). Functions are verb phrases; handlers are `handleX`; hook returns are `onX`. Async functions returning a value are `getX`/`fetchX`; those causing an effect are `createX`/`updateX`/`deleteX`. No abbreviations except the universally understood ones — `id`, `url`, `api`. Nothing named `data`, `info`, `manager`, `helper`, or `utils` at module scope; if a module can only be named `helpers.ts`, it has no coherent responsibility.

### Functions and files
A function that needs a comment to explain *what* it does should be split; comments explain *why*, and specifically why a non-obvious choice was made. Soft limits: 50 lines per function, 300 per file — a limit is a smell detector, not a rule to satisfy by extracting nonsense. Early returns over nested conditionals. No more than three positional parameters; beyond that, an options object.

### React
Function components only. Custom hooks for anything stateful used more than once. `useEffect` is a last resort and every one requires a justifying comment — most `useEffect` calls in real codebases are derived state that should be computed during render, or event handling that should be in the handler. Keys are stable ids, never array indices. Lists of user content are never rendered with `dangerouslySetInnerHTML` outside the sanitized markdown renderer. Props are typed explicitly; no `React.FC` (it adds implicit children and buys nothing).

### Git
Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`). Small, single-purpose commits. Branch per feature. Commit messages explain why, not what — the diff already says what.

---

## 4. Risks and trade-offs

Ordered by expected impact.

### R1 — Retrieval quality is the product, and it is the hardest thing here
Bad chunks or bad retrieval produce confident wrong answers, which is worse than no product. Every UI polish item is worthless if the answers are wrong.
**Mitigation:** manual chunk inspection as an explicit exit criterion in M3; the retrieval-only debug endpoint in M4; a hand-built evaluation set before M5 begins; hybrid search from day one rather than "vector-only first, improve later"; the relevance floor and abstention path built before the happy path is polished.

### R2 — Streaming is where the complexity concentrates
Partial markdown, autoscroll fighting the user, abort semantics, error mid-stream, reconnection, cleanup on unmount, and persistence of partial output. This is where a demo-grade RAG app visibly differs from a product.
**Mitigation:** build the non-streaming turn first; the AST-based incomplete-block guard is designed up front (§00/8.3) rather than patched after flicker appears; every stream terminal state (`done`, `stopped`, `failed`, `disconnected`) is enumerated and tested; partial persistence is in the orchestration spec, not an afterthought.

### R3 — Provider cost and rate limits
Embedding a large corpus and streaming long answers cost real money, and free-tier rate limits will be hit during development.
**Mitigation:** content-hash dedup, per-user quotas enforced server-side, chat rate limits, `usage_events` recording from M3 so cost is visible rather than discovered on a bill, batched embedding with backoff, and a cheap model for titling and query rewriting.

### R4 — Scope. This plan is large for one engineer
**Mitigation:** milestones are ordered so that stopping after M5 still yields a coherent, demonstrable product (auth + documents + grounded chat). P1 and P2 are genuinely deferred, not implicitly planned. The largest scope risk is polishing the homepage before the chat works, which the M6 ordering prevents by construction.

### R5 — ChromaDB in production
Single-node, weaker operational story than Postgres, an extra service to run.
**Mitigation:** it is behind an interface, Postgres is the source of truth, and the pgvector implementation is stubbed in M3 so the interface is proven against two backends rather than shaped around one. Migration is a re-index.
**Trade-off accepted:** Chroma is easier in development and the abstraction cost is one interface.

### R6 — Indirect prompt injection through uploaded documents
A document containing instructions is concatenated into a prompt by design.
**Mitigation:** sources are delimited and labeled as untrusted data, the system instruction is restated after the context block, output is sanitized before rendering, and citation indices are validated. Full mitigation is an open research problem; the honest posture is defense in depth plus the fact that in single-tenant use the user is injecting into their own session.
**Residual risk accepted and documented**, which is itself the correct engineering answer.

### R7 — Single-process assumptions
In-memory rate limiting, the in-process abort registry, and the in-process worker are all incorrect the moment there are two instances.
**Mitigation:** each is behind an interface or isolated in a module, and each is named here so the constraint is known rather than discovered. Phase 1 is explicitly single-node.

### R8 — No E2E tests in Phase 1
**Mitigation:** integration tests cover backend flows against a real database, and the auth and chat paths get the deepest unit coverage. Playwright is P1. This is a considered trade, not an oversight — a shallow E2E suite written against unstable flows is maintenance cost without confidence.

### Trade-offs made explicit

| Chosen | Given up | Why |
|---|---|---|
| Vite SPA | SSR/SEO for app routes | Only one page needs SEO, and it is static |
| No Redux/Zustand globally | A single uniform state story | Query + Context covers it; a store would be ceremony around cached server data |
| Chroma | Operational simplicity of one datastore | Development ergonomics now, interface makes it reversible |
| Postgres job queue | Broker features (priorities, dashboards, delayed fan-out) | No second datastore, transactional consistency with document rows |
| SSE | Bidirectional channel | Nothing flows client→server mid-stream; SSE reuses the entire HTTP stack |
| No LangChain | Prebuilt chains and integrations | Owning the pipeline is the point, and debugging is far easier |
| Kysely | Prisma's ergonomics and migration tooling | RAG needs real SQL, and Prisma's raw escape hatch loses the type safety |
| Radix primitives | Zero dependencies | Focus management and ARIA correctness are not worth hand-rolling |
| 15-minute access tokens | Zero refresh complexity | Short window limits stolen-token damage; single-flight refresh makes it invisible |
| Feature-first folders | Familiar type-first layout | Deletion safety and visible dependency direction |

---

## 5. Future roadmap

**Phase 2 — depth (post-launch).** Collections with per-conversation scoping · cross-encoder reranking · message feedback feeding a quality dashboard · conversation export · session management UI · usage and cost dashboard · Playwright E2E · pgvector migration to collapse to a single datastore.

**Phase 3 — collaboration.** Workspaces with membership and roles · shared document libraries · shared read-only conversation links · comments on answers · an audit log. This is the first phase where the data model needs real change (a `workspace_id` alongside `user_id` throughout) — which is why per-user scoping is implemented in one place, the repository layer, rather than scattered across services.

**Phase 4 — intelligence.** Multi-step decomposition for comparative questions · table and figure extraction with structure preserved · document-level summaries as a retrieval tier · automatic follow-up suggestions from retrieved content · cross-document synthesis with per-document attribution · optional web search as a clearly-labeled second source.

**Phase 5 — platform.** Public API with keys and quotas · an embeddable chat widget · connectors for Notion, Google Drive, and Slack with incremental sync · webhooks · self-hosted local model support.

**Infrastructure, deliberately excluded from this document** but sequenced for when it is added: containerization, CI running lint/typecheck/tests on every PR, staging, managed Postgres, object storage, a managed vector store, error tracking, metrics and tracing on the existing request-id plumbing, and structured log aggregation. The architecture assumes none of it and blocks none of it — which is exactly why the seams in §05/8 exist.

That sequencing is now written down across two documents. [08-production-architecture.md](08-production-architecture.md) plans the move from local Docker to a managed cloud deployment: it closes on the R5 trade-off above by recommending the pgvector collapse listed under Phase 2, and it treats R7's single-node constraint as the binding limit on the first deployment rather than as a footnote. [09-devops-cicd-deployment.md](09-devops-cicd-deployment.md) plans how code reaches that infrastructure — CI, containers, registry, environments, deployment and rollback — and recommends **against** Kubernetes for now, on the grounds that R7 makes its central features unusable. **Both are planning only; nothing is deployed and no CI exists.**
