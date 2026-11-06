# SPEC 01 — Initial top bar

> **Status:** Implemented
> **Depends on:** —
> **Date:** 2026-10-04
> **Objective:** Show a visual top bar on web load with hamburger button, search field, and avatar with access dropdown, imported in the home page.

## Scope

**In:**

- Create folder `src/components/layouts/` with component `top-bar.tsx`.
- Top bar with three zones: left visual-only hamburger button, center visual-only search field, right avatar with visual-open dropdown.
- Dropdown with two visible items: "Sign in" and "Sign up", no action or navigation.
- Import and render `TopBar` in `src/app/page.tsx` as first element.
- Style with Tailwind + installed shadcn/ui components and lucide icons.
- Rest of page below bar stays empty.

**Out of scope (for future specs):**

- Real search, filtering, or navigation behavior.
- Authentication, registration, session, or user management.
- Hamburger button action or side menu / drawer.
- New routes, navigation to other screens.
- Tests.
- Page content below the bar.

## Data model

This feature introduces no new data structures. No persisted state, no external props, no new types except local presentational props if needed.

Conventions:

- Alias import `@/components/layouts/top-bar` (`@/*` maps to `src/*` per `tsconfig.json`).
- Proposed placeholder text: `Search products…`.
- Dropdown items: literals `Sign in` and `Sign up`.

## Implementation plan

1. Create `src/components/layouts/top-bar.tsx` with skeleton exporting `TopBar`, no logic. Manual: `pnpm tsc --noEmit` passes.
2. Add bar structure: sticky top `header` with three-zone flex container (left / center / right). Manual: `pnpm dev`, bar visible on top.
3. Add left hamburger button with lucide `Menu` icon, `aria-label="Open menu"`, no handler (visual). Manual: button visible, click neither breaks nor navigates.
4. Add center search field: uncontrolled input with magnifier icon and placeholder `Search products…`, no submit or handler. Manual: typing text triggers nothing and no console errors.
5. Add right account menu: avatar with dropdown opening/closing visually (local state or shadcn `DropdownMenu`) with `Sign in` and `Sign up` items and no action. Manual: dropdown opens/closes, item clicks neither navigate nor authenticate.
6. Update `src/app/page.tsx` to render `<TopBar />` first and leave rest empty. Manual: `/` shows bar on top and empty lower area, no console errors.

## Acceptance criteria

- [ ] `pnpm dev` and opening `/` shows top bar with left hamburger, center search, right avatar.
- [x] Click on avatar opens dropdown with exact texts `Sign in` and `Sign up`.
- [ ] Click on dropdown items navigates nowhere and produces no console error. **Not met:** both items link to `/login`.
- [ ] Typing in search neither filters, nor navigates, nor produces console error. (Not manually verified.)
- [ ] Click on hamburger neither navigates nor produces console error. (Not manually verified.)
- [x] Code lives in `src/components/layouts/` and is imported in `src/app/page.tsx` via `@/` alias.
- [x] No new test files and no new routes exist.
- [x] `pnpm tsc --noEmit` passes without errors.

## Decisions

- **Yes:** dropdown with visual open but inert items. Respects your answer and avoids auth in this spec.
- **No:** 100% static dropdown. Open/close gives visual feedback at no cost.
- **Yes:** visual-only hamburger with lucide `Menu` icon. Drawer goes in future spec.
- **No:** empty drawer in this spec. Agreed minimal scope.
- **Yes:** path `src/components/layouts/top-bar.tsx`, import `@/components/layouts/top-bar`. Fixes `@/src/...` because `@/*` already points to `src/*`.
- **No:** split into 3+ files. Small spec; single file avoids over-engineering. Split when bar grows.
- **Yes:** sticky bar with Tailwind + shadcn + lucide. Consistent with repo stack.
- **No:** pixel-perfect design now. Fine visual detail goes in later UI spec.
- **Yes:** placeholder `Search products…`. Concrete proposal; changing literal does not break spec.
- **No:** tests or navigation. Explicitly excluded by you.

## What is **not** in this spec

- Functional search.
- Functional login / registration.
- Hamburger action or side menu.
- Navigation to other screens.
- Tests.
- Content below the bar.

Each one of those, if it lands, goes in its own spec.
