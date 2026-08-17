# 07 — Knowledge Base

**Status: planning complete; implementation not started.**

Nothing in this document is built. `/app/knowledge` is a static placeholder
(`KnowledgeBasePage.tsx`, 24 lines, no hooks, no API calls). This document
exists so that implementation is a matter of following it rather than
rediscovering the architecture.

Implements **FR-18 (P1)** from [00-product.md](00-product.md) §2 — "Collections
(named groups of documents) and per-conversation scoping to a collection" —
and the Phase 2 line item in [06-roadmap.md](06-roadmap.md) §5.

> **Knowledge Base is not "Knowledge Explorer."** No such feature has ever
> existed in this repository. There is no concept graph, no confidence or
> maturity grading, no CQRS split, and no `/api/v1/knowledge/*` surface in any
> commit. Knowledge Base is document grouping plus a retrieval scope. If a
> request arrives describing entity extraction or concept maturity, it is
> describing a different product and belongs in its own specification.

---

## 1. The problem

Retrieval today searches **everything the user has ever uploaded**. That is
correct for a small corpus and actively wrong for a mixed one: a question about
cognitive behavioural therapy searches AWS runbooks, and the relevance floor is
the only thing standing between the user and a citation from the wrong domain.
The failure is quiet — a plausible answer sourced from an unrelated document is
worse than no answer, and it is the exact failure mode [06-roadmap.md](06-roadmap.md)
R1 names as the highest-impact risk in the product.

A Knowledge Base is a **named, persistent subset of a user's documents that a
conversation can be scoped to.** That is the whole feature. It buys precision
by narrowing the haystack, and it buys the user a mental model — "this chat is
about my medical records" — that the product currently cannot express.

### What it is not

Not a folder (a document lives in as many as apply). Not an access-control
boundary (there is one user; sharing is Phase 3 in the roadmap). Not a separate
index (one vector collection per user, unchanged). Not a second RAG pipeline.

---

## 2. Product semantics

These answers are the contract. Ambiguity here becomes a bug later.

| # | Question | Answer |
|---|---|---|
| 1 | What problem does it solve? | Retrieval precision over a mixed corpus, plus a nameable scope |
| 2 | Who owns one? | Exactly one user. No sharing in V1 |
| 3 | KB ↔ Document | **Many-to-many** via a join table |
| 4 | KB ↔ Conversation | One conversation has **zero or one** KB |
| 5 | KB ↔ Chunk / Embedding | **No relationship.** Chunks and vectors are untouched by this feature |
| 6 | Can a conversation switch KB? | Only while it has **no messages**. Frozen after the first turn — see §2.2 |
| 7 | Existing conversations? | `knowledge_base_id IS NULL` — unscoped, byte-identical to today |
| 8 | Remove document from KB? | Membership row deleted. **Document, chunks, and vectors untouched** |
| 9 | Underlying document deleted? | Membership rows cascade away. KB shrinks. Nothing else changes |
| 10 | KB deleted? | Membership rows cascade. Documents survive |
| 11 | Conversations of a deleted KB? | `ON DELETE SET NULL` → they revert to unscoped and keep working |
| 12 | Unscoped vs scoped chat? | Same pipeline; scoped passes a `documentIds` filter |
| 13 | What does retrieval search? | Unscoped: all the user's documents. Scoped: only KB members |

### 2.1 Why many-to-many

The alternative — `documents.knowledge_base_id`, one KB per document — is one
column instead of a table, and it is wrong here. A security whitepaper belongs
in both *AWS* and *Compliance*. Under one-KB-per-document the user must upload
it twice, which:

- doubles storage and **doubles embedding cost**, the expense [06-roadmap.md](06-roadmap.md) R3 exists to control;
- defeats the `content_hash` dedup in `documents`, which would reject the second upload as a duplicate anyway;
- produces two document rows that drift when one is re-indexed.

The join table costs one table and one index. Take it.

### 2.2 Why the scope freezes after the first message

A conversation's transcript is a record of what was searched. Persisted
citations point at chunks that may not be in a new scope, and the rolling
summary (`conversations.summary`) was built from turns retrieved under the old
one. Allowing a mid-thread switch makes the visible history a lie about how the
answers were produced, and the user cannot see the discrepancy.

Freezing is also cheap to explain: *"scope is chosen when the chat starts."*
Starting a correctly-scoped chat is one tap now that Recent lives in the
sidebar. Marked as an open decision in §12 — it is a product call, not a
technical constraint.

---

## 3. User stories and acceptance criteria

**US-1 — Group documents.** *As a user with documents spanning several
subjects, I want to group related documents so I can ask questions against one
subject.*
- Given ≥1 ready document, I can create a KB with a name and add documents to it.
- The KB list shows each KB's name and document count.

**US-2 — Scoped answers.** *As a user, I want a conversation scoped to a KB so
answers cite only that material.*
- Starting a chat from a KB produces a conversation whose retrieval covers only that KB's documents.
- Every citation in that conversation resolves to a document in that KB.
- A question with no answer in the KB abstains rather than reaching outside it.

**US-3 — Nothing breaks.** *As an existing user, I want my current chats to
work exactly as before.*
- Conversations with no KB search the whole corpus, identically to today.
- No migration alters an existing conversation's behavior.

**US-4 — Reorganize safely.** *As a user, I want to remove a document from a
KB without deleting it.*
- Removing membership leaves the document in the library, indexed and usable.

**US-5 — See the scope.** *As a user, I want to know which KB a conversation
is using.*
- The chat surface names the active KB, at every breakpoint.
- An unscoped conversation makes no claim about scope.

---

## 4. User experience

Follows [01-design-system.md](01-design-system.md) and the existing shell. **No
new navigation architecture** — the mobile drawer and sidebar completed in the
navigation work stand unchanged, and `Workspace → Knowledge Base` already
routes to `/app/knowledge`.

### 4.1 List — `/app/knowledge`

`PageHeader` + a `Card` per KB, reusing the `DocumentsPage` layout idiom.

```
Knowledge Base                              [ + New Knowledge Base ]

┌──────────────────────────────────────────┐
│ Research Papers                      ⋯   │
│ 12 documents · Updated 2 hours ago       │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ AWS Documentation                    ⋯   │
│ 24 documents · Updated yesterday         │
└──────────────────────────────────────────┘
```

Row menu (`Menu` + `MenuItem`, as the sidebar conversation rows use): Rename ·
Delete. Card body navigates to detail.

### 4.2 Create

Fields: **name** (required, 1–80 chars, trimmed) and **description**
(optional, ≤280 chars). Both are plain text; neither is rendered as markdown.

Duplicate names are **allowed** — see §10. On success, navigate to the new KB's
detail page, which is empty and whose primary action is *Add documents*.

> **Implementation note.** `components/ui/` has no `Dialog`/`Modal` primitive —
> the inventory is Alert, Avatar, Badge, Button, Card, Checkbox, FieldError,
> FormField, IconButton, Input, Kbd, Menu, Meter, PasswordInput, Skeleton,
> Spinner, TextLink, Tooltip. `Menu`, `Tooltip`, `CommandPalette`, and the
> mobile drawer each hand-roll their own portal and focus management.
> Creating a KB therefore needs **either** a new `Dialog` primitive (focus
> trap, Escape, scrim, `inert` — the drawer in `Sidebar.tsx` is the reference
> implementation) **or** a dedicated `/app/knowledge/new` route with an inline
> form. See §11 Phase 4 and the risk in §12.

### 4.3 Detail — `/app/knowledge/:id`

Title, description, document count, and a document list reusing `DocumentRow`.
Actions: *Add documents*, *Start chat*, rename, delete, and per-row *Remove
from Knowledge Base*.

The remove control must read **"Remove from Knowledge Base"**, never "Delete" —
the two are one tap apart and one of them is irreversible.

### 4.4 Document membership

*Add documents* opens a picker listing the user's documents with checkboxes
(`Checkbox` exists), showing which are already members. Selection is additive
and idempotent; re-adding a member is a no-op, not an error.

Only `ready` documents can be added. A document still processing cannot be
retrieved from, so admitting it would create a KB that silently under-answers.
See §10.

### 4.5 Chat

Starting a chat from a KB creates a conversation with `knowledge_base_id` set
and lands on it. The chat surface names the scope above the thread:

```
Searching  Research Papers                          [ Change ]
```

`[ Change ]` appears **only while the conversation has no messages** (§2.2).
After the first turn the scope is shown as static text. An unscoped
conversation shows nothing — absence of a claim, rather than a claim of
absence.

The sidebar's Recent list is **not** grouped by KB in V1. Recency grouping is
the documented model (FR-21) and a second axis would compete with it.

### 4.6 Responsive

Reuses existing breakpoints (`sm 640 · md 768 · lg 1024`) and the existing
drawer. No new breakpoints.

| Width | Behavior |
|---|---|
| 390×844 / 430×932 | KB cards full-width, one per row; picker is full-screen; scope indicator truncates with `truncate`; all targets ≥44px |
| `md`–`lg` | Two-column card grid |
| Desktop | Card grid; scope indicator inline above the thread |

### 4.7 States

| State | Treatment |
|---|---|
| No KBs | `EmptyState` — what a KB is and a *New Knowledge Base* action |
| Empty KB | `EmptyState` inside the card — *Add documents* |
| No documents at all | Point at `/app/documents`; do not offer an empty picker |
| No *ready* documents | Explain that processing must finish |
| Loading | `Skeleton` matching final card geometry — never a spinner ([00-product.md](00-product.md) §8.3) |
| Error | `Alert tone="error"` with retry, matching `ChatPage` |
| Deleted document | Vanishes from the KB; no tombstone |
| Deleted KB | Conversation shows unscoped; list refetches |

---

## 5. Data model

Two new tables and one new column. Migration `0007_knowledge_bases.sql`,
following the existing convention: `NNNN_lower_snake_case.sql`, applied in
numeric order, each in its own transaction (`db/migrate.ts`).

```sql
CREATE TABLE knowledge_bases (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_bases_by_user_idx
  ON knowledge_bases (user_id, updated_at DESC);

CREATE TABLE knowledge_base_documents (
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (knowledge_base_id, document_id)
);

CREATE INDEX knowledge_base_documents_by_document_idx
  ON knowledge_base_documents (document_id);

ALTER TABLE conversations
  ADD COLUMN knowledge_base_id UUID
    REFERENCES knowledge_bases(id) ON DELETE SET NULL;

CREATE INDEX conversations_by_knowledge_base_idx
  ON conversations (knowledge_base_id) WHERE knowledge_base_id IS NOT NULL;
```

### 5.1 Field rationale

| Field | Type | Null | Why |
|---|---|---|---|
| `knowledge_bases.id` | UUID v7 | no | Matches every other table; time-ordered, so the PK index stays dense |
| `.user_id` | UUID FK | no | Ownership. `CASCADE` — account deletion already relies on this pattern |
| `.name` | TEXT | no | Length enforced in Zod, not SQL, matching how `documents` handles it |
| `.description` | TEXT | **yes** | Genuinely optional; empty string and NULL must not both mean "none" |
| `.updated_at` | TIMESTAMPTZ | no | Drives "Updated 2 hours ago" and the list's sort key |
| `kb_documents` PK | composite | — | **The PK is the dedup mechanism.** Duplicate membership is impossible by construction rather than by a check |
| `kb_documents.document_id` idx | — | — | Needed for cascade on document delete and for "which KBs hold this document" |
| `conversations.knowledge_base_id` | UUID FK | **yes** | NULL = unscoped = today's behavior. **This is the backward-compatibility guarantee** |

### 5.2 Why `SET NULL` on conversations

`CASCADE` would delete conversations when a KB is deleted — destroying chat
history as a side effect of tidying up documents. `RESTRICT` would make a KB
undeletable once used, which in practice means never deletable. `SET NULL`
degrades the conversation to unscoped: it keeps working, keeps its transcript,
and searches the whole corpus from then on. The UI must reflect that rather
than continuing to claim a scope (§4.5).

### 5.3 No changes to chunks, vectors, or embeddings

`document_chunks` is untouched. Vector metadata is untouched. The embedding
model is untouched. A KB is a set of document ids; retrieval already accepts
document ids (§6). **This is the single most important property of this design
— it is why the feature is additive.**

---

## 6. Retrieval scoping

### 6.1 The scope filter already exists

This was the decisive finding of the repository study, and it changes the shape
of the whole feature. `RetrieveInput` **already carries `documentIds?: string[]`**,
and both halves of hybrid retrieval already honour it:

| Half | File | Mechanism |
|---|---|---|
| Lexical | `chunk.repository.ts:289` | Server-side SQL: `c.document_id = ANY($1::uuid[])` |
| Vector | `vector.retriever.ts:61` | One id → server-side Chroma `where`; many → over-fetch ×4, filter client-side |

`retrieval.service.ts` even logs a `filtered` field. `/api/v1/search` already
exposes the filter (`search.schemas.ts`: `documentIds: z.array(z.uuid()).max(50)`).

**No vector store change is required. No new index. No re-embedding. No second
pipeline.** The only missing plumbing is chat: `chat.service.ts:103` calls
`retrievalService.retrieve({ userId, query })` and passes no `documentIds`.

### 6.2 The two paths

```
UNSCOPED (unchanged)
  conversation.knowledge_base_id IS NULL
    → retrieve({ userId, query })
    → all of the user's documents

SCOPED (new)
  conversation.knowledge_base_id = KB
    → resolve KB → document ids   [ownership enforced in SQL, §7]
    → retrieve({ userId, query, documentIds })
    → hybrid → evidence → Gemini → citations
```

Everything after `retrieve()` is untouched: fusion, the relevance floor
(`RETRIEVAL_MIN_SCORE=-1`, unchanged), diversity caps, the context builder,
prompt assembly, streaming, and citation mapping.

### 6.3 Two defects this feature must fix

Both are latent today because chat never passes `documentIds`. Scoped chat
makes them reachable, so they are in scope for implementation.

**D-1 — An empty filter means opposite things to the two retrievers.**

```ts
// chunk.repository.ts:287 — empty means "no documents"
if (input.documentIds?.length === 0) return [];

// vector.retriever.ts:73 — empty means "no filter at all"
const wanted = new Set(query.documentIds ?? []);
matches.filter((m) => wanted.size === 0 || wanted.has(m.metadata.documentId));
```

An **empty Knowledge Base** would therefore return nothing from the lexical
half and *the user's entire corpus* from the vector half. Not a cross-tenant
leak — the collection is still per-user — but a scope the user did not ask for,
presented as if they had. The vector retriever must distinguish "no filter"
(`undefined`) from "an empty filter" (`[]`), matching the lexical half.

Belt and braces: the service layer should short-circuit an empty KB to an
abstention before retrieval runs at all (§10).

**D-2 — Multi-document filtering is client-side and loses recall.**

For >1 document the vector half fetches `topK × 4` and filters in memory. A KB
of 3 documents inside a corpus of 200 can return fewer than `topK` survivors —
silently, with no error. The comment in `vector.retriever.ts` is candid that
four is a compromise with no guarantee.

**Verified fix, and it needs no new infrastructure:** Chroma's `where` supports
`$in`, confirmed against the running 1.0.0 instance —

```
{"where": {"documentId": {"$in": [<real-id>, <fake-id>]}}}  → 3 matches
{"where": {"documentId": {"$in": [<fake-id>]}}}             → 0 matches
```

`MetadataFilter` is currently `Record<string, string | number | boolean>` —
equality only — so it cannot express this. Widening that type to permit
`{ $in: string[] }` and passing the whole set server-side removes the
over-fetch and the recall loss. The `fake.store.ts` implementation must learn
the same operator so tests stay honest.

This is an **optimization, not a correctness fix** — the client-side path
returns correct results, just possibly fewer. Sequence it as §11 Phase 6b and
gate it on a measurement, per the repo's stance on premature optimization.

---

## 7. API contract

Follows existing conventions: mounted under `/api/v1`, one resource router per
noun (`routes/index.ts`), Zod schemas in `shared/src/schemas/`, `validate()`
middleware, `authenticate` on every route, `asyncHandler` wrappers.

New schema module: `shared/src/schemas/knowledge.schemas.ts`.
New types: `shared/src/types/knowledge.ts`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/knowledge-bases` | List, with document counts |
| `POST` | `/api/v1/knowledge-bases` | Create |
| `GET` | `/api/v1/knowledge-bases/:id` | Detail |
| `PATCH` | `/api/v1/knowledge-bases/:id` | Rename / edit description |
| `DELETE` | `/api/v1/knowledge-bases/:id` | Delete |
| `GET` | `/api/v1/knowledge-bases/:id/documents` | Members |
| `POST` | `/api/v1/knowledge-bases/:id/documents` | Add members (batch) |
| `DELETE` | `/api/v1/knowledge-bases/:id/documents/:documentId` | Remove one member |

Conversation association reuses the **existing** endpoint rather than adding
one: `POST /api/v1/conversations` accepts an optional `knowledgeBaseId`, and
`PATCH /api/v1/conversations/:id` accepts it only while `message_count = 0`
(§2.2). No new route.

`knowledge-bases`, hyphenated, matches the existing multi-word path style. The
placeholder page route stays `/app/knowledge` — a frontend path, unrelated.

### 7.1 Representative contracts

**`POST /api/v1/knowledge-bases`**
```jsonc
// request
{ "name": "Research Papers", "description": "Papers for the lit review" }
// 201
{ "id": "01a0…", "name": "Research Papers", "description": "…",
  "documentCount": 0, "createdAt": "…", "updatedAt": "…" }
```
Validation: `name` 1–80 after trim; `description` ≤280, optional.
Errors: `401` unauthenticated · `422` validation.

**`POST /api/v1/knowledge-bases/:id/documents`**
```jsonc
// request
{ "documentIds": ["01a0…", "01a0…"] }
// 200 — idempotent; already-members are not errors
{ "added": 1, "alreadyPresent": 1, "documentCount": 12 }
```
Validation: 1–50 UUIDs (mirroring the `/search` cap).
Errors: `401` · `404` KB not owned · `404` if **any** document is not owned —
see §8 · `422` validation.

**`DELETE /api/v1/knowledge-bases/:id/documents/:documentId`** → `204`.
Removing a non-member is `204`, not `404`: the caller's desired state is
already true, and DELETE is idempotent.

---

## 8. Security model

The threat is a single one restated eight ways: **acting on a resource you do
not own.** The existing answer is that scoping lives in the repository layer,
not in controllers, so it cannot be forgotten at a call site.

| Attack | Prevention |
|---|---|
| Read another user's KB | Every query is `WHERE id = $1 AND user_id = $2` |
| Update another's KB | `UPDATE … WHERE id AND user_id`; 0 rows → 404 |
| Delete another's KB | Same |
| **Add another's document** | Insert is `INSERT … SELECT … WHERE documents.user_id = $userId` — §8.1 |
| Remove another's membership | Delete joins through `knowledge_bases` filtered by `user_id` |
| Use another's KB in chat | Conversation create/patch resolves the KB with `user_id`; unknown → 404 |
| Retrieve another's chunks | Two independent layers: per-user Chroma collection `user_{id}`, and `c.user_id = $1` in lexical SQL. **The KB filter is a third, narrower layer — never the only one** |

**404, never 403.** A 403 confirms the resource exists. The existing auth
integration tests assert this for documents and conversations; KB tests must
assert the same.

### 8.1 Membership insertion is atomic

The obvious implementation — verify ownership, then insert — is a
check-then-act race. Do it in one statement so the database enforces it:

```sql
INSERT INTO knowledge_base_documents (knowledge_base_id, document_id)
SELECT $1, d.id
  FROM documents AS d
 WHERE d.id = ANY($2::uuid[])
   AND d.user_id = $3
   AND EXISTS (SELECT 1 FROM knowledge_bases kb
                WHERE kb.id = $1 AND kb.user_id = $3)
ON CONFLICT DO NOTHING
RETURNING document_id;
```

A foreign document contributes no row. Compare `RETURNING` count against the
requested count: a shortfall means at least one id was not owned or not ready →
respond `404` without disclosing which. `ON CONFLICT DO NOTHING` makes the
operation idempotent against the composite PK.

This mirrors the existing guard-in-SQL style — `setGeneratedTitle` guards on
`title_generated = false` in the statement rather than around it.

---

## 9. Performance

Deliberately conservative. Only indexes with a named query.

| Query | Support | Note |
|---|---|---|
| KB list | `knowledge_bases_by_user_idx (user_id, updated_at DESC)` | Matches sort exactly |
| Document counts | `LEFT JOIN … GROUP BY` in the list query | One query, not N+1. Revisit only if measured |
| Members of a KB | Composite PK leading edge | No extra index |
| Cascade on document delete | `knowledge_base_documents_by_document_idx` | Without it, deleting a document seq-scans the join table |
| Conversations of a KB | Partial index `WHERE knowledge_base_id IS NOT NULL` | Only for the delete-impact count; partial because most rows are NULL |
| Scoped retrieval, lexical | Existing `document_chunks_by_user_idx` + `= ANY` | No change |
| Scoped retrieval, vector | See D-2 | Over-fetch ×4 today; `$in` removes it |

**The real scaling limit is D-2, not SQL.** A KB with many documents inside a
much larger corpus loses recall through the client-side filter. Measure before
optimizing; the trigger is a KB whose member count is a small fraction of the
corpus.

The `max(50)` cap on `documentIds` in `search.schemas.ts` also bounds KB size
for the scoped path. A KB larger than 50 documents needs that cap raised
deliberately, with the over-fetch fixed first.

---

## 10. Edge cases

| Case | Behavior |
|---|---|
| **Empty KB** | Abstain before retrieval. Never fall through to an unfiltered search — see D-1 |
| Document deleted | Membership cascades. KB shrinks silently. Past citations still render from `content_snapshot` |
| Document still processing | Not addable. Picker shows it disabled with its status |
| Document processing **failed** | Not addable; same treatment |
| Document added, later re-indexed | Membership is by `document_id` and survives re-indexing |
| Duplicate membership | Composite PK + `ON CONFLICT DO NOTHING`. Not an error |
| **Duplicate KB names** | **Allowed.** Names are labels, not identifiers. A uniqueness constraint would produce a confusing failure for a user who genuinely wants two similar names, and nothing depends on names being unique |
| KB deleted | Conversations `SET NULL` → unscoped, still functional |
| Conversation → deleted KB | Impossible to observe: the FK is NULL, not dangling |
| Cross-tenant attempt | `404` (§8) |
| Retrieval finds nothing in scope | Existing abstention path, unchanged |
| Gemini failure | Existing `UpstreamError` → 502 and the persisted `failed` message. Unchanged |
| Vector store failure | Existing `VectorStoreError`, retryable. Unchanged |

---

## 11. Implementation phases

Ordered so that every phase is independently verifiable and nothing user-facing
ships before its scope is enforced.

**Phase 1 — Schema.** New: `0007_knowledge_bases.sql`. Changed: `db/schema.d.ts`.
*Verify:* `migrate` then `migrate:status` clean; existing 875 tests still pass —
proves the nullable column changed no behavior. *Risk:* low.

**Phase 2 — Repository + service.** New:
`repositories/knowledge-base.repository.ts`, `services/knowledge/knowledge-base.service.ts`.
All ownership scoping lives here (§8). *Verify:* unit + integration incl.
cross-tenant. *Risk:* low. *Depends on:* 1.

**Phase 3 — API + contracts.** New: `shared/src/schemas/knowledge.schemas.ts`,
`shared/src/types/knowledge.ts`, `api/routes/knowledge-base.routes.ts`,
`api/controllers/knowledge-base.controller.ts`. Changed: `routes/index.ts`.
*Verify:* integration tests per endpoint incl. 404s. *Risk:* low. *Depends on:* 2.

**Phase 4 — Frontend KB UI.** New: `features/knowledge/{api,hooks,components}`,
`pages/app/KnowledgeBaseDetailPage.tsx`. Changed: `KnowledgeBasePage.tsx`,
`routes.ts`, `query-keys.ts`, `useBreadcrumbs.ts` (a KB id is a second UUID
segment needing a human label — the conversation fix is the pattern).
*Verify:* component tests, browser at 390/430/desktop. **Risk: the missing
`Dialog` primitive (§4.2) — decide before starting.** *Depends on:* 3.

**Phase 5 — Conversation association.** Changed: `0008_…` not needed (column
added in 1); `conversation.repository.ts`, `conversation.service.ts`,
`chat.schemas.ts`. *Verify:* create scoped; patch refused once
`message_count > 0`; cross-tenant KB → 404. *Risk:* low. *Depends on:* 3.

**Phase 6a — Retrieval scoping.** Changed: `chat.service.ts`, `chat.stream.ts`
(resolve KB → ids, pass `documentIds`), `vector.retriever.ts` (**fix D-1**).
*Verify:* scoped retrieval returns only member documents; **unscoped regression
suite must be byte-identical**. *Risk:* **highest in the plan — this is the
only phase that touches the RAG path.** *Depends on:* 2, 5.

**Phase 6b — `$in` push-down (optional).** Changed:
`vector-store.interface.ts` (widen `MetadataFilter`), `chroma.store.ts`,
`fake.store.ts`. *Verify:* recall parity vs client-side filter on a KB that is
a small fraction of the corpus. *Risk:* medium; gate on measurement.

**Phase 7 — Tests.** §12. **Phase 8 — Real E2E.** §12.

---

## 12. Test strategy

### Backend
CRUD · ownership (each verb, cross-user → 404) · membership add/remove ·
duplicate membership is a no-op · **adding another user's document → 404 and no
row inserted** · conversation association · association refused after first
message · scoped retrieval returns only members · **empty-KB abstention (D-1)** ·
deleted document removes membership only · deleted KB nulls conversations ·
**unscoped regression: the existing retrieval and chat suites must pass
unmodified.**

### Frontend
List · create · validation · detail · add/remove documents · remove ≠ delete ·
delete KB · scope indicator shown/hidden correctly · `[ Change ]` hidden after
first message · loading/empty/error states · mobile at 390/430 · no horizontal
overflow.

### End-to-end (real services)

Two KBs, disjoint subject matter — the whole point of the feature:

1. Upload `mental-health.pdf` and `aws.pdf`; wait for `ready`.
2. KB **A: Mental Health** ← `mental-health.pdf`. KB **B: AWS** ← `aws.pdf`.
3. Chat scoped to A, ask a mental-health question.
   **Assert:** answer grounded; every citation resolves to `mental-health.pdf`;
   **no chunk from `aws.pdf` appears in the evidence bundle.**
4. Chat scoped to A, ask an **AWS** question → **abstains**. This is the
   strongest assertion in the suite: it proves the scope is a real boundary and
   not merely a ranking preference.
5. Inverse for B.
6. An unscoped conversation still retrieves across both.
7. Delete KB A → its conversation survives, becomes unscoped, `mental-health.pdf`
   still in the library and still retrievable.

---

## 13. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| O-1 | Can a conversation switch KB after its first message? | **Freeze** (§2.2). Reversible later; the permissive version is not |
| O-2 | `Dialog` primitive, or a `/app/knowledge/new` route? | Build `Dialog` — the picker needs one too, and three components already hand-roll portals |
| O-3 | Warn on KB delete that *N* conversations become unscoped? | Yes if cheap; the partial index makes the count one query |
| O-4 | Raise the 50-document cap? | Not in V1. Revisit with D-2 fixed |
| O-5 | Auto-create a KB from a folder upload? | Out of scope |
| O-6 | Should the sidebar group Recent by KB? | No — competes with recency grouping (FR-21) |

## 14. Out of scope for V1

Sharing or collaboration (Phase 3 in the roadmap) · nested or hierarchical KBs ·
auto-classification of documents into KBs · per-KB retrieval tuning · per-KB
usage analytics · KB-level exports · scoping the `/search` debug endpoint to a
KB · Knowledge Explorer in any form.

---

## 15. Design review

1. **Smallest complete architecture?** Yes. Two tables, one nullable column, no
   new endpoint for conversation association, and no new retrieval code path.
2. **Reuses the RAG pipeline?** Entirely. The scope is an argument the pipeline
   already accepts.
3. **Preserves unscoped chat?** Yes — `NULL` is the existing behavior, and the
   existing suite is the regression gate.
4. **Tenant isolation guaranteed?** Yes, at three layers, with membership
   insertion atomic in SQL (§8.1).
5. **Multi-KB documents?** Yes, many-to-many (§2.1).
6. **Deletion semantics?** Documents survive membership removal; conversations
   survive KB deletion by degrading to unscoped.
7. **Is the retrieval filter actually implementable today?** **Yes — it already
   exists** (§6.1), and the `$in` improvement is verified against the running
   Chroma. This is the finding that makes the feature small.
8. **Biggest risks?** Phase 6a, the only phase touching retrieval; D-1, which
   would silently widen scope; and the missing `Dialog` primitive, which is the
   largest unplanned frontend cost.
9. **Open decisions?** §13, principally O-1 and O-2.
10. **Out of scope?** §14.
