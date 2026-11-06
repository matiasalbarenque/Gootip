# gootip-auth

Hono authentication API using Better Auth, PostgreSQL, Vitest, Oxlint, and
Oxfmt. It supports a local Node server and AWS Lambda.

## Commands

- `pnpm install`: install dependencies.
- `../gootip-infra/scripts/local_postgres.sh bootstrap`: start and provision shared local PostgreSQL.
- `../gootip-infra/scripts/local_postgres.sh migrate`: apply reviewed local auth and core migrations.
- `../gootip-infra/scripts/local_postgres.sh migrate`: apply the reviewed local auth and core migration sets.
- `pnpm auth:migrate`: run the Better Auth CLI directly for isolated schema work only; do not use it for the normal shared development database.
- `pnpm auth:check`: validate the live Better Auth schema.
- `pnpm dev`: run the local API with reload.
- `pnpm build && pnpm start`: compile and run the Node server.
- `pnpm build:lambda && pnpm lambda:zip`: build the Lambda artifact.
- `pnpm test`: run unit and HTTP tests.
- `pnpm test:integration:migrations` / `pnpm test:integration:runtime`: run an individual shared-database auth integration suite; prefer the serial infra integration command.
- `pnpm typecheck`: run TypeScript without emitting files.
- `pnpm lint`: run Oxlint.
- `pnpm format` / `pnpm format:check`: write or check Oxfmt formatting.

## Architecture

- `src/app.ts`: runtime-neutral Hono routes and CORS.
- `src/auth/auth.ts`: Better Auth and PostgreSQL configuration.
- `src/auth/auth.cli.ts`: Better Auth CLI entry point.
- `src/config/env.ts`: environment validation.
- `src/server.ts`: local Node entry point.
- `src/lambda.ts`: AWS Lambda entry point and Secrets Manager loading.
- `test/`: Vitest unit and HTTP tests.

## Conventions

Follow `.agents/skills/project-conventions/SKILL.md`. In particular, use
kebab-case paths, arrow functions, strict types, `.js` local import suffixes,
and English-only code, tests, logs, and documentation.

Do not add NestJS, Express, TypeORM, or automatic startup migrations. Do not
modify the public `/api/auth/*` contract without updating tests and README.
