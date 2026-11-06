# SPEC 02 — Login page

> **Status:** Approved
> **Depends on:** SPEC 01
> **Date:** 2026-10-04
> **Objective:** Add a visual-only login page at `/login` recreating the Astro sign-in template with shadcn/ui components, and make TopBar Sign in and Sign up items navigate to it.

## Scope

**In:**

- Create route `src/app/login/page.tsx` rendering a centered sign-in card full-screen, without `TopBar`.
- Create component `src/components/auth/sign-in-card.tsx` exporting `SignInCard`, recreating `templates/login-template/components/SigninCard.astro` (logo, title, subtitle, email field, password field, remember-me checkbox, forgot-password link, submit button, divider, footer signup link) with English strings and shadcn/ui components.
- Create component `src/components/auth/social-buttons.tsx` exporting `SocialButtons`, recreating `templates/login-template/components/SocialButtons.astro` (Google and GitHub buttons with inline SVG icons) as visual-only buttons.
- Style with Tailwind + existing `src/components/ui/*` components (`card`, `button`, `input`, `label`, `checkbox`, `separator` or equivalents); no port of `templates/login-template/styles/auth.css`.
- Update `src/components/layouts/top-bar.tsx` so dropdown items `Sign in` and `Sign up` navigate to `/login` (e.g. `DropdownMenuItem` with `asChild` + `next/link`).
- Follow project conventions: kebab-case filenames, arrow functions, no new `any`/`unknown`, English-only strings.
- No tests.

**Out of scope (for future specs):**

- Real authentication, registration, session, or user management.
- Form validation beyond native HTML (`required`, `type="email"`) and submit handling.
- Dedicated `/signup` or forgot-password routes and their navigation targets.
- Social OAuth wiring.
- `TopBar` on the `/login` page or shared auth layout.
- Tests.
- Porting `auth.css` or pixel-perfect copy of the Astro template.

## Data model

This feature introduces no new data structures. No persisted state, no API types, no new shared types except local presentational props if needed.

Conventions:

- Route file: `src/app/login/page.tsx` default export as Next.js route (arrow function component).
- Components: `src/components/auth/sign-in-card.tsx` exports `SignInCard`, `src/components/auth/social-buttons.tsx` exports `SocialButtons`.
- Alias imports via `@/*` (`@/*` maps to `src/*` per `tsconfig.json`).
- Proposed English strings: title `Welcome back`, subtitle `Sign in to your account to continue`, labels `Email` / `Password`, placeholders `you@example.com` / `Your password`, checkbox `Remember me`, links `Forgot your password?` / `Sign up`, submit `Continue`, divider `Or`, social buttons `Google` / `GitHub`, footer `No account?`.
- Navigation target literal: `/login`.

## Implementation plan

1. Create `src/app/login/page.tsx` with centered full-screen skeleton rendering an empty placeholder, no `TopBar`. Manual: `pnpm dev`, `/login` loads with no console errors.
2. Create `src/components/auth/social-buttons.tsx` exporting `SocialButtons` with visual-only Google and GitHub buttons reusing shadcn `button` plus inline SVGs. Manual: renders both buttons, clicks neither navigate nor error.
3. Create `src/components/auth/sign-in-card.tsx` exporting `SignInCard` with card structure, English strings, shadcn `card` / `input` / `label` / `checkbox` / `button`, native form (`required`, `type="email"`, `action="#"` or prevented submit), composing `SocialButtons`. Manual: card matches template sections in order, submit and links trigger no navigation or auth.
4. Update `src/app/login/page.tsx` to render `<SignInCard />` centered. Manual: `/login` shows full card, `/` unchanged.
5. Update `src/components/layouts/top-bar.tsx` so `Sign in` and `Sign up` dropdown items navigate to `/login`. Manual: opening avatar dropdown and clicking either item lands on `/login` with no console errors.

## Acceptance criteria

- [ ] `pnpm dev` and opening `/login` shows a centered card with title `Welcome back` and fields `Email` and `Password`. (Not manually verified.)
- [x] `/login` shows `Remember me` checkbox, `Continue` submit button, `Or` divider, `Google` and `GitHub` buttons, and `No account?` footer with `Sign up` link.
- [x] Clicking avatar `Sign in` dropdown item navigates to `/login`.
- [x] Clicking avatar `Sign up` dropdown item navigates to `/login`.
- [x] `/login` renders no `TopBar`; no browser console errors were observed because browser behavior was not tested.
- [ ] Submitting the form, clicking social buttons, `Forgot your password?`, or footer `Sign up` triggers no authentication and no console error. (Not manually verified.)
- [x] Code lives in `src/app/login/page.tsx`, `src/components/auth/sign-in-card.tsx`, and `src/components/auth/social-buttons.tsx` with kebab-case names and arrow functions.
- [x] Card and buttons reuse installed `src/components/ui/*` components; no `auth.css` import exists under `src/`.
- [x] All new UI strings are English.
- [x] No new test files and no new routes besides `/login` exist.
- [x] `pnpm tsc --noEmit` passes without errors.

## Decisions

- **Yes:** single route `/login` for both dropdown items. Matches the requested singular new page and keeps scope minimal.
- **No:** separate `/sign-in` and `/sign-up` routes. Doubles work; signup screen goes in a future spec if needed.
- **Yes:** only sign-in card plus visual signup footer link. Template ships no signup card; building one here would expand scope.
- **No:** switchable sign-in / sign-up tabs in this spec. Deferred to a future auth spec.
- **Yes:** translate Spanish template strings to English. Required by project-conventions English-only rule.
- **No:** keep Spanish literals. Breaks the repo convention.
- **Yes:** reimplement look with shadcn/ui + Tailwind. Required by your answer and consistent with SPEC 01 stack.
- **No:** port `auth.css` into `src/`. Duplicates styling system and adds dead CSS.
- **Yes:** fully visual form with no auth or submit handling. Same posture as SPEC 01; backend goes in a future spec.
- **No:** local validation logic or redirect-on-submit. Beyond visual scope agreed in Phase 2.
- **Yes:** standalone centered page without `TopBar`. Faithful to Astro `AuthLayout` and simplest layout.
- **No:** render `TopBar` above the card. Adds layout coupling with no benefit now.
- **Yes:** files `src/app/login/page.tsx` + `src/components/auth/sign-in-card.tsx` + `src/components/auth/social-buttons.tsx`. Mirrors template split while respecting kebab-case and `@/` alias.
- **No:** everything inside `page.tsx`. Hurts reuse when signup arrives.
- **Yes:** no tests. Explicitly requested by you and consistent with SPEC 01.

## What is **not** in this spec

- Real login / registration / session logic.
- Input validation beyond native HTML attributes.
- `/signup` or forgot-password pages.
- Social OAuth integration.
- `TopBar` on the login page.
- Port of `auth.css`.
- Tests.

Each one of those, if it lands, goes in its own spec.
