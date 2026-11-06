---
name: project-conventions
description: Enforce project conventions for the gootip-auth TypeScript API. Use when editing Hono routes, Better Auth configuration, environment handling, Lambda code, helpers, tests, or API strings.
---

# Project conventions

Mandatory rules for code and tests in this repository.

## Files and structure

- Use kebab-case for every file and directory.
- Keep Better Auth configuration under `src/auth/`.
- Keep environment parsing under `src/config/`.
- Keep the framework-neutral Hono app in `src/app.ts`.
- Keep runtime entry points separate in `src/server.ts` and `src/lambda.ts`.
- Place tests in `test/` with the `*.spec.ts` suffix.

## TypeScript

- Use strict TypeScript and ESM imports with `.js` suffixes for local modules.
- Use arrow functions for helpers, handlers, callbacks, and exported functions.
- Avoid `any`. Use `unknown` only at untrusted boundaries and narrow it immediately.
- Prefer small dependency-injected factories when they make behavior testable without network or database access.
- Do not introduce classes unless a library API requires one.

## Hono and Better Auth

- Keep `/api/auth/*` aligned with Better Auth's default `basePath`.
- Register CORS before the Better Auth handler.
- Forward the raw web request with `auth.handler(context.req.raw)`.
- Use one Better Auth instance and one PostgreSQL pool per Node process or Lambda cold start.
- Never run database migrations during application startup.
- After changing plugins or Better Auth schema options, review the generated SQL and apply the committed migration through `../gootip-infra/scripts/local_postgres.sh migrate`.
- Do not disable CSRF or origin checks.

## Dependencies

- Pin every `dependencies` and `devDependencies` entry in `package.json` to an
  exact version.
- Never use version ranges such as `^`, `~`, `latest`, or `*`.
- Regenerate `pnpm-lock.yaml` with `pnpm install` after changing dependency
  versions.
- Keep the Better Auth runtime and `auth` CLI on the same exact version.

## Language and security

- Use English for code comments, errors, logs, API responses, tests, and documentation committed to this project.
- Never log secrets, passwords, session tokens, JWTs, or private keys.
- Keep `.env` files out of version control.
- Validate all environment variables before creating Better Auth or opening database connections.

## Verification

Before finishing a change, run:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm format:check`
5. `pnpm build`

Confirm that `package.json` contains no dependency version ranges before
finishing dependency-related changes.

Run `pnpm build:lambda` when Lambda code or dependencies change.
