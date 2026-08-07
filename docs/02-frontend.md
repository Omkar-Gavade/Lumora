# 02 — Frontend Architecture

## 1. Stack and why each piece

| Choice | Rationale | Rejected alternative |
|---|---|---|
| React 19 + TypeScript strict | Team standard; strict mode catches the null/undefined class of bugs that dominate real incidents | — |
| Vite | Sub-second HMR, native ESM dev, straightforward Rollup production output | Next.js — rejected: SEO need is one static marketing page, the app itself is a client-side authenticated SPA that gains nothing from SSR, and Next would drag in a server runtime that duplicates the Express backend. Adding SSR later means moving *only* the marketing route |
| React Router v7 (declarative mode) | Nested layouts, code-split routes, well-understood | TanStack Router — better type-safety, but React Router's ecosystem maturity wins for a portfolio project that should look conventional to reviewers |
| TanStack Query v5 | Server state is not client state: it is remote, shared, cached, and stale by default. Query handles caching, dedup, retry, background refetch, and invalidation — all of which would otherwise be hand-written badly | Redux Toolkit Query — heavier; RTK's store is unnecessary once server state moves out |
| React Hook Form + Zod | Uncontrolled inputs mean typing does not re-render the form; Zod schemas are shared verbatim with the backend | Formik — re-renders on every keystroke |
| Tailwind CSS | Co-located styling, no naming overhead, token-constrained by config, dead CSS impossible | CSS Modules — more files, more indirection, no constraint enforcement |
| Framer Motion | Only for the four animations in §01/2.5 | — |
| Zustand / Redux for app state | **Deliberately absent.** See §5 | |

---

## 2. Folder structure

Feature-first, not type-first. `components/`, `hooks/`, `utils/` as top-level buckets scale badly: work on one feature touches five distant folders, and nothing tells you what may import what. Feature folders make the dependency direction visible and deletion safe.

```
frontend/
├── public/
│   ├── fonts/                      self-hosted woff2 subsets
│   └── favicon/
├── src/
│   ├── main.tsx                    root render, provider composition
│   ├── App.tsx                     router mount + global boundaries
│   ├── vite-env.d.ts
│   │
│   ├── app/                        application-level wiring
│   │   ├── providers/
│   │   │   ├── AppProviders.tsx    single composition point for all providers
│   │   │   ├── QueryProvider.tsx   QueryClient + defaults + devtools
│   │   │   ├── AuthProvider.tsx    session state, token lifecycle
│   │   │   ├── ThemeProvider.tsx   theme resolution + persistence
│   │   │   └── ToastProvider.tsx
│   │   ├── router/
│   │   │   ├── index.tsx           route tree
│   │   │   ├── routes.ts           path constants + typed builders
│   │   │   ├── ProtectedRoute.tsx
│   │   │   ├── PublicOnlyRoute.tsx
│   │   │   └── VerifiedRoute.tsx
│   │   └── config/
│   │       ├── env.ts              Zod-validated import.meta.env
│   │       └── query-keys.ts       central key factory
│   │
│   ├── lib/                        framework-agnostic infrastructure
│   │   ├── api/
│   │   │   ├── client.ts           fetch wrapper: base URL, credentials, JSON, timeout
│   │   │   ├── auth-interceptor.ts 401 → single-flight refresh → replay
│   │   │   ├── errors.ts           ApiError, typed error codes, normalization
│   │   │   ├── sse.ts              SSE reader over fetch (streaming + abort)
│   │   │   └── endpoints.ts        URL builders
│   │   ├── markdown/
│   │   │   ├── renderer.tsx        react-markdown + remark/rehype config
│   │   │   ├── streaming-parser.ts holds incomplete trailing block
│   │   │   ├── citations.ts        [n] → CitationChip transform
│   │   │   └── sanitize.ts         rehype-sanitize allowlist
│   │   ├── storage/                typed localStorage/sessionStorage wrappers
│   │   ├── utils/
│   │   │   ├── cn.ts               clsx + tailwind-merge
│   │   │   ├── format.ts           dates, bytes, relative time
│   │   │   ├── debounce.ts
│   │   │   ├── scroll.ts           near-bottom detection
│   │   │   └── clipboard.ts
│   │   └── validation/             shared field-level Zod primitives
│   │
│   ├── components/
│   │   ├── ui/                     Tier 1 primitives (one folder per component)
│   │   ├── common/                 Tier 2 composites
│   │   └── layout/
│   │       ├── MarketingLayout.tsx
│   │       ├── AuthLayout.tsx
│   │       ├── AppLayout.tsx
│   │       └── SettingsLayout.tsx
│   │
│   ├── features/
│   │   ├── auth/
│   │   │   ├── api/                request functions
│   │   │   ├── hooks/              useLogin, useSignup, useSession…
│   │   │   ├── components/
│   │   │   ├── schemas/            Zod form schemas
│   │   │   └── types.ts
│   │   ├── chat/
│   │   │   ├── api/                conversations, messages, stream
│   │   │   ├── hooks/
│   │   │   │   ├── useConversations.ts
│   │   │   │   ├── useConversation.ts
│   │   │   │   ├── useSendMessage.ts        orchestrates optimistic + stream
│   │   │   │   ├── useMessageStream.ts      SSE lifecycle, abort, reconnect
│   │   │   │   ├── useAutoScroll.ts
│   │   │   │   └── useComposerDraft.ts
│   │   │   ├── components/
│   │   │   ├── stores/
│   │   │   │   └── streaming-store.ts       transient stream buffer (see §5)
│   │   │   └── types.ts
│   │   ├── documents/
│   │   │   ├── api/ hooks/ components/ types.ts
│   │   ├── settings/
│   │   └── marketing/
│   │       ├── components/
│   │       └── content/            copy as typed data, not hardcoded JSX
│   │
│   ├── pages/                      thin route components — composition only
│   │   ├── marketing/  HomePage, PrivacyPage, TermsPage
│   │   ├── auth/       LoginPage, SignupPage, ForgotPasswordPage,
│   │   │               ResetPasswordPage, VerifyEmailPage
│   │   ├── app/        ChatPage, DocumentsPage, Settings*Page
│   │   └── errors/     NotFoundPage, ErrorPage
│   │
│   ├── hooks/                      genuinely global hooks only
│   │   ├── useMediaQuery.ts  useKeyboardShortcut.ts  useOnClickOutside.ts
│   │   ├── useIsomorphicLayoutEffect.ts  useAnnouncer.ts  usePrevious.ts
│   │
│   ├── types/
│   │   ├── api.ts                  re-exports from shared contract
│   │   ├── models.ts
│   │   └── common.ts
│   │
│   ├── constants/
│   │   ├── limits.ts  shortcuts.ts  messages.ts
│   │
│   └── styles/
│       ├── globals.css             tokens, reset, fonts
│       └── markdown.css            prose + code-block styling
│
├── index.html
├── tailwind.config.ts
├── tsconfig.json
├── vite.config.ts
├── eslint.config.js
└── package.json
```

**Import direction is enforced by ESLint (`import/no-restricted-paths`):**

```
pages → features → components → lib → types/constants
```

- `lib/` imports nothing from `features/` or `components/`.
- `components/ui/` imports only from `lib/` — a primitive that knows about a feature is not a primitive.
- **`features/*` never import from each other.** Cross-feature needs are promoted to `components/common/` or `lib/`. Without this rule, feature folders become fake modularity within six weeks.
- `pages/` contain layout composition and route params only. Any logic in a page belongs in a feature hook.

**File naming:** components `PascalCase.tsx` · hooks `useCamelCase.ts` · everything else `kebab-case.ts` · types `PascalCase` · constants `SCREAMING_SNAKE`. Each `components/ui/X/` folder holds `X.tsx`, `X.test.tsx`, and `index.ts` — barrels exist at the component-folder level only, never at the feature level, because feature-wide barrels defeat tree-shaking and create import cycles.

---

## 3. Shared contract package

A third workspace beyond the two required folders:

```
shared/
├── src/
│   ├── schemas/     Zod schemas for every request + response body
│   ├── types/       types inferred from those schemas
│   ├── constants/   error codes, limits, enums (document status, roles)
│   └── index.ts
└── package.json
```

**Why this exists.** The alternative is duplicating request/response shapes in both codebases, where they silently diverge — the single most common source of integration bugs in split-repo TypeScript projects. Here the Zod schema is written once: the backend uses it for runtime request validation, the frontend uses it for form validation, and both derive their static types from `z.infer`. A backend field rename becomes a frontend type error at compile time rather than a runtime `undefined` in production. npm workspaces link it locally; no publishing.

This does not violate the "frontend/ and backend/" instruction — both still contain their complete applications. `shared/` is a contract, not an application.

---

## 4. Routing

```tsx
<Routes>
  <Route element={<MarketingLayout />}>
    <Route index element={<HomePage />} />
    <Route path="privacy" element={<PrivacyPage />} />
    <Route path="terms" element={<TermsPage />} />
  </Route>

  <Route element={<PublicOnlyRoute />}>          {/* authed users bounce to /app */}
    <Route element={<AuthLayout />}>
      <Route path="login" element={<LoginPage />} />
      <Route path="signup" element={<SignupPage />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset-password" element={<ResetPasswordPage />} />
    </Route>
  </Route>

  <Route path="verify-email" element={<VerifyEmailPage />} />   {/* both states */}

  <Route path="app" element={<ProtectedRoute />}>
    <Route element={<AppLayout />}>
      <Route index element={<Navigate to="chat" replace />} />
      <Route element={<VerifiedRoute />}>
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:conversationId" element={<ChatPage />} />
        <Route path="documents" element={<DocumentsPage />} />
      </Route>
      <Route path="settings" element={<SettingsLayout />}>
        <Route index element={<Navigate to="profile" replace />} />
        <Route path="profile"    element={<ProfileSettingsPage />} />
        <Route path="security"   element={<SecuritySettingsPage />} />
        <Route path="appearance" element={<AppearanceSettingsPage />} />
        <Route path="danger"     element={<DangerZonePage />} />
      </Route>
    </Route>
  </Route>

  <Route path="*" element={<NotFoundPage />} />
</Routes>
```

**Three separate guards, not one.** `ProtectedRoute` checks authentication, `VerifiedRoute` checks email verification, `PublicOnlyRoute` checks the inverse. Collapsing them into one component with boolean props produces a tangle of conditions; separate guards compose declaratively and each has one reason to change. `VerifiedRoute` sits *inside* `AppLayout` so an unverified user still gets the app shell and settings — they can change their password and sign out — but chat and documents are gated. That matches FR-5.

`ProtectedRoute` behavior: while the session is resolving (the initial refresh attempt on cold load), render a full-screen shell skeleton — **not** a redirect. Redirecting during resolution causes the classic flash-to-login-then-back-to-app. On failure it redirects to `/login?next=<encoded current path>` and the login flow returns the user exactly where they were.

**No React Router loaders/actions.** Rationale: TanStack Query already owns server state. Using loaders as well creates two caches with different invalidation rules and two answers to "where does data come from." Route components mount, hooks fetch, Query caches. One model.

Code splitting: every route element is `React.lazy`. The marketing bundle and the app bundle share only `lib/` and `components/ui/`. A visitor who never signs in downloads no chat code, no markdown renderer, and no Framer Motion beyond the reveal animations.

Prefetching: hovering a sidebar conversation calls `queryClient.prefetchQuery` for its messages, and hovering the *Documents* link prefetches the document list. Makes navigation feel instant at near-zero cost.

---

## 5. State management

Four categories, four mechanisms. The core decision is that **there is no global client-state library**, and that is a considered choice rather than an omission.

### 5.1 Server state → TanStack Query
Everything from the API: user, conversations, messages, documents, quota. Query owns caching, staleness, dedup, retry, and invalidation.

Defaults: `staleTime: 30s` (conversation list), `5m` (user, documents), `Infinity` for a settled conversation's messages (past messages are immutable). `retry: 1` with exponential backoff, and **no retry on 4xx** — retrying a 401 or a validation error is pure latency. `refetchOnWindowFocus` on for the conversation list, off for message threads (refetching a thread mid-read is disruptive).

Query keys via a central factory so invalidation is never guessed:
```ts
export const queryKeys = {
  auth:          { me: () => ['auth','me'] as const },
  conversations: {
    all:  () => ['conversations'] as const,
    list: (f?: ConversationFilters) => ['conversations','list', f ?? {}] as const,
    detail:   (id: string) => ['conversations','detail', id] as const,
    messages: (id: string) => ['conversations','detail', id, 'messages'] as const,
  },
  documents: {
    all: () => ['documents'] as const,
    list: () => ['documents','list'] as const,
    detail: (id: string) => ['documents','detail', id] as const,
  },
  usage: { quota: () => ['usage','quota'] as const },
} as const;
```
Hierarchical keys mean `invalidateQueries({ queryKey: queryKeys.conversations.all() })` correctly sweeps every dependent query. Ad-hoc string keys make this a guessing game and are banned.

### 5.2 Global client state → React Context
Only three things are genuinely global, all low-frequency:
- **AuthContext** — `user`, `status: 'loading'|'authenticated'|'unauthenticated'`, `login`, `logout`, and the in-memory access token. The token lives in a module-scoped variable read by the API client, *not* in React state, so a token refresh does not re-render the tree.
- **ThemeContext** — resolved theme, setter, persisted to `localStorage`, `matchMedia` listener for `system`.
- **ToastContext** — imperative `toast()` plus the queue.

Each is a separate provider. One "AppContext" holding all three re-renders every consumer whenever any part changes — the classic Context performance failure.

### 5.3 Transient high-frequency state → Zustand (chat streaming only)
The single exception. During generation, tokens arrive at 20–60/second. Putting that buffer in Context re-renders the entire tree per token; putting it in Query cache means writing to the cache 60 times a second and fighting its immutability model.

A tiny Zustand store holds `{ streamingMessageId, buffer, phase, citations, error }` with selector-based subscriptions, so only `AssistantMessage` and `StreamingIndicator` re-render. When the stream completes, the finished message is written **once** into the Query cache and the store resets to idle.

Justification for the exception: Zustand here is ~1KB solving a measured performance problem with a bounded, transient scope. It is not a general app store, and no other feature may use it. Reaching for Redux to hold this would be reaching for a cathedral to store a bicycle.

### 5.4 Local state → `useState` / `useReducer`
Form fields (owned by React Hook Form), open/closed toggles, hover, composer text. `useReducer` where several fields change together, such as the upload queue.

**URL is state too.** Conversation ID, settings tab, and search query live in the URL, not in memory — deep-linkable, back-button correct, survives reload. If a piece of state should be shareable as a link, it belongs in the URL.

---

## 6. API layer

Three tiers, each with one responsibility.

**Tier 1 — `lib/api/client.ts`.** A `fetch` wrapper: base URL, `credentials: 'include'`, JSON serialization, `Authorization: Bearer` from the in-memory token, `AbortSignal` timeout, and normalization of every failure into a typed `ApiError { status, code, message, details? }`. Chosen over axios: `fetch` is native, streams natively (required for SSE over POST), and axios adds ~13KB for interceptors that are ~40 lines here.

**Tier 2 — `features/*/api/*.ts`.** Typed request functions, one per endpoint, that validate responses against the shared Zod schemas in development. Pure async functions with no React dependency — trivially testable.

**Tier 3 — `features/*/hooks/*.ts`.** `useQuery`/`useMutation` wrappers holding cache keys, optimistic updates, invalidation, and toast side effects. Components never call Tier 1 or 2 directly.

### 6.1 Token refresh — the important part
```
request → 401 with code TOKEN_EXPIRED
  → is a refresh already in flight?
      yes → await the existing promise
      no  → start one, store it module-scoped
  → refresh succeeds → update in-memory token → replay original request once
  → refresh fails    → clear session → redirect to /login?next=… → reject
```
The single-flight promise is essential: without it, five concurrent 401s fire five refreshes, and because refresh tokens **rotate**, four of them present an already-consumed token, trip reuse detection, and log the user out — the exact bug that makes hand-rolled refresh notorious. Replay is attempted **once**; a second 401 after a successful refresh is a real authorization failure, not an expiry, and looping would be an infinite retry.

### 6.2 Streaming
`POST /api/conversations/:id/messages` returns `text/event-stream`. Implemented over `fetch` + `ReadableStream`, not `EventSource`, because `EventSource` is GET-only and cannot send a request body or an `Authorization` header. `useMessageStream` owns: parsing framed events, dispatching by event type into the Zustand buffer, `AbortController` for stop-generation, and cleanup on unmount so navigating away cancels the request server-side rather than leaking a generation.

---

## 7. Error handling

Three layers:
1. **Error boundaries** at route level (per page), thread level (chat), and message level (one malformed markdown message cannot blank the app). Each renders a recoverable `ErrorState` with a reset action.
2. **Query/mutation errors** — surfaced in place. Inline for form and message errors, toast for background operations. Never a bare `alert()`, never a silent swallow.
3. **Global handlers** for `unhandledrejection` and `window.onerror` to catch what escapes, with a structured client log hook ready for a provider later.

Errors are mapped from backend codes to human copy through a single `constants/messages.ts` table. The backend's raw message is never rendered directly — that is how internal detail leaks into the UI.

---

## 8. Performance

**Bundle.** Route-level splitting; `react-markdown` + `shiki` + `Framer Motion` are dynamically imported by the chat route only; per-icon imports; a bundle-size budget checked at build time so a careless dependency cannot silently double the app.

**Rendering.**
- Message list virtualized with `@tanstack/react-virtual` **above 50 messages**, not below — virtualization below that threshold costs more in complexity and scroll-anchoring bugs than it saves.
- `React.memo` on `MessageItem`, `ConversationItem`, `DocumentRow` — list items whose props are stable across parent re-renders. Applied where a profiler shows waste, not sprayed everywhere.
- Markdown parsing memoized on message content; re-parsing a 2000-word answer on every keystroke elsewhere in the tree is a real, measurable stall.
- Streaming buffer updates batched to ~16ms (one frame). Rendering every token individually is wasted work above 60fps.
- Stable callback identity via `useCallback` where it actually prevents a memoized child from re-rendering.

**Network.** Prefetch on hover; `staleTime` tuned to avoid pointless refetches; a single SSE subscription for all document status updates rather than N polls; images (only the product screenshot) served as AVIF/WebP with explicit dimensions to hold layout.

**Perceived speed.** Optimistic user messages; skeletons matching final geometry; instant conversation switching from cache; fonts preloaded with `swap` so text is never invisible.

---

## 9. Testing

- **Vitest + React Testing Library** for components and hooks. Query behavior, not implementation: assert what a user sees.
- **MSW** for API mocking, using handlers derived from the shared Zod schemas so mocks cannot drift from the contract.
- Priority order: auth flows and guards → chat streaming (including stop, error, and reconnect) → forms and validation → primitives (variants, states, a11y) → utilities.
- `jest-axe` assertions on every primitive and every page-level composition.
- Playwright is deferred to Phase 2 — one honest E2E happy path (signup → upload → ask → cite) is worth more than a shallow unit-test count, but it comes after the flows stabilize.
