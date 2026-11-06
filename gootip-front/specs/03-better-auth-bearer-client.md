# SPEC 03 — Better Auth bearer client for login and signup

> **Status:** Draft
> **Depends on:** SPEC 02
> **Date:** 2026-10-05
> **Objective:** Wire the `/login` page to the Gootip Auth backend with a Better Auth bearer client supporting sign-in and sign-up tabs and an in-memory access token.

## Scope

**In:**

- Install `better-auth` in `gootip-store` with `pnpm add better-auth`.
- Create `src/lib/auth-client.ts` exporting a `createAuthClient` instance configured with `NEXT_PUBLIC_BETTER_AUTH_URL`.
- Add `NEXT_PUBLIC_BETTER_AUTH_URL` to local env and document its prod value as the public application origin (Gateway or `https://auth.midominio.com`, without `/api/auth`).
- Convert `src/components/auth/sign-in-card.tsx` into a client component with `Sign in` / `Sign up` tabs.
- Sign-in form collects `email`, `password`, `remember-me` and calls `signIn.email`.
- Sign-up form collects `name`, `email`, `password` and calls `signUp.email`.
- Fetch the JWT from `GET /api/auth/token` after success and store it in `src/stores/auth.store.ts` without `persist` (memory only).
- Move the current persisted `email` state from `src/stores/auth.store.ts` into a new `src/stores/session.store.ts`.
- Update `src/typings/stores/app.store.ts` with `AuthStore` (token) and `SessionStore` (persisted email) types.
- Show inline English error messages and loading state on `Continue`.
- Redirect to `/` on success and back to `/login` with `Session expired` when the 15-minute token expires.
- Keep `src/components/auth/social-buttons.tsx` visual-only.
- Follow project conventions: kebab-case files, arrow functions, `@/*` aliases, English-only strings, no new `any`/`unknown`.

**Out of scope (for future specs):**

- Real Google/GitHub OAuth wiring.
- Refresh token or silent session renewal.
- Dedicated `/signup` or forgot-password routes.
- Email verification flow (user stays `emailVerified: false`).
- Zod or schema-based validation beyond native HTML plus server errors.
- Persisting the access token in `localStorage` or cookies.
- Server Component session reads.
- Tests.

## Data model

```ts
// AuthStore (memory only, no persist): src/stores/auth.store.ts
// { accessToken: string | null, userId: string | null,
//   email: string | null, isAuthenticated: boolean }

// SessionStore (persisted): src/stores/session.store.ts
// { email: string | undefined }
// Reuses the current persisted shape moved out of auth.store.ts.

// Env
// NEXT_PUBLIC_BETTER_AUTH_URL=https://auth.midominio.com
```

Conventions:

- Client file: `src/lib/auth-client.ts` exporting `authClient`.
- Stores: `src/stores/auth.store.ts` exports `useAuthStore` (no `persist`), `src/stores/session.store.ts` exports `useSessionStore` (with `persist`, key `session`).
- Route stays `src/app/login/page.tsx` (centered card, no `TopBar`).
- English strings: tabs `Sign in` / `Sign up`, submit `Continue`, expired message `Session expired`, footer `No account?`.

## Implementation plan

1. Install `better-auth` via `pnpm add better-auth`. Manual: `pnpm build` compiles.
2. Create `src/lib/auth-client.ts` with `createAuthClient({ baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL })` and a missing-env guard. Manual: `pnpm tsc --noEmit` passes.
3. Add `NEXT_PUBLIC_BETTER_AUTH_URL` to `.env.local` for dev. Manual: the client uses the Gootip Auth origin and resolves its default `/api/auth` base path.
4. Split stores: rewrite `src/stores/auth.store.ts` as in-memory token store, create `src/stores/session.store.ts` with the moved persisted email shape, update `src/typings/stores/app.store.ts`. Manual: `pnpm tsc --noEmit` passes, no `persist` import remains in `auth.store.ts`.
5. Convert `src/components/auth/sign-in-card.tsx` to `'use client'` with `sign-in` / `sign-up` tabs, controlled inputs, `signIn.email` / `signUp.email`, then `GET /token`, storing the JWT in `useAuthStore`. Manual: `pnpm dev --port 3001` shows both tabs, invalid credentials show an inline error, no console errors.
6. Wire `src/app/login/page.tsx` to redirect authenticated users to `/` and expired sessions back to `/login`. Manual: login lands on `/`, waiting past expiry (or clearing the token) shows `Session expired`.
7. Run `pnpm lint`, `pnpm format:check`, `pnpm tsc --noEmit`. Manual: all pass with no new test files.

## Acceptance criteria

- [ ] `pnpm dev --port 3001` with Gootip Auth running shows `/login` with `Sign in` and `Sign up` tabs.
- [ ] Sign-up with `name`, `email`, `password` creates a user with `emailVerified: false` and redirects to `/`.
- [ ] Sign-in with valid credentials stores a JWT in memory and redirects to `/`.
- [ ] Sign-in with wrong credentials shows an inline English error and stays on `/login`.
- [ ] Reloading the page clears the access token (memory only) and prompts login again.
- [ ] Expired token surfaces `Session expired` and navigates to `/login`.
- [ ] `Google` and `GitHub` buttons remain visual-only with no navigation or error.
- [ ] `src/stores/auth.store.ts` has no `persist` import and `src/stores/session.store.ts` holds the persisted email shape.
- [ ] All new UI strings are English.
- [ ] No new test files exist.
- [ ] `pnpm tsc --noEmit`, `pnpm lint`, `pnpm format:check` pass.

## Decisions

- **Yes:** Bearer + JWT with 15-minute expiry and no refresh. Matches the agreed v1; refresh goes in a future spec.
- **No:** cookie session via `useSession`. Avoids third-party cookie failure between store and Gateway domains.
- **Yes:** access token in memory via `useAuthStore` without `persist`. Avoids XSS persistence in `localStorage`.
- **No:** persisting the token. Rejected for the XSS reason above despite surviving reloads.
- **Yes:** move current persisted email config to `session.store.ts`. Keeps existing behavior without mixing it with the token.
- **Yes:** tabs in `/login` instead of a separate `/signup` route. Keeps scope minimal per SPEC 02 follow-up.
- **No:** OAuth in this spec. Requires provider credentials and server changes; deferred.
- **Yes:** client-only session (`'use client'` + store). Avoids fragile cookie/header forwarding in Server Components behind Gateway.
- **Yes:** native JWKS endpoint documented as `/api/auth/jwks`. No `/.well-known/jwks.json` proxy in this spec.

## Risks

| Risk                                             | Mitigation                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `useSession` does not apply to Bearer flow       | Treat `useAuthStore` token as source of truth; use `get-session` with `Authorization` header only |
| 15-minute expiry surprises users                 | Explicit `Session expired` redirect documented as v1 UX                                           |
| `NEXT_PUBLIC_` URL drifts from `BETTER_AUTH_URL` | Single documented value per env; fail fast when missing                                           |

## What is **not** in this spec

- Google/GitHub OAuth.
- Refresh token or silent renewal.
- `/signup` or forgot-password pages.
- Email verification.
- Token persistence.
- Server Component session.
- Tests.

Each one of those, if it lands, goes in its own spec.
