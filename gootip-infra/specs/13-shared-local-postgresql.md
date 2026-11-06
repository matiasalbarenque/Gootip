# SPEC 13 — Shared Local PostgreSQL for Development and Tests

> **Status:** Implemented
> **Depends on:** SPEC 03, SPEC 04, SPEC 05, SPEC 12
> **Date:** 2026-10-29
> **Objective:** Run auth, core, and database-configuration tests against one persistent local PostgreSQL 18 Alpine container with isolated development and test databases and roles.

## Why this spec exists

Local auth currently starts `postgres:18` on port `5433` through
`gootip-auth/docker-compose.yml`. Core starts `postgres:18-alpine` on port
`54329` through `gootip-core/compose.test.yaml`. The latter is a test fixture,
not a shared development database. Database-configuration integration tests
also create their own temporary PostgreSQL container.

Both applications already select their schemas explicitly. Better Auth uses
`auth`; TypeORM uses `core`. One database with both schemas better represents
the intended dev topology. Local restricted roles also expose permission
errors that auth's current local superuser can hide.

The user chose to recreate both existing local databases from migrations.
Existing local users, sessions, catalog data, and test records will not be
imported. This decision applies only to the two identified local containers.
It does not authorize deleting AWS data or unrelated Docker volumes.

## Scope

**In:**

- One canonical Compose file at `gootip-infra/compose.local.yaml`.
- Image `postgres:18-alpine`, Compose project `gootip-local`, service
  `postgres`, and host binding `127.0.0.1:5433:5432`.
- A named persistent volume mounted at `/var/lib/postgresql`.
- Database `gootip`, schemas `auth` and `core`, and separate runtime and
  migration roles for each service.
- Explicit local provisioning and migration commands, separate from API startup.
- Integration-test adaptation for auth, core, and gootip-db-config so no suite
  starts another PostgreSQL container.
- Separate test databases and cluster-wide test-role namespaces.
- Repeatable test setup and cleanup that preserve development data and grants.
- A documented local cutover from the two existing containers.
- Updated connection examples, test commands, and troubleshooting instructions.

**Out of scope:**

- Terraform resources, AWS credentials, RDS changes, IAM, networking, deployments,
  secret values, or remote database access.
- Preserving or importing the current local database contents.
- New business tables, application features, or automatic startup migrations.
- Changing deployed role names or making production role names configurable
  for the convenience of local tests.
- Rewriting CI from SPEC 11, introducing a workspace, or changing dependencies.
- Exact RDS emulation, local TLS infrastructure, performance benchmarks,
  concurrent integration runs, or automatic image updates.

## Data model and integration contracts

### Development database

| Database | Schema | Owner / migration login | API login      |
| -------- | ------ | ----------------------- | -------------- |
| `gootip` | `auth` | `auth_migrator`         | `auth_runtime` |
| `gootip` | `core` | `core_migrator`         | `core_runtime` |

Both applications use host `127.0.0.1`, port `5433`, database `gootip`, and
`POSTGRES_SSL_MODE=disable`. Each API receives only its runtime credential.
Migration credentials are supplied only to explicit migration processes.

Runtime roles have no superuser, database-creation, role-administration,
replication, or bypass-RLS privileges. They cannot assume migration roles.
Each runtime can use only its own application schema and required DML.
Neither runtime can create or alter application objects or write migration
history. Migration roles own only their respective schemas and objects.
Default privileges cover tables and sequences created by each migrator.
Reconciliation must preserve migration-history restrictions after broad grants.

The administrative local login is reserved for provisioning and test setup.
It must not be configured as an API or application-migration login.
Local credentials are disposable development values; no AWS secret is read.
Actual local values stay outside tracked infra files and documentation.
The local environment example lists variable names and placeholders only.

No new business data structures are introduced. Reuse the committed auth SQL
ledger and TypeORM migrations. Preserve `auth.gootip_schema_migrations` and
`core.typeorm_migrations` as separate histories. Local auth initialization
must record the same applied SQL IDs and checksums expected by the existing
runner; the Better Auth CLI must not create an untracked substitute baseline.

### Container lifecycle and persistence

Use project-scoped named volume `postgres_data`. Ordinary stop, restart, and
Compose down commands preserve it. There is no automatic volume reset on
startup, migration failure, or test failure.

PostgreSQL 18 uses `/var/lib/postgresql/18/docker` as its default `PGDATA`.
Mounting the parent `/var/lib/postgresql` preserves the actual database files.
The current auth bind mount `/var/lib/postgresql18/data` does not cover that
directory; inspect the old container's actual mounts during cutover.

Health checks establish PostgreSQL readiness before provisioning. Schema and
role provisioning is an explicit repeatable operation, including when the
volume already exists. Do not rely solely on first-start entrypoint SQL.
Provisioning reasserts expected local grants without dropping application data.
Missing credentials or a failed migration produces a bounded actionable error
and leaves the volume available for correction.

### Test isolation

| Suite                              | Database                      | Test role prefix        |
| ---------------------------------- | ----------------------------- | ----------------------- |
| Auth migration integration         | `gootip_test_auth_migrations` | `test_auth_migrations_` |
| Auth runtime integration           | `gootip_test_auth_runtime`    | `test_auth_runtime_`    |
| Core integration                   | `gootip_test_core`            | `test_core_`            |
| Database-configuration integration | `gootip_test_db_config`       | `test_db_config_`       |

Schemas keep their actual names `auth` and `core` inside the test databases.
Runtime, migrator, operator, and master-like fixture roles use their suite's
prefix. Additional databases used by bootstrap tests remain under
`gootip_test_db_config_`. Database separation alone is insufficient because
PostgreSQL roles exist across the entire cluster.

Adapt fixed-role test fixtures at the test boundary. For Python, construct
test `Config` instances with namespaced role fields and matching fixture
credentials. For auth, adapt fixture SQL and test-only mocks or injected
dependencies where the runtime loader validates the fixed deployed username.
Retain separate assertions that the production loader accepts only
`auth_runtime` and rejects invalid identities. No production environment
override for deployed role names is added.

Test setup validates the local endpoint, an exact allowlist of owned test
databases, and its role prefix before any destructive SQL. Reject `gootip`,
remote endpoints, unexpected names, and missing configuration. Cleanup drops
only the suite's disposable databases and roles after closing its pools.
It never stops the shared container or removes its volume.

Suites run serially through the documented integration command. A repeated
run safely handles remnants of an interrupted run within those same names.
Existing tests for genuine lock contention still run their internal concurrent
connections. A requested integration run fails when PostgreSQL is unavailable;
the unit-only commands remain runnable without Docker.

### Files affected

| Path                                                                                                                                         | Change                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `gootip-infra/compose.local.yaml`                                                                                                            | Canonical shared PostgreSQL service and volume                                                   |
| `gootip-infra/local/postgres.env.example`                                                                                                    | Local configuration names and placeholders                                                       |
| `gootip-infra/local/postgres.env`                                                                                                            | Ignored operator-created local values                                                            |
| `gootip-infra/scripts/local_postgres.sh`                                                                                                     | Small explicit provisioning, migration, serial integration, and guarded test-cleanup entry point |
| `gootip-infra/local/postgres_bootstrap.sql`                                                                                                  | Local development roles, schemas, ownership, and grants                                          |
| `gootip-infra/.gitignore`                                                                                                                    | Ignore local credentials and any local database artifacts                                        |
| `gootip-auth/docker-compose.yml`                                                                                                             | Retire the independent database definition                                                       |
| `gootip-auth/.env.template`, `README.md`, `AGENTS.md`                                                                                        | Shared endpoint, runtime login, explicit migration credentials, and canonical commands           |
| `gootip-auth/package.json`, `vitest.config.ts`, `test/fixtures.ts`, `test/migration-integration.spec.ts`, `test/runtime-integration.spec.ts` | Shared-server integration setup, namespaced fixtures, and explicit test execution                |
| `gootip-core/compose.test.yaml`, `test/postgres-init.sql`                                                                                    | Retire the independent test database definition and move required setup into the shared workflow |
| `gootip-core/vitest.config.ts`, `test/categories.integration.spec.ts`, `test/products.integration.spec.ts`, `package.json`, `README.md`      | Isolated test database and roles, shared endpoint, and canonical commands                        |
| `gootip-db-config/tests/integration/conftest.py`, integration assertions, `README.md`                                                        | Replace Docker container lifecycle with isolated database/role lifecycle                         |
| `README.md`, `gootip-infra/README.md`                                                                                                        | One local database workflow, cutover, reset boundaries, and troubleshooting                      |

Production auth/core database selection and the deployed administrative
configuration remain unchanged. Keep helpers small and reuse existing
migration code instead of adding another migration engine.

## Implementation plan

1. Add the shared Compose definition, placeholder configuration, persistent
   volume, readiness check, and explicit development bootstrap operation.
   Verify the fresh database and role ownership without switching running APIs.
2. Add explicit migration orchestration using the reviewed auth SQL and history
   contract plus the existing core CLI. Verify a second invocation applies
   nothing and runtime credentials cannot perform DDL or write histories.
3. Adapt auth integration fixtures and commands to their isolated databases and
   namespaced roles. Exercise the real PostgreSQL client and preserve fixed
   production-identity validation coverage.
4. Adapt core and database-configuration integration fixtures. Remove per-suite
   container creation and teardown. Add the guarded serial integration entry
   point and verify that cleanup leaves a development sentinel intact.
5. Cut over the local workstation after closing API and test connections.
   Identify and stop only `gootip-auth` and `gootip-core-postgres-1` so port
   `5433` is free. Create the new shared database from migrations and switch
   both APIs to their runtime credentials. The old containers and volumes
   remain available if initialization fails; their contents are not imported.
6. Retire the package Compose definitions and update all active startup and
   test instructions. After successful application and integration checks,
   remove the two identified stopped containers without volume-removal flags.
   Leave their old volumes untouched for separate explicit cleanup.

## Acceptance criteria

- [x] The canonical Compose starts exactly one project PostgreSQL service with
      image `postgres:18-alpine` and host binding `127.0.0.1:5433:5432`.
- [x] Both APIs connect to database `gootip` through their separate runtime
      roles and use only `auth` and `core`, respectively.
- [x] All committed application migrations apply to a fresh volume; repeating
      migration commands leaves both histories unchanged.
- [x] Both schemas have the expected migrator owners and required default
      privileges for newly created application objects.
- [x] Runtime DDL, cross-service schema access, migration-role assumption, and
      migration-history writes are denied.
- [x] Restarting PostgreSQL and ordinary Compose down/up preserve a development
      sentinel and migration history.
- [x] Auth, core, and database-configuration integration checks pass against the
      shared server without creating another PostgreSQL container.
- [x] Test cleanup and a repeated integration run preserve development data,
      ownership, passwords, grants, and migration histories.
- [x] Destructive test setup rejects `gootip`, unexpected database/role names,
      and a remote endpoint before executing destructive SQL.
- [x] An explicitly requested integration run fails clearly when the shared
      server is unavailable; unit-only commands need no Docker server.
- [x] Focused format, lint, type checks, and tests pass for changed packages;
      the complete relevant verification runs once before handoff.
- [x] The two old containers are removed only after successful cutover, with
      no deletion of old volumes, AWS resources, or unrelated containers.
- [x] Current local instructions use the canonical Compose; no active test
      fixture or documented primary workflow starts another PostgreSQL server.

## Acceptance validation — 2026-10-29

All acceptance criteria are closed. The evidence below includes the initial
audit and the follow-up that resolved its pending items.

### Verified evidence

- Docker reports only `gootip-local-postgres-1`, using `postgres:18-alpine`,
  healthy and bound to `127.0.0.1:5433`. The old container names are absent.
  The canonical Compose mounts `postgres_data` at `/var/lib/postgresql`.
- Auth's actual pool queried `auth."user"` as `auth_runtime` in `gootip`, and
  its Hono app returned HTTP 200 for `get-session`. The compiled Core app
  returned HTTP 200 for categories and products using `core_runtime` in
  `gootip`. Neither smoke check inserted application records.
- Repeated `local_postgres.sh migrate` reported current auth migrations and
  no pending TypeORM migrations. History, schema ownership, default privileges,
  and object grants had identical before/after digests. Its eight negative
  runtime checks rejected DDL, migration-history writes, migration-role
  assumption, and cross-service table access.
- Transactional probes created a table and identity sequence under each
  migrator. The corresponding runtime inherited table DML and sequence access.
  The transaction was rolled back.
- Restart and ordinary Compose down/up preserved a development sentinel and
  identical history, role-credential, ownership, and grant digests. The
  validation sentinel was removed after the successful check. No volume was
  deleted.
- Two serial integration runs each passed 12 Auth migration tests, 7 Auth
  runtime tests, 20 Core tests, and 22 database-configuration tests. No second
  database container was created. The workflow's development sentinel survived
  cleanup. Before/after snapshots around the second run also preserved the
  development role credentials, ownership, grants, and histories.
- While Compose was down, the explicit integration command failed with
  `Shared PostgreSQL is unavailable`. PostgreSQL was restored afterward.
- Auth typecheck, lint, format, and unit checks passed: 230 tests passed and
  19 integration cases were skipped in the unit invocation, then exercised by
  the explicit integration runs. Core typecheck, lint, format, build, and
  42 unit tests passed. Database-configuration lint, format, and 72 unit tests
  passed. Infra `scripts/verify_full.sh` passed Terraform validation, 135 pure
  tests with 29 subtests, IAM guardrails, policy-union comparison, and the
  materialization test. No live AWS command or apply was performed.
- The initial Core format check found formatting in SPEC 06. Only that
  document's formatting was normalized, and the Core format check then passed.

Local validation logs are under `/tmp/spec13-*.log`; these are temporary
workstation evidence, not committed artifacts. State snapshots contain only
digests and schema-owner names, not credential values.

### Closure follow-up — 2026-10-29

- **Fresh-volume initialization passed:** the normal Compose service was stopped
  without removing its volume. An isolated temporary copy of the canonical
  Compose configuration selected a newly created named volume while keeping
  the same project, image, service, port, bootstrap SQL, and migration commands.
  Only one project PostgreSQL container was active at a time. Bootstrap and
  all committed migrations succeeded from empty storage. A repeated migration
  run left histories, owners, default privileges, and effective grants unchanged.
- **First-run grant consistency fixed:** the rehearsal found that Auth history
  SELECT was absent immediately after initial migration but granted by the
  next bootstrap. The local migration command now grants that existing
  read-only contract on the first run as well. Runtime DML and DDL restrictions
  remain enforced. ACL comparisons normalize individual privileges rather than
  relying on internal array order. SCRAM hashes change when bootstrap reasserts
  the same passwords, so migration idempotence compares histories and effective
  privileges rather than requiring equal salted password hashes.
- **Core guards implemented and tested:** `test/local-postgres.ts` validates the
  exact host, port, database, runtime identity, TLS setting, and required test
  credentials before any integration fixture or connection is initialized.
  All five database-backed test files call it. Thirteen new unit cases cover
  valid configuration and unsafe or missing values. Actual integration-command
  probes for `gootip` and a remote hostname failed at the guard before connecting.
  Typecheck, lint, format, and all 55 Core unit tests passed.
- **Shared integration passed on fresh storage:** 12 Auth migration tests,
  7 Auth runtime tests, 20 Core tests, and 22 database-configuration tests passed.
  Cleanup preserved the development sentinel and did not start another server.
- **Normal development storage restored and preserved:** after the rehearsal,
  the canonical service again mounted `gootip-local_postgres_data`. A normalized
  full development database dump had the same SHA-256 before and after the
  rehearsal. History, role-credential, ownership, default-privilege, and
  effective-grant snapshots also matched. No pre-existing volume was deleted.
  Only volumes created by this rehearsal were removed after restoration checks.
- **Documentation corrected:** `gootip-db-config/README.md` now documents the
  shared server, allowlisted resources, unit-only checks, and explicit failure
  behavior. Active package instructions and test fixtures no longer prescribe
  the old temporary PostgreSQL workflow.
- **Historical cutover criterion:** checked at the user's explicit direction
  on 2026-10-29. The old containers are absent; the original removal order was
  not reconstructed. Current storage-preservation checks are recorded above.
- **Verification reuse:** the unchanged Auth and Python checks and full offline
  infra verification from the initial audit remain valid. The changed Core
  fixtures were checked and tested again; the changed local migration shell
  passed syntax validation and the fresh-volume end-to-end rehearsal.

This closes the local-only contract. No AWS operation or deployment was needed.

## Decisions

- **Yes:** recreate both local databases from committed migrations. The user
  explicitly chose this over backup and restore.
- **Yes:** keep Compose under `gootip-infra`, not the monorepo root. This is the
  user-selected home for the shared local infrastructure contract.
- **Yes:** use one container for development and all three packages' tests.
  Separate test databases and roles prevent destructive fixture collisions.
- **Yes:** keep database `gootip`, localhost port `5433`, and four development
  application roles. These were confirmed during definition.
- **Yes:** use `postgres:18-alpine` as requested. The major-version tag can move
  between minor/image releases and does not guarantee exact RDS patch parity.
- **Yes:** preserve old volumes during cutover. Recreating application contents
  does not require deleting the old storage to complete this work.
- **No:** share development roles with tests. Password changes and role drops
  affect the whole cluster even when databases differ.
- **No:** change production identity validation or introduce production role
  configurability to simplify test fixtures.
- **No:** bootstrap through automatic API startup or run migrations as an API
  superuser. Explicit commands preserve the existing deployment separation.

## Risks

| Risk                                                                           | Mitigation                                                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Existing local users and catalog records disappear from the active environment | Record the explicit recreate decision; retain old volumes without importing them                   |
| Old auth data lives outside its apparent bind mount                            | Inspect actual container mounts; never infer storage ownership from the Compose bind alone         |
| Test role changes affect development or another suite                          | Use suite-specific role namespaces, exact cleanup guards, and serial suite execution               |
| An interrupted test leaves objects or connections behind                       | Close pools and retry only guarded cleanup of the suite's exact resources                          |
| New grants accidentally reopen migration-history writes                        | Verify both existing-object and future-object privileges and reassert history restrictions         |
| The current auth server already occupies port 5433                             | Stop the identified old container during cutover and report unrelated port ownership as a conflict |
| A shared PostgreSQL outage stops both APIs and integration tests               | Provide one readiness check and actionable startup diagnostics; preserve the volume on failure     |

## References

- [Official PostgreSQL Docker image and PostgreSQL 18 storage layout](https://hub.docker.com/_/postgres).
- [SPEC 03 — Administrative bootstrap](03-postgres-administrative-bootstrap.md).
- [SPEC 04 — Auth migrations](04-private-postgres-migrations.md).
- [SPEC 05 — Runtime credentials](05-authentication-runtime-credentials.md).
- [SPEC 12 — RDS PostgreSQL 18](12-rds-postgresql-18-upgrade.md).

## What is **not** in this spec

- AWS changes, deployments, live secret access, or remote database resets.
- Backup/restore or import of the current local application data.
- Old-volume deletion, arbitrary Docker cleanup, or automatic destructive reset.
- Business features, new application schemas, CI redesign, or local RDS TLS emulation.
