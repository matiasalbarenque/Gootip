# SPEC 01 — NestJS base for AWS Lambda

> **Status:** Approved
> **Depends on:** None
> **Date:** 2026-10-21
> **Objective:** Create the minimal `gootip-core` structure as a NestJS API that runs locally and can be packaged as an AWS Lambda event handler.

## Why this spec exists

`gootip-core` is empty. It needs a verifiable foundation before adding business routes, authentication, or infrastructure. The build and formatting configuration in `gootip-auth` is the reference, but `gootip-core` will be an independent package.

## Scope

**In:**

- `gootip-core` project with `pnpm@12.14.0`, Node.js 24, strict TypeScript, NestJS, and `@nestjs/platform-express`.
- `oxfmt` configuration based on `gootip-auth/.oxfmtrc.json`, plus `oxlint`, Vitest, and development, build, and verification scripts.
- One Nest application shared by the local HTTP server and the Lambda handler, with a global `/api` prefix.
- Single functional route `GET /api/health`, with no external dependencies, returning HTTP 200 and `{"status":"ok"}`.
- Self-contained ESM build at `dist/lambda.mjs` and a ZIP containing only that file, following the packaging contract in `gootip-auth`.
- Focused tests for local HTTP, API Gateway HTTP API payload v2 events, and ZIP contents.
- Usage documentation in `gootip-core/README.md` and an update to the `gootip-core` row in the root `README.md`.
- Project conventions: kebab-case paths, exact pinned dependency versions, `.js` suffixes on local ESM imports, and English-only code, tests, and docs.

**Out of scope (for future specs):**

- Terraform, API Gateway, Lambda creation or deployment, and IAM permissions.
- `gootip-auth` integration, JWT validation, guards, and authorization; `/api/health` is public by design.
- Database, ORM, secrets, business routes, DTOs, Swagger, CORS, and rate limiting.
- Optimization based on an HTTP adapter other than Express or on Lambda Web Functions.

## Data model

This base introduces no persistent data or domain models. The only response contract is `GET /api/health` → HTTP 200 with JSON `{"status":"ok"}`. Unknown routes return HTTP 404.

## Expected files

- Manifest, lockfile, and configuration: `gootip-core/package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.oxfmtrc.json`, `.gitignore`.
- Application: `gootip-core/src/app.module.ts`, `src/app.ts`, `src/server.ts`, `src/lambda.ts`, `src/modules/health/health.controller.ts`.
- Build and packaging: `gootip-core/scripts/build-lambda.mjs`, `scripts/package-lambda.mjs`.
- Tests: `gootip-core/test/health.spec.ts`, `test/lambda.spec.ts`, `test/package-lambda.spec.ts`.
- Documentation: `gootip-core/README.md` and the root `README.md`.

## Implementation plan

1. Create the independent package with exact pinned dependency versions and TypeScript configuration for decorators (`experimentalDecorators` and `emitDecoratorMetadata`). Add `dev`, `build`, `start`, `build:lambda`, `lambda:zip`, `typecheck`, `lint`, `format:check`, and `test` scripts. Verify that dependency installation and type checking of the skeleton pass.
2. Create `AppModule`, `createApp()`, and `HealthController`; apply `/api` as the global prefix. Add `src/server.ts` to listen on `PORT`, defaulting to `3001` so it does not occupy `gootip-auth`'s usual local port. Verify over HTTP that `/api/health` returns 200 and an unknown route returns 404.
3. Create `src/lambda.ts` with `@codegenie/serverless-express`, export `handler`, and cache the Nest initialization promise across invocations. Test an API Gateway HTTP API payload v2 event without starting a TCP server.
4. Create the Lambda build: compile with TypeScript first to preserve decorator metadata, then bundle with esbuild as ESM for Node.js 24 into `dist/lambda.mjs`, with `keepNames` and no sourcemap. Verify that the bundle exports `handler`.
5. Create a reproducible `lambda.zip` containing only `dist/lambda.mjs` and document the contract for future infrastructure: runtime `nodejs24.x`, architecture `arm64`, handler `dist/lambda.handler`. Add the ZIP content test, complete the README, and run the focused checks.

Each step must leave an executable or verifiable state and can be committed separately. Neither `dist/` nor `lambda.zip` is committed.

## Acceptance criteria

- [x] `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` finish without errors inside `gootip-core`.
- [x] The local server responds to `GET /api/health` with HTTP 200 and exactly `{"status":"ok"}`; an unknown route responds with HTTP 404.
- [x] The `handler` responds to the HTTP API payload v2 event for `GET /api/health` with HTTP 200 and the same JSON.
- [x] Two sequential handler invocations reuse the Nest initialization.
- [x] `pnpm build:lambda` generates `dist/lambda.mjs` with a `handler` export and `pnpm lambda:zip` generates `lambda.zip` with that file as its only entry.
- [x] The documentation explains local execution, checks, packaging, and the contract expected by future infrastructure.
- [x] This implementation does not modify `gootip-auth` or `gootip-infra` and does not provision AWS resources.

## Decisions

- **Yes: Lambda event handler + API Gateway HTTP API.** This allows a JWT authorizer to be planned in front of the function later. The integration and its configuration are outside this spec.
- **Yes: `@nestjs/platform-express`.** It is the standard HTTP adapter documented by Nest and lets the same module serve local HTTP and Lambda. [Nest first steps](https://docs.nestjs.com/first-steps), [Nest serverless](https://docs.nestjs.com/faq/serverless).
- **No: `@nestjs/platform-node` for now.** There is no officially published package with that name or a documented integration for this case. If a stable option appears, evaluate it with latency and compatibility measurements in another spec; do not assume that changing the adapter will speed up requests.
- **No: Lambda Web Functions in this base.** The HTTP API decision preserves the authorization point before Lambda; Web Functions would require revisiting that design.
- **Yes: single ESM bundle and minimal ZIP.** It replicates the delivery interface in `gootip-auth` and reduces deployed files. Compiling decorators with TypeScript before esbuild avoids losing their metadata.
- **No: authentication guard at this stage.** The only route is health; protected routes will be designed together with the authorizer. API Gateway validates the signature and claims using the issuer's `jwks_uri`, so the discovery/JWKS compatibility of Better Auth must be tested before adding protected routes. [AWS JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

## Risks

| Risk                                                                           | Mitigation                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Bundling alters decorator metadata or Nest's dynamic dependencies.             | Compile with `tsc` before esbuild and run a test against the final bundle in addition to the test against the sources.    |
| Nest + Express cold start does not meet future latency targets.                | Measure with a deployed Lambda once infrastructure exists; this spec does not promise an improvement without a benchmark. |
| The `gootip-auth` JWT is not accepted directly by the HTTP API JWT authorizer. | Verify discovery, `jwks_uri`, algorithm, issuer, and audience in the authentication spec before protecting routes.        |

## What is **not** in this spec

It does not create AWS infrastructure, connect auth or data, or add business endpoints. Those decisions will be developed in separate specs.
