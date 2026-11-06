# SPEC 02 — TypeORM persistence

> **Status:** Implemented
> **Depends on:** SPEC 01
> **Date:** 2026-10-22
> **Objective:** Establish PostgreSQL persistence and application-owned migrations for core using the documented NestJS TypeORM integration.

## Scope

**In:**

- PostgreSQL configuration and a Nest database module using `@nestjs/typeorm`, TypeORM, and `pg`.
- An explicit `core` schema and a standalone migration `DataSource` owned by this package.
- Separate runtime and migration credentials, local usage instructions, and connection lifecycle tests.
- Shared HTTP DTO validation for the catalog specs.
- Compatibility with the existing local server and Lambda bundle.

**Out of scope (for future specs):**

- Catalog entities and tables, introduced by SPEC 04 and SPEC 05.
- AWS provisioning, database role or secret creation, deployment, and a private AWS migration runner.
- Changes to auth's schema, migrations, connection pool, or migration history.

## Data model and configuration

This spec introduces no business entities. All core entities and the migration history table belong to schema `core`.

- Use `POSTGRES_DB_HOST`, `POSTGRES_DB_PORT`, `POSTGRES_DB_NAME`, `POSTGRES_DB_USER`, and `POSTGRES_DB_PASSWORD` for connection settings. Runtime and CLI receive their respective credentials through their own process environment; do not load migration credentials into runtime.
- Use `POSTGRES_SSL_MODE=disable` explicitly for local PostgreSQL. `verify-full` requires `POSTGRES_CA_PATH`, CA loading, and certificate and hostname verification. Reject unsupported modes or incomplete configuration without logging credentials.
- Add `CORE_PG_POOL_MAX`, default `2`, validated as a positive integer. This is a local baseline, not an approved AWS connection budget.
- Use `synchronize: false` and `migrationsRun: false`. Register entities and migrations explicitly rather than relying on filesystem globs that may break in the Lambda bundle.
- Keep migrations in this package, under `src/config/database/migrations/`, and TypeORM history in `core.typeorm_migrations`. Register migration classes explicitly; there are currently no migrations, and this spec must not add an empty baseline. Creating the schema and granting runtime/migrator privileges are operator prerequisites; the application must not bootstrap roles or schemas on startup.
- Runtime credentials must support required catalog DML without DDL. Migration credentials own the required DDL and migration history. AWS identities and grants require a separate reviewed infrastructure contract.

## Implementation plan

1. Add exact compatible versions of `@nestjs/typeorm`, `typeorm`, `pg`, `@nestjs/config`, `class-validator`, and `class-transformer`, plus necessary TypeScript types. Preserve pinned dependencies, ESM imports, and decorator metadata. Verify peer compatibility with the installed Nest version.
2. Add validated database configuration and shared TypeORM options in `src/config/database/`. Use `TypeOrmModule.forRootAsync` in a database module imported by `AppModule`; use a single application-scoped pool, not one per request. Close it through the Nest application lifecycle.
3. Add an explicit standalone `DataSource` and scripts `migration:generate`, `migration:run`, `migration:revert`, and `migration:show`. Support the package's ESM TypeScript workflow. Generation creates reviewable files; application startup never runs them. Do not add an empty baseline migration.
4. Configure a global `ValidationPipe` in the shared application factory with `transform`, `whitelist`, and `forbidNonWhitelisted` enabled. Use explicit field conversions in future DTOs rather than broad implicit conversion. Preserve Nest's standard HTTP error responses.
5. Add a disposable PostgreSQL test setup and document local schema/credential preparation, migration commands, TLS configuration, and runtime shutdown. Update health and Lambda fixtures to provide the database dependency intentionally.
6. Verify TypeORM and the PostgreSQL driver survive the compiled ESM Lambda bundle. Keep one cached Nest application and pool per Lambda execution environment. Add explicit bundler dependency handling only if needed by the installed packages.

The health response remains `200 {"status":"ok"}` after initialization and performs no database query. Introducing the database module makes application startup depend on valid database configuration and connectivity; health is not a readiness probe.

## Acceptance criteria

- [x] Missing configuration, invalid ports/pool sizes, unsupported TLS modes, and missing CA configuration fail with sanitized errors.
- [x] Local PostgreSQL works with explicit TLS disablement; verified TLS sets certificate verification and the configured CA.
- [x] Starting the API does not create or alter tables, run migrations, or use migration credentials.
- [x] CLI and runtime use the same entity/schema configuration while accepting independently supplied credentials.
- [x] Repeated requests and Lambda invocations reuse initialization and the connection pool; closing the test application releases connections.
- [x] The migration `DataSource` uses the `core` schema and `typeorm_migrations` table name, producing the history table `core.typeorm_migrations`; its migration registry is explicit and currently empty, with no filesystem glob or foreign-package migration source.
- [x] Validation rejects unknown input properties and malformed values when exercised by a focused DTO test.
- [x] Type checking, lint, formatting, package tests, build, and final Lambda artifact tests pass with the database dependency represented in fixtures.

## Decisions

- **Yes: Nest modules and injected TypeORM repositories.** Follow the [Nest TypeORM documentation](https://docs.nestjs.com/data/typeorm); avoid a second persistence abstraction or generic repository layer.
- **Yes: explicit migrations.** Entity changes must be reviewable before touching data. Migration generation is not permission to apply a destructive change.
- **Yes: independent core ownership.** Infrastructure already reserves separate core schema and migration contracts; do not reuse auth migration history or credentials.
- **Yes: explicit DTO validation.** Follow the [Nest validation documentation](https://docs.nestjs.com/techniques/validation).
- **No: automatic schema synchronization, startup migrations, cloud deployment, or live database changes in this implementation.**

## Risks

| Risk                                                      | Mitigation                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Dynamic driver or migration loading breaks bundling.      | Register explicit classes and verify the final Lambda artifact.                                                  |
| Database initialization changes existing health fixtures. | Supply the intended test database or controlled injected dependency; retain a real PostgreSQL persistence check. |
| Per-instance pools exhaust a future shared database.      | Keep the initial pool small and require an infrastructure-wide budget before deployment.                         |

## What is **not** in this spec

No AWS resources, credentials or roles are created. No live migration is applied, and no auth persistence code changes.
