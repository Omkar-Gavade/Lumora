# 01 — Design System

## 1. Philosophy

The interface is a reading and thinking surface. Its job is to disappear. Every visual decision either aids comprehension, communicates state, or is removed.

**Five rules that resolve most disputes:**

1. **Hierarchy through space and weight, not color and shadow.** If a section needs separation, it gets whitespace before it gets a border, a border before it gets a background, and a background before it gets a shadow. Most UI reaches for the shadow first — this is the single biggest cause of "AI-generated" appearance.
2. **One accent color, used rarely — and the primary button is not it.** Accent means "this is interactive" or "this is grounded": links, focus rings, active nav state, citation chips. The primary action is **ink** (near-black in light, near-white in dark), because a saturated CTA blob is the single fastest way to look like a template. Roughly one accent element per screen region.
3. **Motion communicates causality, never decoration.** Animation exists to show where something came from or that something changed. If removing an animation loses no information, remove it.
4. **Borders are hairlines.** 1px, low contrast. A visible heavy border is a design failure — the eye should perceive separation without registering a line.
5. **Density is deliberate and varies by zone.** Marketing pages breathe (128px section rhythm). The app is dense (8–16px rhythm) because it is a tool used for hours. Applying one density to both is a common and obvious mistake.

**Explicitly banned**, with reasons:

| Banned | Why |
|---|---|
| Multi-stop gradients on surfaces/buttons/text | Reads as 2023 AI-template. A gradient headline is decoration pretending to be hierarchy |
| Glassmorphism / backdrop-blur panels | Costs contrast and GPU, gains nothing, dates instantly |
| Colored or large-radius drop shadows | Shadows model elevation. Anything that is not floating has none |
| Neon / saturated brand colors | Fights text for attention on a text-heavy product |
| Emoji as UI iconography | Renders inconsistently across platforms, is not scalable, reads as unserious |
| Animated gradient blobs, particles, 3D hero scenes | Pure decoration, expensive, actively hostile to reduced-motion users |
| More than 2 font families | |
| Border-radius above 12px on containers | Large radii read as consumer-toy; this is a work tool |
| Dark-mode-as-inverted-light | Requires its own contrast tuning; naive inversion produces vibrating pure-black-on-pure-white |

---

## 2. Tokens

All tokens are CSS custom properties on `:root` and `[data-theme="dark"]`, consumed through the Tailwind config. **No raw hex values, no arbitrary Tailwind values (`text-[13.5px]`) in components** — a value not in the scale is either a scale gap to fix deliberately or a mistake. Lint rule enforces this.

### 2.1 Color

Neutrals carry the interface. A single accent carries action. Semantic colors carry state only.

Neutral ramp (12 steps, cool-neutral — a slight blue cast reads as "software," a warm cast reads as "document"; Lumora uses cool for chrome and near-neutral for reading surfaces):

```
--neutral-0   #ffffff
--neutral-50  #fafafa
--neutral-100 #f4f4f5
--neutral-200 #e4e4e7
--neutral-300 #d4d4d8
--neutral-400 #a1a1aa
--neutral-500 #71717a
--neutral-600 #52525b
--neutral-700 #3f3f46
--neutral-800 #27272a
--neutral-900 #18181b
--neutral-950 #09090b
```

Accent — a restrained indigo. Chosen because it is unambiguously "interactive" without being a saturated CTA-blue, and it holds contrast in both themes:

```
--accent-500 #4f46e5   base
--accent-600 #4338ca   hover
--accent-400 #6366f1   dark-theme base (lightened; the 500 is too dark on dark surfaces)
```

Semantic: `success #16a34a` · `warning #d97706` · `danger #dc2626`, each with a `-subtle` background variant. These appear **only** as state (ingestion status, destructive actions, validation), never as decoration.

**Semantic aliases** — components consume these, never the ramp directly. This is what makes theming a single-file change and prevents drift:

```
Light                               Dark
--bg-canvas       neutral-0         neutral-950
--bg-subtle       neutral-50        neutral-900
--bg-raised       neutral-0         neutral-900     (cards, popovers)
--bg-inset        neutral-100       neutral-800     (code blocks, inputs)
--bg-hover        neutral-100       neutral-800
--bg-active       neutral-200       neutral-700
--border-subtle   neutral-200       neutral-800
--border-default  neutral-300       neutral-700
--border-strong   neutral-400       neutral-600
--text-primary    neutral-900       neutral-50
--text-secondary  neutral-600       neutral-400
--text-tertiary   neutral-500       neutral-500
--text-inverse    neutral-0         neutral-950
--accent          accent-500        accent-400
--focus-ring      accent-500        accent-400
```

**Dark theme is authored, not computed.** Canvas is `#09090b`, not `#000000` — pure black against light text causes halation and makes elevation impossible to express. Raised surfaces get *lighter*, matching real light behavior. Borders are lowered in contrast because dark surfaces need less separation force.

**Contrast verification is a build step, not a vibe.** Every foreground/background pair in the alias table is asserted ≥4.5:1 (text) or ≥3:1 (UI) in an automated test. A theme change that breaks contrast fails the test.

### 2.2 Typography

Two loaded families plus a system stack:
- **Headings / display:** `Source Serif 4` variable, with `Georgia, "Times New Roman", serif` fallback and `font-optical-sizing: auto`. **This is the identity decision.** Every AI product landing page is set in a geometric sans, so a sans-only Lumora would read as one of a hundred. A serif headline says *documents, reading, records, trust* — which is exactly what the product is about — and it differentiates at zero cost in legibility because it appears only at 20px and above.
- **UI + body:** `Inter` variable, with `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` fallback. Large x-height (legible at 13–14px in dense UI), optical sizing in the variable version, tabular figures for the documents table.
- **Code / metadata:** the system monospace stack (`ui-monospace, SFMono-Regular, "SF Mono", Menlo`). Marketing and auth use it only for short technical labels, so shipping a third webfont for it would be a wasted request. A real code font (`JetBrains Mono`) is loaded by the chat route, where users copy code out of answers and `l`/`1`/`I` disambiguation genuinely matters.

Self-hosted as `woff2`, latin + latin-ext subsets only, `font-display: swap`, with the two latin faces preloaded. Total above-the-fold font weight is ~170 KB. No external font CDN — it costs a third-party connection, a privacy exposure, a render-blocking round trip, and an `unsafe-inline`-shaped hole in the CSP.

*Deviation from the original plan, made deliberately during implementation:* the plan specified Inter + JetBrains Mono and a two-family cap. The serif was added because the sans-only build looked competent and anonymous. The family count is still two loaded webfonts, so the budget rule holds.

Scale (1.200 minor-third for UI, tightened at the small end where a strict ratio produces unusable in-between sizes):

| Token | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| `display` | 56/60 (mobile 40/44) | 600 | −0.02em | Hero headline only |
| `h1` | 36/44 | 600 | −0.02em | Page titles, marketing sections |
| `h2` | 28/36 | 600 | −0.01em | Section headings |
| `h3` | 20/28 | 600 | −0.01em | Card titles, subsections |
| `body-lg` | 18/30 | 400 | 0 | Marketing prose |
| `body` | 16/26 | 400 | 0 | **Chat messages, default reading** |
| `body-sm` | 14/22 | 400 | 0 | UI labels, sidebar, table cells |
| `caption` | 13/18 | 400 | 0 | Metadata, timestamps, helper text |
| `micro` | 11/16 | 500 | 0.04em | Badges, uppercase eyebrows |
| `code` | 13.5/22 | 400 | 0 | Code blocks |

Negative tracking on large sizes is not optional — display type set at default tracking looks amateurish. Body text tracking stays at 0.

**Chat message body is 16px with 1.625 line-height.** Justification: it is read continuously in long passages. 14px is a spreadsheet decision applied to a reading surface.

Prose rules inside answers: paragraph spacing 16px, list item spacing 8px, heading top margin 32px / bottom 12px, `max-width: 68ch` as a secondary guard inside the 768px column.

### 2.3 Spacing

4px base unit. Allowed: `0, 1(4), 2(8), 3(12), 4(16), 5(20), 6(24), 8(32), 10(40), 12(48), 16(64), 20(80), 24(96), 32(128)`. Nothing else. Values like 15px or 18px are what make a UI feel unresolved.

Semantic application: `2` inside a control · `3`/`4` between related elements · `6`/`8` between groups · `16`+ between page sections · `24`/`32` between marketing sections.

### 2.4 Radius, borders, elevation

Radius: `sm 4px` (badges, chips) · `md 6px` (buttons, inputs) · `lg 8px` (cards, panels) · `xl 12px` (modals, the composer) · `full` (avatars, pills only).

Borders: 1px only. `--border-subtle` by default; `--border-default` when a control must read as interactive.

Elevation — three levels, and most surfaces use level 0:
```
0  none                                          cards, panels, inline surfaces
1  0 1px 2px rgb(0 0 0 / 0.04)                   dropdowns, hover cards
2  0 4px 12px rgb(0 0 0 / 0.06),
   0 1px 3px rgb(0 0 0 / 0.04)                   modals, command palette
```
Dark theme replaces shadows with a lighter surface plus a subtle top-edge highlight — shadows are nearly invisible on dark backgrounds and faking them with heavier black only muddies the surface.

### 2.5 Motion

Durations: `instant 100ms` (hover, focus) · `fast 150ms` (dropdowns, tooltips) · `base 200ms` (panels, modals) · `slow 300ms` (page transitions, rarely used).

Easing: `standard cubic-bezier(0.2, 0, 0, 1)` — fast out, gentle settle · `decelerate cubic-bezier(0, 0, 0, 1)` for entrances · `linear` for progress only.

Animate `transform` and `opacity` only. Animating `height`, `width`, `top`, or `left` triggers layout on every frame; use `transform: scaleY()` with `transform-origin`, or an explicit measured height with `will-change` scoped to the animation's duration.

**`prefers-reduced-motion: reduce` is implemented globally** — a single rule sets durations to `0.01ms` and disables transforms, plus per-component fallbacks that swap slide-ins for instant appearance and disable the typing/scroll-reveal effects. This is a correctness requirement (vestibular disorders), not a preference.

Framer Motion is used **only** for: source panel slide-in, modal/sheet entrance, sidebar collapse, and homepage scroll-reveal. Everything else is a CSS transition. Framer Motion is code-split so the marketing bundle carries only what its own reveals need.

---

## 3. Icons

`lucide-react`, 20px default (16px in dense rows, 24px in marketing cards), `stroke-width: 1.5` (the 2 default is too heavy next to Inter at UI sizes), `currentColor` always. Tree-shaken per-icon imports; never a barrel import of the whole set.

Icon-only buttons always carry `aria-label` and a tooltip. Icons are never the sole carrier of meaning.

---

## 4. Component inventory

Three tiers. A component moves up a tier only when a second real use appears — building "reusable" components for one caller is speculative work that ossifies the wrong abstraction (YAGNI).

### Tier 1 — Primitives (`components/ui/`)

Presentational, zero business logic, zero data fetching, fully typed, forward refs, spread rest props.

`Button` (variants: primary · secondary · ghost · danger · link; sizes sm/md/lg; `loading` renders a spinner while preserving width to prevent layout shift; `iconLeft`/`iconRight`; `asChild` for link-as-button) · `IconButton` · `Input` · `Textarea` (with `autoResize`) · `Select` · `Checkbox` · `Radio` · `Switch` · `Label` · `FormField` (label + control + description + error, wired for `aria-describedby`/`aria-invalid`) · `Card` · `Badge` · `Avatar` · `Separator` · `Skeleton` · `Spinner` · `Tooltip` · `Dropdown` · `Dialog` · `Sheet` · `Popover` · `Tabs` · `Accordion` · `Toast` · `ScrollArea` · `Kbd` · `ProgressBar` · `EmptyState` · `ErrorState` · `VisuallyHidden`.

**Radix UI primitives underpin `Dialog`, `Dropdown`, `Popover`, `Tooltip`, `Tabs`, `Accordion`, `Select`, `Switch`, `Checkbox`.** Justification: correct focus trapping, focus restoration, `aria-*` wiring, typeahead, collision-aware positioning, scroll locking, and portal management are genuinely hard and are where hand-rolled components fail accessibility audits. Radix is unstyled, so it costs no visual identity — Lumora keeps 100% of the styling and buys only the behavior. Rejected alternative: shadcn/ui as a whole, because copying a widely-recognized default component set is exactly how a product acquires a generic look. Radix is the layer *below* shadcn; using it directly with original styling is the deliberate choice.

### Tier 2 — Composites (`components/common/`)

`PageHeader` · `SectionHeader` · `ConfirmDialog` (typed-confirmation variant for destructive actions) · `CopyButton` (with copied-state feedback) · `StatusPill` · `FileDropzone` · `SearchInput` (debounced, clearable) · `CommandPalette` · `ThemeToggle` · `UserMenu` · `Pagination` · `DataTable` (light wrapper; not a grid framework) · `MarkdownRenderer` · `CodeBlock` · `ErrorBoundary` · `Head` (document title / meta).

### Tier 3 — Feature components (`features/<domain>/components/`)

Own their domain, may use domain hooks and queries, are not reused across features.

*Chat:* `ChatLayout` · `ConversationSidebar` · `ConversationList` · `ConversationItem` · `MessageThread` · `MessageList` · `UserMessage` · `AssistantMessage` · `MessageActions` · `StreamingIndicator` · `CitationChip` · `SourcePanel` · `SourceChunkCard` · `SourcesSummary` · `ChatComposer` · `ChatEmptyState` · `SuggestedQuestions` · `StopGenerationButton` · `ScrollToBottomPill`.

*Documents:* `DocumentUploadZone` · `DocumentList` · `DocumentRow` · `DocumentStatusPill` · `IngestionProgress` · `DocumentDeleteDialog` · `QuotaMeter` · `DocumentEmptyState`.

*Auth:* `LoginForm` · `SignupForm` · `ForgotPasswordForm` · `ResetPasswordForm` · `PasswordStrengthMeter` · `PasswordRequirements` · `VerifyEmailPanel` · `AuthCard`.

*Marketing:* `MarketingHeader` · `Hero` · `ProductPreview` · `TrustStrip` · `FeatureGrid` · `FeatureCard` · `HowItWorks` · `StepCard` · `UseCases` · `PrivacySection` · `FaqAccordion` · `FinalCta` · `MarketingFooter`.

*Settings:* `SettingsLayout` · `SettingsNav` · `SettingsSection` · `ProfileForm` · `ChangePasswordForm` · `AppearanceForm` · `DangerZone` · `DeleteAccountDialog`.

---

## 5. Interaction standards

**Every interactive element defines five states**: default · hover · focus-visible · active · disabled. Loading is a sixth where applicable. A component missing hover or focus-visible does not pass review.

- Hover: `--bg-hover`, 100ms. Never a transform on list rows (jitter). Never on touch-only devices (`@media (hover: hover)`).
- Focus: `outline: 2px solid var(--focus-ring); outline-offset: 2px`, on `:focus-visible` only. **Focus outlines are never removed.**
- Active: `--bg-active`, and buttons take `scale(0.98)` at 100ms for physicality.
- Disabled: `opacity: 0.5; cursor: not-allowed`, plus `aria-disabled`. Where a control is disabled for a reason the user can fix, the reason is displayed — a dead button with no explanation is a dead end.
- Loading: preserve the element's dimensions. Any spinner that changes a button's width causes layout shift and looks broken.

**Feedback timing** — the rules that make an app feel fast:
- < 100ms: no indicator at all. Showing a spinner for a 60ms action makes it feel *slower*.
- 100ms–1s: inline indicator on the triggering control.
- \> 1s: skeleton or progress, with the operation named.
- \> 10s: progress plus a cancel affordance.

**Optimistic updates** for: sending a message (user turn renders instantly), creating a conversation, renaming, deleting, theme change. Each has a defined rollback that restores prior state and surfaces a toast. Optimism without rollback is a bug generator.

**Toasts:** bottom-right desktop / top mobile, 4s auto-dismiss (errors persist until dismissed), max 3 stacked, always dismissible. Toasts confirm background outcomes; they never carry information the user must act on.

---

## 6. Accessibility standards

- Semantic HTML first. `<button>` for actions, `<a>` for navigation, `<nav>/<main>/<aside>/<header>` landmarks, one `<h1>` per page and no skipped heading levels.
- Skip-to-content link, first focusable element on every page.
- Full keyboard operability: Tab order follows visual order, arrow keys within composite widgets, `Esc` closes the topmost layer, `Enter`/`Space` activate. Modals trap focus and restore it to the trigger on close.
- Streaming answers live in `aria-live="polite"` `aria-atomic="false"`, updated on a ~500ms throttle rather than per token, so screen readers announce coherent phrases instead of a token storm.
- Status changes (ingestion complete, generation stopped, errors) announce through a shared live-region hook.
- Form errors: `aria-invalid`, `aria-describedby` pointing at the message, `role="alert"` on the message, and focus moved to the first invalid field on submit.
- Contrast asserted in tests (§2.1). Touch targets ≥44×44px. `prefers-reduced-motion` honored. Zoom to 200% without horizontal scroll or clipping.
- Automated axe checks in component tests, plus a manual keyboard-and-screen-reader pass as an explicit checklist item in the chat milestone.

---

## 7. Responsive strategy

Breakpoints: `sm 640` · `md 768` · `lg 1024` · `xl 1280` · `2xl 1536`.

Mobile-first authoring — base styles are the small screen, breakpoints add. The reverse produces override-stacking that becomes unmaintainable.

Layout shifts by zone:
- **Marketing:** 1 column < 768, 2 columns 768–1023, 3 columns ≥ 1024. Section padding scales 24 → 48 → 64px.
- **App:** sidebar overlay < 768 / collapsible ≥ 768 / persistent ≥ 1024. Source panel bottom-sheet < 1024 / overlay 1024–1279 / push ≥ 1280.
- **Tables** become stacked cards below `md`. Horizontal-scrolling tables on phones are a usability failure.

Use `dvh` not `vh` for full-height app layout — mobile browser chrome makes `vh` overflow, which puts the composer under the keyboard.

---

## 8. Styling implementation rules

- Tailwind utilities in JSX. No CSS-in-JS runtime (cost, and it fights streaming SSR if added later). A small `globals.css` holds tokens, resets, font faces, and the handful of things utilities express badly (custom scrollbars, `::selection`, markdown prose defaults).
- Conditional classes go through `cn()` (clsx + `tailwind-merge`) so later classes correctly override earlier ones.
- Component variants via `cva` (class-variance-authority) — variant/size combinations declared as data rather than as nested ternaries, which keeps `Button` readable at 6 variants × 3 sizes.
- **No arbitrary values.** `text-[13px]`, `p-[18px]`, `bg-[#4f46e5]` are lint errors. Extend the theme instead.
- `dark:` variants driven by a `data-theme` attribute on `<html>` with `darkMode: ['class', '[data-theme="dark"]']`, resolved by a tiny inline script before first paint to prevent a flash of the wrong theme.
- Class order enforced by `prettier-plugin-tailwindcss` — eliminates ordering diff noise permanently.
