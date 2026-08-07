# Lumora — Frontend

Marketing site and authentication flows. React 19 · TypeScript (strict) · Tailwind CSS v4 · Vite.

Frontend only — there is no backend yet. Auth screens run against typed mocks in
[`src/features/auth/api/mock-auth.ts`](src/features/auth/api/mock-auth.ts) whose signatures match the
planned API in [`../docs/04-data-and-api.md`](../docs/04-data-and-api.md), so wiring the real client
later replaces function bodies and nothing else.

## Run

```bash
npm install && npm run dev
```

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build |
| `npm run check` | Typecheck + lint + contrast assertions |
| `npm run check:contrast` | Asserts WCAG ratios on every token pair, both themes |

## Routes

| Path | Screen |
|---|---|
| `/` | Homepage |
| `/privacy`, `/terms` | Legal pages |
| `/login`, `/signup` | Auth |
| `/forgot-password` | Request a reset link (switches to a sent-confirmation state) |
| `/reset-password?token=…` | Form. No token or `?token=expired` shows the invalid-link state |
| `/verify-email?email=…` | "Check your inbox". `?token=…` verifies; `?token=expired` fails |

**Reaching the non-happy paths.** Submitting any auth form with `taken@lumora.app` triggers the
failure branch. The token query values above drive the reset and verification error states. These
exist because loading, success, and failure states retrofitted after the fact are what make a
product feel unfinished.

## Design system

Tokens live in one place: [`src/styles/globals.css`](src/styles/globals.css). Raw ramps are defined
on `:root`, semantic aliases (`--text-primary`, `--bg-canvas`, `--accent`) are switched by
`[data-theme]`, and `@theme inline` maps them into Tailwind so every utility follows the theme
automatically. **Components consume semantic tokens only** — never a ramp value, never a hex
literal.

Three decisions worth knowing before editing:

1. **The primary button is ink, not accent.** Near-black in light, near-white in dark. The accent
   indigo is reserved for links, focus rings, active nav state, and citation chips. A colored CTA
   blob is the fastest way to look templated.
2. **A serif carries the headings.** Source Serif 4 for anything 20px and up; Inter for all UI and
   body. This is the identity, not decoration — see `../docs/01-design-system.md` §2.2.
3. **Hierarchy comes from space and weight.** Whitespace before a border, a border before a
   background, a background before a shadow. Most surfaces have no shadow at all.

### Guardrails that are enforced, not just documented

- `npm run check:contrast` fails the build on any token pair below 4.5:1 (text) or 3:1 (UI), in
  either theme. 19 pairs asserted.
- ESLint blocks hex literals and arbitrary spacing in `className` (`no-restricted-syntax`). A value
  outside the scale is either a gap to fix deliberately or a mistake.
- `cn()` extends `tailwind-merge` with Lumora's color and type scales. This is load-bearing: without
  it, `tailwind-merge` cannot tell `text-on-ink` (a color) from `text-body-sm` (a size) and silently
  deletes one of them — which rendered every primary button as white-on-white until it was fixed.

## Structure

```
src/
├── app/            providers (theme), router (routes, scroll behavior)
├── components/
│   ├── ui/         primitives — Button, Input, FormField, Checkbox, Badge, Card, Alert…
│   ├── common/     composites — Container, Section, Accordion, Logo, LegalPage, ErrorBoundary…
│   ├── layout/     MarketingLayout, AuthLayout
│   └── marketing/  Navbar, Hero, ProductPreview, Features, WhyRag, Privacy, Faq, Footer…
├── features/auth/  schemas (Zod), api (mocks), components
├── hooks/          useReveal, useScrolled, useScrollSpy, useCooldown, useLockBodyScroll…
├── lib/utils/      cn
├── pages/          thin route components — composition only
└── styles/         globals.css (tokens), fonts.css
```

Import direction: `pages → features → components → lib`. Primitives in `components/ui/` know
nothing about any feature.

## Accessibility

Skip link as the first tab stop; visible `:focus-visible` rings that are never removed; semantic
landmarks and one `<h1>` per page; `FormField` owns label↔control↔error wiring so an association
can't be forgotten at a call site; errors carry `role="alert"` and sit next to their field;
`prefers-reduced-motion` disables all reveal and transition motion globally; the mobile sheet traps
nothing it shouldn't but does restore focus to its trigger on `Escape`.

## Known gaps

- No tests yet. Vitest + RTL + `jest-axe` are planned in the milestone plan (`../docs/06-roadmap.md`).
- `react-router` has one open advisory (RSC-mode CSRF) with no patched release. Not reachable here:
  this is a client-side SPA with no RSC, no server actions, and no framework mode.
- Legal copy is written to match what the architecture actually does, but it has not been reviewed
  by a lawyer. Do that before a real launch.
