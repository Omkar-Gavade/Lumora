# 00 — Product

## 1. Product vision

**Lumora** = private knowledge workspace. User uploads documents, Lumora reads them, user asks questions in plain language, answer comes back grounded in those documents with citations pointing at exact source passages.

**Problem being solved.** General LLMs know the public internet up to a training cutoff. They do not know your lease agreement, your onboarding handbook, last quarter's board deck, or the 400-page standard your team must comply with. Pasting documents into a chat window fails at scale: context windows are finite, pasting is manual, nothing persists, and nothing is searchable across sessions.

**Why RAG specifically.** Three alternatives exist and each loses:

| Approach | Why rejected |
|---|---|
| Fine-tuning on user docs | Expensive, slow, per-tenant models, no delete guarantee, teaches style not facts, no citations possible |
| Stuff everything into context | Breaks past ~50 docs, cost scales linearly per turn, attention degrades in long context ("lost in the middle"), no way to cite |
| Keyword search + read manually | User does the synthesis work; no cross-document reasoning |

RAG retrieves only the handful of passages relevant to *this* question, so cost stays flat as the corpus grows, deletes are instant, and every claim traces back to a source span. Citation is the product, not a feature.

**Positioning statement.** For knowledge workers, students, and small teams who need answers from their own documents, Lumora is a document-grounded chat assistant that cites its sources. Unlike general chatbots, Lumora will say "not in your documents" rather than guess.

**Differentiator, stated honestly.** RAG chat is a crowded category. Lumora does not win on model quality — the model is a commodity behind a provider interface. Lumora wins on three things:
1. **Verifiability.** Every claim carries an inline citation that opens the source chunk. Answers with no retrieval support are refused, not fabricated.
2. **Craft.** Interface latency, streaming smoothness, empty states, keyboard flow. Most RAG demos are Streamlit-grade. Lumora is Linear-grade.
3. **Boundaries.** Explicit, visible statements about what is stored, what is sent to the model provider, and what deleting means.

---

## 2. Personas

**Priya — analyst (primary).** 60–200 PDFs and reports. Asks comparative questions across documents. Needs citations because she pastes findings into work she signs her name on. Judges the product on whether it ever fabricates a number.

**Daniel — graduate student (primary).** 30–80 papers. Asks "what does the literature say about X." Values reading comfort, long sessions, markdown/math rendering, and being able to jump to the cited page.

**Rhea — ops lead at a 12-person company (secondary).** Uploads handbooks and SOPs so teammates stop asking her the same five questions. Cares about correctness and, eventually, sharing. Phase 1 serves her single-player; sharing is roadmap.

Deliberately **not** targeting: enterprise compliance buyers (needs SSO, audit logs, data residency, DPAs — all roadmap), or consumers wanting a general chatbot (that is not this product).

---

## 3. Functional requirements

Priority: **P0** = Phase 1, must ship. **P1** = Phase 2. **P2** = later.

### Marketing surface
- FR-1 (P0) Public homepage: what the product is, why RAG, features, workflow, use cases, privacy, FAQ, CTA.
- FR-2 (P0) Public legal pages: privacy policy, terms.
- FR-3 (P0) Homepage responds 320px → 2560px, and is fully usable and readable without JavaScript-dependent layout.

### Identity
- FR-4 (P0) Sign up with email + password.
- FR-5 (P0) Email verification; unverified accounts may sign in but cannot upload or chat (read-only shell + verification prompt). Rationale: hard-blocking sign-in strands users who lose the email; soft-blocking the expensive actions stops abuse of embedding spend.
- FR-6 (P0) Sign in / sign out. Sign out revokes the current refresh token server-side.
- FR-7 (P0) Forgot password → emailed single-use, time-limited reset link.
- FR-8 (P0) Reset password; on success revoke **all** sessions for that user.
- FR-9 (P0) Silent session renewal via refresh token rotation, invisible to the user.
- FR-10 (P1) List active sessions and revoke individually.
- FR-11 (P2) OAuth (Google), TOTP 2FA.

### Documents
- FR-12 (P0) Upload PDF, DOCX, TXT, MD. Multi-file, drag-and-drop.
- FR-13 (P0) Per-file ingestion status is live and honest: `queued → parsing → chunking → embedding → ready | failed`, with a human-readable failure reason.
- FR-14 (P0) Document list: name, type, size, page/chunk count, status, upload time.
- FR-15 (P0) Delete document → removes file bytes, rows, and vectors. Deletion is complete, not soft, and the UI says so.
- FR-16 (P0) Per-user quotas: file size cap, file count cap, total bytes cap. Enforced server-side.
- FR-17 (P1) Rename document, re-run ingestion on a failed document.
- FR-18 (P1) Collections (named groups of documents) and per-conversation scoping to a collection. Shipping as **Knowledge Base** — fully specified in [07-knowledge-base.md](07-knowledge-base.md); planning complete, implementation not started.
- FR-19 (P2) URL ingestion, .pptx, .csv, .xlsx, OCR for scanned PDFs.

### Chat
- FR-20 (P0) Create, rename, delete conversations. Auto-title from the first exchange.
- FR-21 (P0) Persistent conversation history in the sidebar, newest first, grouped by recency.
- FR-22 (P0) Token-by-token streamed answers.
- FR-23 (P0) Stop generation mid-stream; the partial answer is kept and persisted.
- FR-24 (P0) Markdown rendering: headings, lists, tables, blockquotes, inline code, fenced code with syntax highlighting and copy button, links.
- FR-25 (P0) Inline citation markers `[1]`, `[2]` in the answer body; clicking one opens the source panel at that chunk with the matched text.
- FR-26 (P0) Sources list under each answer: document name, page/section, relevance score.
- FR-27 (P0) Message actions: copy, regenerate (last assistant turn), delete turn.
- FR-28 (P0) Retrieval-phase indicator distinct from generation ("Searching your documents" → "Writing answer").
- FR-29 (P0) Explicit abstention: when retrieval returns nothing above threshold, answer is a stated "I couldn't find this in your documents," never a guess.
- FR-30 (P0) Conversational memory across turns within a conversation, including follow-ups with pronouns ("what about the second one?").
- FR-31 (P1) Per-message thumbs up/down with optional note.
- FR-32 (P1) Export a conversation to markdown.
- FR-33 (P2) Shared read-only conversation links; multi-user workspaces.

### Settings
- FR-34 (P0) Profile: display name, email (read-only in Phase 1), change password.
- FR-35 (P0) Theme: light / dark / system.
- FR-36 (P0) Delete account → cascades to all documents, vectors, conversations.
- FR-37 (P1) Usage view: documents stored, tokens used this month.

---

## 4. Non-functional requirements

### Performance budgets
Numbers below are targets that gate a milestone as "done," not aspirations.

| Metric | Budget | Why this number |
|---|---|---|
| Homepage LCP (mid-tier laptop, throttled Fast 3G) | < 1.8s | Marketing page that loads slowly loses the visitor before the pitch lands |
| Homepage JS shipped (gzipped) | < 120 KB | Landing page needs no app runtime; it is mostly static |
| App shell interactive after auth | < 2.5s | |
| Time to first streamed token | p50 < 1.5s, p95 < 3.0s | Above ~3s users assume it hung. Retrieval must not be the bottleneck |
| Retrieval latency (embed query + vector search + fuse) | p95 < 400ms | Leaves budget for the model's own TTFT |
| Conversation switch (cached) | < 100ms | Sidebar navigation must feel instant, so history is cached and prefetched on hover |
| Ingestion throughput | 20-page PDF `ready` in < 30s | |
| Route chunk size | < 200 KB gzip each | Enforced by a bundle-size check |

### Reliability
- Ingestion is **resumable and idempotent**. A crash mid-embedding must not double-insert vectors or strand a document in `processing` forever. Jobs have attempt counters, a stale-lease reaper, and a terminal `failed` state with a reason.
- A model-provider outage degrades to a clear error inside the chat, never a blank screen or an infinite spinner.
- No data loss on stop-generation: partial assistant output is persisted before the connection closes.

### Security
- Passwords: argon2id (memory-hard; bcrypt's 72-byte truncation and lower memory cost make it the weaker default in 2026).
- Access token: short-lived (15 min), returned in the response body, held **in memory only**. Never `localStorage` — any XSS trivially exfiltrates a persisted token.
- Refresh token: opaque random string, `httpOnly` + `Secure` + `SameSite=Strict`, stored server-side as a hash, rotated on every use, with **reuse detection** that revokes the whole token family.
- Every data access is scoped by `user_id` inside the repository layer. Resource IDs from the client are never trusted; ownership is a `WHERE` clause, not an `if` statement in a controller.
- Uploads validated by magic-byte sniffing, not by extension or client-supplied MIME.
- Rate limits on auth endpoints (per IP and per account), upload, and chat.
- Strict CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, no `X-Powered-By`.
- No user document content in logs, ever. Log IDs and counts.

### Privacy commitments (these are product promises, and they constrain architecture)
- Document contents are sent to the configured model provider **only** as retrieved chunks at query time, and only for that user's own query.
- User documents are never used to train any model.
- Delete means delete: bytes, rows, and vectors, within the request. No soft-delete tombstone holding content.
- Prompt/response bodies are not persisted for internal analysis beyond the user's own conversation history.

### Accessibility
WCAG 2.1 AA as a gate, not a pass. Full keyboard operation of the chat surface. Visible focus rings on every interactive element. Streaming output announced via a polite live region, throttled so a screen reader is not spammed per token. Text contrast ≥ 4.5:1, UI/graphical ≥ 3:1. `prefers-reduced-motion` respected globally. Semantic landmarks. No color-only meaning.

### Maintainability
TypeScript `strict` everywhere, no `any` in committed code. No cyclic imports between feature modules. Backend business logic contains zero Express types — services are framework-agnostic and unit-testable without HTTP. One API contract source shared between client and server.

### Scalability posture (Phase 1 is single-node, and that is a decision)
Phase 1 targets ~1k users, ~100k chunks. Explicitly single-process. But three seams are built now because retrofitting them later is expensive:
1. `VectorStore` interface — swap Chroma for pgvector/Qdrant without touching services.
2. `LLMProvider` / `EmbeddingProvider` interfaces — swap Gemini/OpenAI per environment.
3. Ingestion as **durable queued jobs in Postgres**, not in-request work — the worker can later move to its own process with no code change.

---

## 5. User journeys

### J1 — First run (visitor → first grounded answer)
Target: **under 4 minutes**, and this is the metric that matters most.

1. Lands on homepage from a link. Hero states in one line what the product does. Scans features / how-it-works.
2. Clicks **Get started**. Signup form: name, email, password with a live strength and rules meter.
3. Submits → account created, verification email sent → routed to `/verify-email` with "check your inbox," a resend button on a 60s cooldown, and the email address shown so a typo is visible.
4. Clicks the emailed link → verified → lands in the app.
5. **Chat empty state is the onboarding.** No wizard, no tour. It shows a single upload dropzone with copy explaining that answers come from what is uploaded. Uploading is the only meaningful action available.
6. Drops 3 PDFs. Each row shows live status. First one hits `ready` in ~10s; the composer unlocks the moment at least one document is ready rather than waiting for all.
7. Suggested starter questions appear, generated from actual document titles ("Summarize *Q3-report.pdf*"), not from generic filler.
8. Asks a question. Sees "Searching your documents," then streamed prose. Citation chips appear inline.
9. Clicks `[2]`. Source panel slides in showing the exact chunk, highlighted, with document name and page.
10. **This click is the activation moment.** The user has verified the machine did not make it up. Track it as the north-star activation event.

**Failure branches designed for:** verification email never arrives (resend + "wrong address? sign out and re-register"); PDF is a scan with no text layer (fails with "This PDF has no extractable text — it looks like a scanned image. OCR is not supported yet," not a generic error); first question retrieves nothing (abstain message plus a hint to rephrase or check that the relevant document finished processing).

### J2 — Returning user
Opens app → last conversation restored → sidebar shows history grouped Today / Yesterday / Previous 7 days / Older → clicks `⌘K`, types part of a conversation title, jumps there. Session renewed silently via refresh rotation; the user never sees a login screen unless the refresh token is genuinely dead.

### J3 — Session expiry mid-typing
Access token expires while the user is composing. The next request 401s. The client refreshes once, transparently, and replays the queued request. Concurrent 401s share a single in-flight refresh promise rather than stampeding. Only if the refresh itself fails does the app surface a modal — and it preserves the draft message so nothing typed is lost.

### J4 — Doubting an answer
Reads answer → suspicious of a claim → clicks the citation → source panel shows the passage → passage does not support the claim → thumbs-down with a note (P1). Design requirement: **verifying a claim must take one click, not a search.**

### J5 — Removing a document
Settings/Documents → delete → confirm dialog that names the specific document and states plainly that its content will be removed from future answers and that existing conversations keep their text but their citations become unresolvable. Confirm → gone.

---

## 6. Information architecture

Two zones with different shells, different navigation, and different performance budgets. Kept separate at the routing and bundle level.

```
Lumora
├── Public zone            [marketing shell — header + footer, static-feeling, minimal JS]
│   ├── /                  Homepage
│   ├── /privacy           Privacy policy
│   ├── /terms             Terms of service
│   └── /404
│
├── Auth zone              [centered card shell — no nav, no distraction, single task per screen]
│   ├── /login
│   ├── /signup
│   ├── /forgot-password
│   ├── /reset-password        ?token=
│   ├── /verify-email          ?token=  (also the "check your inbox" state)
│   └── /auth/callback         reserved for OAuth (P2)
│
└── App zone               [authenticated app shell — sidebar + main, dense, keyboard-first]
    ├── /app                   redirect → most recent conversation, or /app/chat
    ├── /app/chat              new conversation
    ├── /app/chat/:id          conversation
    ├── /app/documents         library + upload
    ├── /app/settings          → /app/settings/profile
    │   ├── /profile
    │   ├── /security          password, active sessions (P1)
    │   ├── /appearance        theme
    │   └── /danger            delete account
    └── /app/*                 in-app 404
```

**Why documents are a peer route and not only a modal:** the library is a management surface (status, quotas, bulk delete, retry) that deserves its own URL and its own back-button behavior. But uploading must *also* be possible without leaving chat, so the dropzone appears in the chat empty state and via `⌘U` as an overlay. Two entry points, one shared component, one source of truth.

**Why settings is a nested layout rather than tabs in a modal:** deep-linkable, back-button correct, and it grows without redesign.

---

## 7. Sitemap and navigation model

**Public header:** wordmark (left), section anchors Features / How it works / Use cases / FAQ (center, desktop only), Sign in + Get started (right). Sticky, 64px, translucent background with a hairline bottom border that only appears after scrolling past 8px. Mobile collapses the center to a sheet menu.

**App sidebar (260px, collapsible to 0 on mobile as an overlay):**
```
[Lumora wordmark]           [collapse ⌘\]
[+ New chat]                        ⌘N
[Search conversations…]             ⌘K
── Today ────────────
  Q3 revenue drivers
  Lease termination clause
── Yesterday ────────
  ...
──────────────────────
[Documents]  12          ⌘U to upload
[Settings]
[Avatar ▸ menu: theme, sign out]
```

Rationale: conversations occupy the scrollable middle because they are the highest-frequency target and grow unbounded; Documents and Settings are pinned to the bottom because they are low-frequency and must never move as history grows. Same pattern as ChatGPT/Claude for zero-cost familiarity — deviating here would cost users navigation confidence with no upside.

**Global keyboard map** (Phase 1): `⌘K` command palette · `⌘N` new chat · `⌘U` upload · `⌘\` toggle sidebar · `⌘↵` send · `Esc` stop generation / close overlay · `↑` in empty composer edits last user message · `⌘/` shortcut cheatsheet.

---

## 8. Screen-by-screen specification

Every screen below defines: purpose, layout, all states (empty / loading / error / success), and interaction detail. States are specified up front because retrofitted empty and error states are what make a product feel unfinished.

### 8.1 Homepage `/`

Single column, max content width 1120px, generous vertical rhythm (128px section gaps desktop, 80px mobile). Content is **real** — it describes what the software actually does. No invented customer logos, no fake testimonials, no fabricated metrics. Any social proof that does not exist is simply absent rather than faked; an empty slot is more credible than an invented one.

**Hero.** Headline: *Ask your documents anything.* Sub: *Lumora reads your PDFs, contracts, and notes, then answers questions about them — with citations pointing to the exact passage it used.* Primary CTA **Get started free**, secondary **See how it works** (anchor scroll). Beneath: one line of honest scope — *PDF, DOCX, TXT, and Markdown. Your documents stay yours.* Visual: a static, pixel-accurate mock of the actual chat UI showing a real answer with a citation chip. **Not** an autoplaying video, not a 3D scene, not a gradient blob. The product screenshot *is* the hero art; if the UI is good enough, showing it is the strongest possible claim.

**Trust strip.** Three short factual statements in a row: *Documents processed privately* · *Answers cite their sources* · *Delete removes everything*. Text only, no logos.

**Features** (3×2 grid, cards with a 20px line icon, a 3-word title, and two sentences):
1. *Grounded answers* — every response is built from passages retrieved from your own files.
2. *Real citations* — click a citation to see the exact source text, not a page-level guess.
3. *Knows when it doesn't know* — if your documents don't cover it, Lumora says so instead of guessing.
4. *Fast retrieval* — semantic and keyword search combined, so exact terms and paraphrases both work.
5. *Conversation memory* — follow-up questions work; you don't repeat context.
6. *Your data, deletable* — remove a document and it leaves the index immediately.

**How it works** (4 numbered steps, horizontal on desktop, vertical on mobile): Upload → Lumora indexes → Ask → Verify. Each step has one sentence and a small diagram. Step 2 briefly and plainly explains chunking + embeddings, because explaining the mechanism builds trust with a technical audience and costs one sentence.

**Use cases** (3 cards, concrete, no personas invented out of thin air): research papers; contracts and policies; internal handbooks and SOPs. Each names a real question a user would ask.

**Privacy** — a distinct section, not a footer link. States: what is stored, what is sent to the model provider and when, that documents are never used for training, and what deleting does. Links to the full policy.

**FAQ** — accordion, 7 questions, answered without marketing evasion: What file types? How big can files be? Which model? Does it hallucinate? Do you train on my data? What if my PDF is a scan? Can I delete everything?

**Final CTA** — one line, one button. **Footer** — product / legal / contact columns, wordmark, copyright.

States: no loading state (content is static). Anchor navigation uses smooth scroll unless `prefers-reduced-motion`. Reduced-motion disables all scroll-reveal animation and renders everything visible immediately.

### 8.2 Auth screens

Shared shell: centered card, max-width 400px, wordmark above, one-line context under the heading, form, primary full-width button, secondary link below, legal microcopy at the bottom on signup. No sidebar, no header nav — a single task per screen with nothing to click away to.

**Login.** Email, password (with show/hide toggle), *Forgot password?* aligned right of the password label, submit, *Don't have an account? Sign up*. On failure: one generic message — *Email or password is incorrect* — never distinguishing which, because distinguishing enumerates accounts. Error is announced via `role="alert"`. After 5 failed attempts, exponential backoff with a visible countdown rather than a silent lockout. Autofocus email. Enter submits.

**Signup.** Name, email, password, confirm. Password rules displayed *before* typing (min 12 chars, not a known-breached password) rather than as post-hoc errors; the checklist ticks live as it becomes satisfied. Submit is disabled until valid, and the reason for disablement is visible. Legal consent line with links.

**Forgot password.** Email only. Response is **always** the same success message regardless of whether the account exists — again, no enumeration. Screen switches to a confirmation state with a resend button on cooldown.

**Reset password.** Reads token from the query string, validates it on mount. Three distinct states: valid (show form), invalid/expired (explain, offer to request a new link), already used (same treatment). On success: confirm, state that all sessions were signed out, route to login.

**Verify email.** Two entry paths. From signup: "check your inbox," email shown, resend on 60s cooldown. From the emailed link: verifying spinner → success (auto-route to app after 2s, plus a manual button) or failure (expired → resend; already verified → route to login).

### 8.3 Chat `/app/chat/:id` — the core surface

Three-region layout: sidebar (260px, fixed) · message thread (flexible, content column max-width **768px**, centered) · source panel (400px, slides in from the right, overlays on <1280px, pushes content on wider).

**Why 768px for the reading column:** ~75–85 characters per line at 16px. Wider measure measurably degrades reading speed and line re-acquisition. Answers are prose and get read carefully; this is a reading application. Code blocks and tables are allowed to break out to the full container width with horizontal scroll of their own, because truncating code to fit prose measure is worse.

**Composer:** pinned to the bottom, auto-growing textarea from 1 line to a max of ~10 lines then internal scroll. `⌘↵`/`Enter` sends (Enter-to-send with `Shift+Enter` for newline — the chat convention), attach button, and a send button that becomes a stop button during generation. Disabled with an explanatory inline reason when no document is ready. Draft text persists per-conversation in `sessionStorage` so an accidental navigation does not destroy a long question.

**Message rendering.** User turns: subtle surface-raised bubble, right-aligned constraint but not a chat-app "tail," max 90% width. Assistant turns: **no bubble** — plain prose on the page background, full column width. Rationale: bubbles fight long-form reading and waste horizontal space; ChatGPT and Claude both converged on this for good reason. Avatar/label sits above the assistant turn, not beside it, so the text starts at the same left edge as everything else.

**Streaming.** Tokens append into rendered markdown as they arrive. Two hard problems and their solutions:
- *Incomplete markdown mid-stream* (an unterminated code fence renders as garbage): parse into a stable AST and render only complete block nodes; hold the trailing incomplete block as plain text until it closes. Prevents visible flicker and layout thrash.
- *Autoscroll fighting the user*: follow the stream only while the viewport is within 100px of the bottom. The moment the user scrolls up, autoscroll detaches and a "Jump to latest ↓" pill appears. Autoscroll never yanks the viewport away from something being read.

**Status progression:** `Searching your documents` (with a subtle animated indicator) → `Reading 5 passages` → first token arrives → indicator is replaced by text. These are real phases reported by the server over the stream, not fake theatre — showing a spinner labeled with something that is not happening is a trust leak.

**Citations.** Inline markers render as small, non-jarring superscript chips. Hover previews the first ~200 characters of the chunk in a tooltip; click opens the source panel scrolled to that chunk with the matched span highlighted. Under each answer, a collapsed *Sources (3)* row expands to document name · page/section · score. If the model emits a citation index that does not exist in the retrieved set, the marker is stripped at render time and logged — never shown as a dead link.

**Message actions** appear on hover (and are always present for keyboard/touch focus, not hover-only — hover-only actions are a real accessibility failure): Copy (markdown source, not rendered HTML), Regenerate (last assistant turn only), Delete turn.

**States.**
- *Empty, no documents*: the dropzone-led onboarding described in J1. This is the most important empty state in the product.
- *Empty, documents ready*: greeting, the count of ready documents, 3 suggested questions derived from actual document titles.
- *Loading conversation*: skeleton rows matching real message geometry — not a spinner. A spinner on a text surface reads as "broken"; a skeleton reads as "arriving."
- *Error, generation failed*: inline error block inside the thread with the reason and a Retry button. The failed turn stays visible; it is not silently deleted.
- *Error, network dropped mid-stream*: partial text is kept, an inline notice appears, Retry re-requests from the last user message.
- *Stopped by user*: partial answer persisted with a subtle "Stopped" label.

**Responsive.** ≥1280px: three columns. 768–1279px: sidebar collapsible, source panel overlays. <768px: sidebar becomes a full-height overlay drawer, source panel becomes a bottom sheet at 85% height, composer sticks above the keyboard using `dvh` units, message actions move into a long-press/overflow menu.

### 8.4 Documents `/app/documents`

Header with document count and quota bar. Prominent dropzone that also accepts a click-to-browse. Table (cards on mobile): name, type badge, size, pages, chunks, status pill, uploaded-at, row menu.

Status pill is the critical element and gets real design: `Queued` (neutral) → `Processing` with the current phase and a determinate progress bar where the phase allows it → `Ready` (positive) → `Failed` (destructive, with the reason shown on the row, not hidden behind a hover).

Live updates come from a single SSE subscription for all in-flight jobs, not per-row polling. Rationale: N documents uploaded at once must not become N polling loops.

States: empty (first-run illustration + explanation of supported types and limits) · uploading (optimistic row with client-side progress) · quota exceeded (dropzone disabled with the specific reason and current usage) · partial failure in a batch (successes stay, failures are individually retryable).

### 8.5 Settings `/app/settings/*`

Nested layout: left sub-nav (Profile / Security / Appearance / Danger zone), right content column max-width 640px. Sectioned cards with a title, description, control, and an inline save affordance. Saves are per-section, not one global save button, so the user always knows what was saved. Danger zone is visually separated with destructive styling and requires typing the account email to confirm deletion.

### 8.6 Error and edge screens

404 (public and in-app variants with different navigation options) · 500 / error boundary (apologetic, non-technical, with a reset action and a copyable error ID) · offline banner · maintenance state. Error boundaries are placed at three levels: route, chat thread, and message — so one malformed message cannot blank the entire application.

---

## 9. Content and copy principles

- Say what happened and what to do next. *"That PDF has no extractable text — it looks like a scanned image."* Not *"Ingestion failed."*
- Never invent numbers, customers, or testimonials.
- Sentence case for headings and buttons. Title Case reads as 2010s marketing.
- Buttons are verbs describing the outcome: *Create account*, not *Submit*.
- Never blame the user. *"We couldn't read that file"* not *"You uploaded an invalid file."*
- Legal/privacy copy is plain English first, precise second.
