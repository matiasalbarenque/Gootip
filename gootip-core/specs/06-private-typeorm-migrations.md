# SPEC 06 — Private TypeORM migrations

> **Status:** Implemented
> **Depends on:** Core SPEC 02, SPEC 04, SPEC 05; Infra [SPEC 13](../../gootip-infra/specs/13-shared-local-postgresql.md)
> **Date:** 2026-10-29
> **Objective:** Execute reviewed Core TypeORM migrations through a dedicated private Lambda with isolated credentials and a verifiable manual deployment contract for dev.

## Why this spec exists

Core owns its TypeORM migrations but has no private AWS migration executor.
The API must retain `synchronize: false` and `migrationsRun: false`.
Ordinary GitHub-hosted runners do not have connectivity to the project's private RDS instance.

Follow Auth's separation between the API and its migration executor.
Reuse TypeORM for migration execution and history instead of copying Auth's custom SQL engine.
Lambda is a project architecture decision, not a TypeORM requirement.

The administrative Lambda `lambda_db_config` is already deployed and active.
Its existing bootstrap provisions Auth database identities and the `auth` schema;
it does not yet provision Core's roles, schema, or credential references.
A separate specification must define the Core extension to that existing
administrative bootstrap before this spec's AWS validation can complete.
This prerequisite does not require a second administrative Lambda.
That extension spec does not exist at the time of writing, so this document
does not assign it a speculative number or mark it implemented.

## Scope

**In:**

- A migration handler, execution protocol, tests, build, and separate ZIP inside `gootip-core/`.
- Reuse of TypeORM 1.1.2, the explicit migration registry, and `core.typeorm_migrations`.
- `validate` and `apply` operations with artifact identity and structured results.
- One transaction for all pending migrations.
- Database locking, bounded execution, safe cleanup, and uncertain-result reconciliation.
- Dedicated Lambda, IAM role, security group, log group, and deployment alias in `gootip-infra/`.
- Narrow extensions to existing bootstrap-owned deployment permissions and boundaries for these resources.
- Manual deployment and validation in dev after the administrative prerequisites exist.
- Documentation of the contract a future deployment pipeline must consume.

**Out of scope (for future specs or other projects):**

- Provisioning database roles, the `core` schema, credential containers or values, and administrative privilege reconciliation.
- Implementing or deploying the Core API, API Gateway integration, or a GitHub Actions pipeline.
- Changing Auth's executor, permissions, migrations, or database objects.
- Adopting existing tables into history, fake migrations, automatic rollback, or history repair.
- Arbitrary SQL supplied in events, schema synchronization, and migration generation against AWS.
- Destructive migrations, nontransactional DDL, long backfills, staging, and production deployment.
- A shared Auth/Core migration package or a new migration framework.

## Prerequisites and ownership

Infra SPEC 13 must be implemented before implementation of this spec starts.
Reuse its canonical `gootip-infra/compose.local.yaml`, PostgreSQL 18 Alpine server,
and guarded test setup instead of introducing another database container.
Local development and tests against disposable databases inside that shared server
can proceed without AWS bootstrap completion.
SPEC 13 provisions local prerequisites only; it does not satisfy the AWS
administrative-bootstrap handoff below.
AWS deployment and invocation require an explicit handoff from the separately
reviewed Core extension to the existing administrative bootstrap.

Verification on 2026-10-29 confirmed `lambda_db_config` is `Active` in
`us-east-2`, last modified on 2026-10-21. Its AWS `CodeSha256` matches the local
`gootip-db-config/lambda.zip`. The packaged configuration fixes the application
roles to `auth_runtime` and `auth_migrator`, the operator to
`gootip_dev_operator`, and `APPLICATION_SCHEMAS` to `("auth",)`.
This verifies the deployed bootstrap's current scope, not the live existence or
absence of manually created Core database objects. Verify the live Core
prerequisites before planning any administrative change.

Migration integration tests use SPEC 13's `gootip_test_core` database and
`test_core_` role namespace through its serial integration workflow.
Never run destructive fixture setup against development database `gootip`,
reuse development role credentials, or stop the shared container during cleanup.
Reuse the exact database/role guards and interrupted-run cleanup from SPEC 13.
Test-only injection supplies namespaced identities to the runner; the deployed
credential and preflight contract remains fixed to `core_migrator`.
Keep coverage that rejects an unexpected deployed identity.

Register `test/migration-integration.spec.ts` in Core's `test:integration` command
and exclude it explicitly in `scripts/test-unit.mjs`.
Keep `test:unit` runnable without PostgreSQL, Docker, or AWS credentials.
Any artifact tests that connect to PostgreSQL must also run only through the
integration workflow; import and packaging checks without database access can
remain in the unit command.

SPEC 13's local runtime policy allows history reads and denies history writes.
Preserve that development policy, including its canonical provisioning SQL.
The AWS handoff below requires stricter isolation: `core_runtime` cannot read
or write `core.typeorm_migrations`.
Migration integration fixtures must reproduce this AWS policy using only
`test_core_runtime` in `gootip_test_core`.
After the history table exists, revoke all runtime privileges on it before
asserting that both `SELECT` and write attempts fail while catalog DML succeeds.
Exercise both a fresh migration and a repeated apply, restoring the shared
Core test fixture's original grant policy during cleanup before other suites run.
Do not apply these test-only privilege changes to development database `gootip`.

The handoff must provide:

- The target database and a `core` schema owned by `core_migrator`.
- Separate `core_migrator` and `core_runtime` identities with no membership between them.
- An existing credential secret containing the `core_migrator` username and password.
- The complete non-sensitive secret ARN in the configured account and Region.
- Core-only migration privileges and a tested mechanism for catalog runtime grants.
- Runtime DML on the catalog after migration, without DDL, schema ownership, or migration-history access.
- Evidence that neither Core identity can modify Auth objects or create objects in `public`.
- An explicit initial-state report identifying whether the schema is empty or has compatible TypeORM history.

The migration Lambda never creates roles, creates schemas, retrieves the master credential, or supplies missing administrative grants.
It must stop on missing prerequisites rather than silently expanding its responsibilities.
If existing Core objects lack compatible history, stop and resolve adoption through separate reviewed work.

The relevant infrastructure contracts are [SPEC 02.1](../../gootip-infra/specs/02.1-iam-roles-sts-mfa-bootstrap.md), [SPEC 02.2](../../gootip-infra/specs/02.2-secure-dev-foundation-deployment.md), and [SPEC 07](../../gootip-infra/specs/07-lambda-iam-and-network-least-privilege.md).
Auth's [SPEC 04](../../gootip-infra/specs/04-private-postgres-migrations.md) is an operational reference, not a grant of authority to reuse Auth's identity.

## Data model and contracts

### Migration ownership and history

Business migrations remain in `src/config/database/migrations/`.
Register each migration explicitly in `src/config/database/migrations/index.ts`.
Keep `src/config/database/data-source.ts` usable by the local TypeORM CLI.

The first release includes the existing `CreateCategories1782086400000` and `CreateProducts1793059200000` migrations.
Do not rewrite them merely to introduce the executor.
TypeORM owns the history rows in `core.typeorm_migrations`, using its standard `id`, `timestamp`, and `name` columns.
Do not add a parallel SQL execution ledger.

The artifact contains `migrations/manifest.json` with this contract:

```ts
type MigrationManifest = {
  format_version: 1;
  commit_sha: string;
  migrations: { name: string; timestamp: number; source_sha256: string }[];
};
```

The build derives the ordered entries from the actual registered migrations and hashes their source files.
Reject duplicate names, duplicate timestamps, missing sources, and registry/manifest disagreement.
The package reports the exact manifest and ZIP digests without including credentials.
The published Lambda version identifies the executable bundle.

TypeORM history does not record source checksums.
The manifest identifies the current artifact but does not prove historical migration bytes or full live-schema equivalence.
Applied migration sources are append-only: add a new reviewed migration instead of editing an applied one.
Document this limitation rather than claiming Auth-equivalent checksum history protection.

### Invocation and result

```ts
type MigrationRequest = {
  operation: 'validate' | 'apply';
  run_id: string;
  commit_sha: string;
  expected_manifest_sha256: string;
  expected_history_sha256?: string;
};

type MigrationResult = {
  operation: 'validate' | 'apply';
  run_id: string;
  commit_sha: string;
  status: 'succeeded' | 'no_changes' | 'failed';
  manifest_sha256: string;
  history_sha256: string | null;
  applied_names: string[];
  pending_names: string[];
  error_code: string | null;
};
```

Reject unknown request fields, unsupported operations, invalid correlation fields, and invalid digests before database access.
Require a lowercase 40-character Git commit and lowercase 64-character SHA-256 values.
Bound `run_id` to 1–128 characters from `[A-Za-z0-9._-]`.
Compare the requested commit and manifest digest with the packaged manifest before fetching credentials.
An invalid request can raise a sanitized Lambda error because no valid result correlation exists.

Invoke only the `deployment` alias pointing to one reviewed published version without weighted routing.
The handler rejects unqualified, `$LATEST`, numeric-version, and unknown-alias invocations.
Record and verify the alias target before each manual run so concurrent alias updates cannot silently change the executable release.
The future pipeline must preserve this identity check.
Events cannot override the database, schema, credentials, migration list, transaction mode, or SQL.

`applied_names` describes committed history after the operation, including migrations applied by earlier runs.
`pending_names` describes registered migrations still missing from that history.
`validate` returns `succeeded` for a coherent state even when migrations remain pending.
`apply` returns `succeeded` after applying pending migrations or `no_changes` when none remain.
An accepted `apply` has empty pending names and a null error code.
If the state cannot be reconciled after failure, return a null history digest and treat the outcome as uncertain.

Compute the history digest from a canonical ordered array of `{ name, timestamp }` records.
Exclude generated row IDs and credentials.
If supplied, compare `expected_history_sha256` before applying anything.
Use the returned digest for validation after deployment approval waits.
Lambda transport success alone is never migration success.

### Validation, execution, and concurrency

Initialize an isolated migration `DataSource` after loading the migrator credential.
Reuse the database configuration factory while keeping `synchronize` and automatic migrations disabled.
Use verified TLS and the shared RDS CA bundle in AWS.
Close connections at the end of each invocation instead of caching the API's Nest application or connection pool.

Acquire a session advisory lock scoped to the target database and `core` before reading history or executing migrations.
All Core migration entry points must follow this lock protocol for AWS operations.
Direct local CLI access remains for the local databases managed by SPEC 13.
Restrict cloud credential access and document that the bare CLI is not an alternative AWS deployment path.

Use one dedicated connection for the lock, preflight, migration execution, and postflight.
The installed `MigrationExecutor` accepts a `QueryRunner`; prove this connection ownership with a focused compatibility test before integrating it.
Set its transaction mode to `all` and fake execution to false.
Do not take the lock on an arbitrary pooled connection and assume `DataSource.runMigrations()` uses it.
Do not invoke TypeORM private methods or maintain a copied executor.

Before any TypeORM helper that can create history tables, perform a read-only preflight:

- Verify the expected database, `current_user = core_migrator`, schema ownership, and configured TLS policy.
- A missing or empty history is acceptable only when the schema has no existing application objects.
- Reject malformed or duplicate history records and unknown migration names or timestamps.
- Require existing history to be an ordered prefix of the packaged migration sequence.
- Reject known inconsistencies between history and the catalog objects it claims to have created.
- Do not interpret valid history as proof that every column, grant, and index matches its expected definition.

`validate` must not create a table, insert history, or execute migrations.
Avoid TypeORM status helpers that create their history table when it is missing.
Both `validate` and `apply` acquire the same lock so they report a consistent history snapshot.

During `apply`, execute all pending `up()` operations and their history inserts in one transaction.
A failure must roll back every pending business change and every history row from that invocation.
Already committed migrations remain intact.
TypeORM may initialize an empty history infrastructure table before the migration transaction; an empty table is not evidence of a successful migration.
Reject per-migration transaction overrides and exclude operations incompatible with the chosen transaction mode.
Migration code must not open another connection, commit independently, or perform external side effects.

After execution, reread history under the lock and verify that no registered migrations remain pending.
Release the lock and `QueryRunner`, then destroy the `DataSource` in cleanup paths.
On timeout or lost response, a later `validate` reconciles database state before retrying the unchanged artifact.
Do not automatically run `down()` when an invocation or API deployment fails.

### AWS resources and limits

| Setting                                            | Contract                                        |
| -------------------------------------------------- | ----------------------------------------------- |
| Function                                           | `${project}-${env}-core-migrations`             |
| Terraform function label                           | `aws_lambda_function.core_migrations`           |
| Deployment alias                                   | `deployment`                                    |
| Runtime / architecture                             | Node.js 24 / ARM64                              |
| Handler                                            | `dist/migrations/lambda.handler`                |
| Artifact                                           | `gootip-core/migration-lambda.zip`              |
| Log group                                          | `/aws/lambda/${project}-${env}-core-migrations` |
| Initial dev memory / timeout                       | 512 MB / 600 seconds                            |
| Reserved concurrency                               | 1, supplementary to the database lock           |
| Connection / advisory-lock wait / statement limits | 10 / 30 / 120 seconds                           |
| Log retention                                      | 7 days                                          |

Use a migration-only pool with a maximum of one connection.
Bound lock acquisition and SQL execution on the session and leave time for cleanup before the Lambda deadline.
Use structured error codes for configuration, artifact mismatch, prerequisite failure, incompatible history, lock timeout, SQL failure, and uncertain outcome.
Log correlation, migration names, counts, status, and digests.
Do not log secret values, connection strings, SQL bodies, or raw database errors.

The execution role may read only the exact Core migrator secret and write its managed logs.
Use the established VPC execution permissions and runtime boundary pattern.
It cannot read Auth, Core runtime, operator, or master credentials.
The deployment principal may invoke only the Core `deployment` alias.
Review any boundary or PassRole extension as an explicit infrastructure change under the existing stop conditions.
This spec does not preauthorize an unreviewed principal or broad IAM scope.

Attach a dedicated client security group in the existing private subnets.
Permit PostgreSQL access only to the existing RDS security group on port 5432.
Permit HTTPS access only to the existing Secrets Manager endpoint security group on port 443.
Update reciprocal ingress allowlists only while Core migration deployment is enabled.
Reuse the RDS CA layer and native Lambda logging.
Do not add NAT, public networking, another Secrets Manager endpoint, an RDS Proxy, or a Logs endpoint.

## File boundaries

All paths below are relative to their named project.

| Project / paths                                                                                                         | Responsibility                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Core: `src/migration-runner/lambda.ts`, `handler.ts`, `runner.ts`                                                       | Lambda adapter, request/result handling, locked TypeORM execution                                    |
| Core: `src/migration-runner/contract.ts`, `manifest.ts`, `credentials.ts`                                               | Protocol, artifact/history identity, fixed secret loading                                            |
| Core: `src/config/database/data-source.ts`, `database.config.ts`, `migrations/index.ts`                                 | Reuse migration configuration and explicit registration                                              |
| Core: `scripts/build-migration-lambda.mjs`, `package-migration-lambda.mjs`                                              | Metadata-preserving compile/bundle, generated manifest, reproducible ZIP                             |
| Core: `package.json`, `pnpm-lock.yaml`, `README.md`, `.gitignore`                                                       | Separate build/package commands, dependencies if needed, runbook, generated-artifact exclusions      |
| Core: `test/migration-runner.spec.ts`, `migration-integration.spec.ts`, `migration-artifact.spec.ts`                    | Contracts, real PostgreSQL behavior, isolated artifact loading                                       |
| Core: `vitest.config.ts`, `scripts/test-unit.mjs`, `test/local-postgres.ts`; Infra: `scripts/local_postgres.sh`         | Register integration-only tests, preserve database-free unit checks, and reuse guarded Core fixtures |
| Infra: `lambda.tf`, `iam.tf`, `network.tf`, `observability.tf`, `variables.tf`, `outputs.tf`, `environments/dev.tfvars` | Optional private executor resources and exact ARN handoffs                                           |
| Infra: `bootstrap/iam.tf`, `bootstrap/variables.tf`, focused IAM/network test fixtures                                  | Explicit bounded deployment capabilities and runtime boundary changes                                |
| Infra: `README.md`, `AGENTS.md`                                                                                         | Core invocation instructions and updated explicit client allowlists                                  |

Keep the existing API bundle and local CLI commands functional.
Add `build:migration-lambda` and `migration-lambda:zip` without bundling the HTTP server into the executor.
Preserve TypeScript decorator metadata for any imported entities using the existing compile-then-bundle approach.
Do not add a TypeScript interpreter or development dependencies to the deployed ZIP.
Reuse an installed AWS SDK client when available; otherwise add only the Secrets Manager client required by this executor.
The ZIP contains the ESM executor bundle and manifest, with normalized archive metadata.
Do not include source maps, environment files, credentials, or an unnecessary `node_modules` tree.

## Implementation plan

1. Confirm Infra SPEC 13 is implemented and its shared server and isolated Core fixtures are functional. Add protocol and manifest validation with unit tests, leaving existing API and CLI behavior unchanged.
2. Add read-only database preflight and history comparison against the disposable Core test database on SPEC 13's shared server, including rejection of existing tables without valid history. Register the suite in Core's `test:integration` command and exclude database-dependent tests in `scripts/test-unit.mjs`, preserving the existing serial workflow without creating another container. Add scoped fixtures for the stricter AWS history-access policy and restore the shared test grants during cleanup.
3. Add dedicated-session locking and TypeORM execution with `transaction: all`; prove shared connection ownership and whole-batch rollback with focused integration tests.
4. Add secret loading and the Lambda adapter with alias checks, sanitized results, cleanup, and failure tests.
5. Add separate compile, bundle, manifest, and ZIP commands; verify isolated handler import and registered migration identities from the packaged artifact.
6. Extend bootstrap-owned deployment capabilities for the exact Core resources, with policy guardrail tests and an independently reviewed plan before any capability apply.
7. Add optional private executor resources and non-sensitive input/output handoffs in the flat infrastructure root; keep deployment disabled until the administrative prerequisites are available.
8. Document manual `validate`, `apply`, revalidation, failure reconciliation, and migration-authoring procedures, including explicit registry updates after local generation.
9. Once the separate administrative-bootstrap handoff is verified, prepare and review the saved dev plan; apply only that reviewed plan under the repository's deployment policy.
10. Invoke the reviewed artifact through the deployment alias: validate pending migrations, apply, validate the returned history digest, and repeat apply to obtain `no_changes`; record sanitized evidence in the runbook and hand the result contract to future API deployment orchestration.

Cloud prerequisites are gates rather than permission to mark the feature complete with deferred AWS validation.
No cloud operation is performed while writing or reviewing this Draft.

## Acceptance criteria

- [x] Infra SPEC 13 is implemented before work on this spec starts.
- [x] Migration integration tests use the shared PostgreSQL 18 Alpine server, `gootip_test_core`, and `test_core_` roles without creating or stopping a database container.
- [x] `test:unit` excludes all database-dependent migration tests and passes without PostgreSQL, Docker, or AWS credentials; the serial integration workflow executes those tests explicitly.
- [x] Destructive fixtures reject development and unexpected targets; running and cleaning up migration tests preserves development data, credentials, grants, and histories.
- [x] The separate administrative-bootstrap handoff exists and its Core identity, schema, secret, and privilege prerequisites are verified before AWS execution.
- [x] AWS Core runtime cannot perform DDL or read/write migration history; the executor cannot access Auth or master credentials.
- [x] Namespaced migration fixtures prove denied history `SELECT` and writes plus successful catalog DML after fresh and repeated application, and restore test grants before other Core suites run.
- [x] SPEC 13's development policy remains unchanged: local runtime history reads are allowed and history writes remain denied.
- [x] API initialization still performs no migration or synchronization and never reads the migrator secret.
- [x] The local migration CLI and explicit migration registry remain usable.
- [x] Unknown fields, unsupported operations, invalid identities, wrong commits, and wrong manifest digests fail before database access.
- [x] Only the reviewed deployment alias is accepted and the manual invocation records its exact published target.
- [x] `validate` on an empty prepared schema reports both pending migrations without creating history or business objects.
- [x] Existing application objects without compatible history fail without adoption, fake execution, or history insertion.
- [x] Duplicate, unknown, out-of-order, or incompatible history fails before pending changes run.
- [x] A failure in the second pending migration rolls back the first pending migration and both new history rows.
- [x] Repeated successful `apply` produces `no_changes` with stable history identity and no duplicated objects or records.
- [x] Two independent executor instances cannot enter the migration critical section concurrently, even without Lambda reserved concurrency.
- [x] Lock timeout, SQL failure, secret failure, and cleanup paths produce sanitized failures and release connections when execution permits cleanup.
- [x] A missing or uncertain response is reconciled through `validate` before retry; no automatic rollback or blind retry is performed.
- [x] A changed expected history digest blocks apply and a post-wait validation detects changed history.
- [x] The isolated Node.js 24 ARM64-compatible artifact imports successfully, exports the handler, and contains the expected migration identities and manifest.
- [x] The API and migration ZIP build/package commands do not invalidate one another's outputs.
- [x] Terraform enables only the expected private executor, scoped IAM, logging, and client-network changes, preserving state, secrets, data, and existing Auth resources.
- [x] Focused Core type, lint, format, contract, PostgreSQL, and artifact checks pass; existing relevant catalog integration checks still pass.
- [x] Infrastructure formatting, validation, focused policy/network tests, and the required final verification pass with no unexpected plan actions.
- [x] Dev evidence records the reviewed version, ZIP/manifest identity, initial validation, successful apply, matching post-validation, and a `no_changes` repeat.
- [x] Missing administrative prerequisites or missing live dev evidence leave this spec incomplete rather than being reported as successful implementation.

## Dev implementation evidence (2026-10-30)

SPEC 06 is implemented for the private Core migration runner in dev. The reviewed
artifact was commit `b9cb79106971d963ed13cbced8721e450fdf9ce7`, manifest SHA-256
`4fa377e9dca2db9fcfe5b3247548a2a1fafd8ed456826d91e070591799bae576`, and ZIP
SHA-256 (base64) `Xzw3vkS7I2X4WGAbfhNGPk3R67DDW4potKBPpdIU5NQ=`. Lambda version `1`
is Active, has reserved concurrency `1`, and is selected by the `deployment`
alias without weighted routing. The initial alias validation reported both
registered migrations pending. The authorized `apply` succeeded; the subsequent
`validate` returned the same history SHA-256
`86329e57e10a79b9cb9eeb014f9b51ae35f91e2b5a71cf7019768bb142190103` with no
pending migrations, and the repeat `apply` returned `no_changes` with that digest.

Read-only RDS verification used `gootip_dev_operator` over TLS `verify-full`.
It confirmed the two business tables and TypeORM history table, their
`core_migrator` ownership, the expected history rows, Core runtime DML grants,
and denial of runtime DDL, history access, Auth access, and `public` creation.
The SQL ran in a read-only transaction; no data or grants were changed. Core
unit tests (72), typecheck, lint, formatting, the isolated PostgreSQL 18
migration integration evidence, and focused infrastructure/IAM verification
passed. Sanitized invocation and catalog evidence is recorded in
[`audit/dev-core-migrations-20261030.json`](../audit/dev-core-migrations-20261030.json).

Limitations retained from the SPEC 14 handoff: the pre-bootstrap catalog
inventory and historical Auth row-data digest cannot be reconstructed; current
PostgreSQL logging settings were checked, but logs were not read and settings
active during the earlier bootstrap cannot be proven. The Core API was not
deployed or activated; API deployment and its smoke test are outside SPEC 06.

## Decisions

- **Yes: Infra SPEC 13 before this implementation.** Build migration tests on the established shared-server isolation contract instead of adapting a second container workflow later.
- **No: treat local provisioning as the AWS bootstrap.** The separate Core administrative handoff still gates cloud deployment and invocation.
- **Yes: preserve SPEC 13's local history-read policy while testing stricter AWS isolation.** Apply scoped privilege changes only in disposable migration fixtures, with cleanup that restores the shared test baseline.
- **Yes: explicit integration test selection and unit exclusions.** The existing unit script excludes files by name, so adding a database test requires updating both commands.
- **Yes: a separate private Lambda owned by Core.** It fits the existing RDS topology and preserves runtime/migrator separation.
- **Yes: TypeORM's executor and standard history.** Reuse the installed library instead of rebuilding Auth's SQL engine.
- **Yes: one transaction for all pending migrations.** This is the user-selected policy and TypeORM's default; the current category/product migrations support it.
- **Yes: a dedicated session advisory lock.** Standard TypeORM history is not a distributed execution lock.
- **Yes: a versioned artifact manifest and externally verified Lambda version.** Identify reviewed inputs without inventing checksum columns in TypeORM history.
- **Yes: stop on incompatible existing state.** Adoption and history repair require a separate reviewed operation.
- **Yes: extend the existing administrative bootstrap through separate prerequisite work.** `lambda_db_config` already exists; Core needs its own reviewed roles, schema, secret references, and grants. This executor must not create database identities or gain administrative credentials.
- **Yes: infrastructure and manual dev validation in this spec.** The feature is complete only after its private execution path is proven.
- **No: CI/CD or API activation implementation.** Preserve a concrete invocation/result handoff for later deployment work.
- **No: automatic `down()` on failure.** Application rollback does not imply a safe database rollback.

## Risks

| Risk                                                                      | Mitigation                                                                                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The separate Core bootstrap is unavailable or supplies incomplete grants. | Gate AWS execution on the handoff and prove catalog DML/history isolation after migrations.                                        |
| An interrupted invocation leaves the caller uncertain about commit.       | Reconcile history under the lock with the same artifact before retrying or activating application code.                            |
| A separate connection invalidates the locking assumption.                 | Pass the locked `QueryRunner` to the installed executor and test connection ownership and contention.                              |
| An applied migration is edited without changing its TypeORM name.         | Preserve append-only source review and immutable release artifacts; document the lack of historical checksums.                     |
| A future migration runs too long or uses nontransactional operations.     | Keep bounded transactional DDL in this path; use separate reviewed maintenance work for long backfills or concurrent index builds. |
| A schema change breaks the API version still serving traffic.             | Require backward-compatible additive migrations before activation and defer destructive cleanup to a separately reviewed release.  |
| A mutable alias changes between operator review and invocation.           | Verify and record the published target immediately before invocation and prevent concurrent deployment changes.                    |

## Official references

- [TypeORM migration setup](https://typeorm.io/docs/migrations/setup/): explicit classes, disabled synchronization, history configuration, and transaction modes.
- [TypeORM migration execution](https://typeorm.io/docs/migrations/executing/): compiled execution and timestamp ordering.
- [TypeORM DataSource API](https://typeorm.io/docs/data-source/data-source-api/): connection lifecycle and programmatic migration execution.
- [AWS Lambda with RDS](https://docs.aws.amazon.com/lambda/latest/dg/services-rds.html): private database connectivity.
- [AWS schema migrations with Lambda and Flyway](https://aws.amazon.com/blogs/database/automate-schema-version-control-and-migration-with-flyway-and-aws-lambda-on-amazon-aurora-postgresql/): an AWS example of the executor pattern, not a TypeORM-specific mandate.
- [AWS schema and code deployment compatibility](https://docs.aws.amazon.com/whitepapers/latest/blue-green-deployments/best-practices-for-managing-data-synchronization-and-schema-changes.html): separate schema changes and maintain compatibility with the active application version.
- [AWS Lambda limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html): standard invocation duration limits.

## What is **not** in this spec

No administrative Core bootstrap, credential creation, baseline adoption, destructive migration, automatic rollback, Auth refactor, shared migration framework, API deployment, GitHub Actions implementation, staging, or production operation is included.
