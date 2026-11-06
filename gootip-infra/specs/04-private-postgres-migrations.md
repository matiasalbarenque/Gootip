# SPEC 04 — Private PostgreSQL Migration Execution

> **Status:** Implementation complete for dev; deferred operational evidence
> **Depends on:** SPEC 02.1, SPEC 02.2, SPEC 03
> **Date:** 2026-10-15
> **Objective:** Apply reviewed auth PostgreSQL migrations through a dedicated private Lambda built from the `gootip-auth` project without granting application runtimes database migration privileges.

## Why this spec exists

RDS is private and ordinary GitHub-hosted runners cannot connect to it. Better Auth schema changes still need execution before the new authentication application becomes active. This spec defines the auth migration artifact, isolated AWS-private executor, and invocation contract. SPEC 11 owns GitHub Actions orchestration and invokes the approved migration Lambda as a deployment step before auth activation.

SPEC 03 provisions the `auth` schema, `auth_runtime`, and `auth_migrator` through `lambda_db_config` and defines their two bootstrap-owned secret containers under the SPEC 02.1 control plane. SPEC 05 later configures authentication to use its restricted runtime credential. This spec does not transfer application migration responsibilities to the administrative function. It uses the resulting migrator privilege without the master credential.

Cloud implementation follows the SPEC 02.2 foundation and SPEC 03 administrative bootstrap. Before SPEC 11 enables the deployment workflow, an authorized operator can invoke the exact approved runner version for the manual deployment path. Once SPEC 11 is implemented, its manually authorized deployment workflow invokes the runner automatically when migration validation or application is required. A merge alone does not deploy AWS, and auth startup never runs migrations.

## Scope

**In:**

- Auth migration-generation, runner, tests, and packaging code within `gootip-auth/`, using its existing TypeScript project, dependency lockfile, and toolchain.
- A separate migration-runner build command and ZIP artifact, and a separate private Node.js 24 ARM64 Lambda for authentication migrations. The auth API and migration executor remain separate functions with independent execution roles and security groups.
- Independent execution role, security group, secret allowlist, managed logs, and invocation permissions.
- Compatible official Better Auth generation tooling and a local incremental-generation proof.
- Reviewed ordered SQL in `gootip-auth/migrations/`, SHA-256 checksums, and an immutable artifact manifest.
- An `auth` history table, transaction-per-migration execution, and session advisory locking.
- Explicit verified baseline adoption for a previously initialized database.
- Strict request/result contracts, bounded execution, idempotent retries, and uncertain-outcome reconciliation.
- Positive and negative PostgreSQL/IAM isolation tests.
- Backup checks, forward recovery, sanitized logs, and operational documentation.

**Out of scope:**

- Implementing `lambda_core`, its entities, business tables, or its deployed executor before the service exists.
- GitHub Actions workflow implementation, OIDC provisioning, S3 release storage, and application alias changes; SPEC 11 owns those. SPEC 04 defines the runner invocation/result contract consumed by that workflow.
- Executing application migrations in `lambda_db_config`, `lambda_auth`, or `lambda_core` startup.
- Using RDS master credentials or giving runtime roles DDL or migrator membership.
- Nontransactional SQL, `CREATE INDEX CONCURRENTLY`, long backfills, or jobs exceeding Lambda execution limits.
- Automatic schema rollback, automatic baseline adoption, or unattended destructive migrations.
- Arbitrary SQL, database targets, schema names, or secret references supplied through invocation payloads.
- NAT, Redis, persistent EC2, ECS/Fargate deployment, new paid connectivity services, or scheduled credential rotation.

## Data model and contracts

### Current architecture and compatibility evidence

The Hono application is defined in `gootip-auth/src/app.ts`, the actual authentication configuration is `src/auth/auth.ts`, and the AWS API entry point is `src/lambda.ts`. The authentication configuration passes a `PostgresDialect` backed by `pg.Pool` to Better Auth's integrated Kysely adapter and selects `schemaName: 'auth'`. The installed package and auth lockfile resolve Better Auth 1.7.7. There is no auth-side TypeORM client or `TYPEORM_SYNCHRONIZE` contract. The migration runner source and auth migration files live in this same `gootip-auth` project, while the API and runner are built and deployed as distinct Lambda artifacts/functions.

Official tooling distinguishes these operations:

| Tool              | Purpose and restriction                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth generate`   | Generates schema SQL for the integrated Kysely adapter; incremental behavior must be proven against the configured database                           |
| `auth migrate`    | Applies changes directly for the integrated Kysely adapter; not the normal reviewed AWS deployment path                                               |
| `getMigrations()` | Programmatic integrated-adapter alternative; inspect compatibility with the installed package rather than assuming it exists in every adapter/version |

The installed 1.7.7 package exports `better-auth/db/migration`. Its declarations expose `getMigrations()`, `compileMigrations()`, `runMigrations()`, and schema/unsafe-change diagnostics. Static inspection supports evaluating SQL generation through this API. It does not prove safe incremental CLI behavior or complete schema equivalence.

**Pre-approval evidence gate:** prove local initial and incremental SQL generation with an exact compatible official CLI release and the actual adapter. Record the package name, version, commands, fixtures, emitted SQL, and limitations. Do not use `auth@latest`, assume a CLI version matching the library exists, or claim the CLI creates numbered migration files.

If the CLI fails this proof, document the failure and perform a local technical evaluation of `getMigrations()` and `compileMigrations()`. Favor using the compatible official API to emit reviewable SQL while retaining this SQL/history runner contract. If the alternative requires direct unversioned AWS application, revise and re-review this spec before approval. This condition must not silently turn into dynamic migration generation in AWS.

### File boundaries

| Path                                                                                                      | Responsibility                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gootip-auth/migrations/`                                                                                 | Ordered reviewed `.sql` files; permanent Git history                                                                                                                                                                                 |
| `gootip-auth/src/auth/auth.cli.ts`                                                                        | Tool-loadable local Better Auth configuration sharing the real schema/plugin configuration without booting the Hono server/Lambda or fetching AWS secrets                                                                            |
| `gootip-auth/src/migration-runner/`                                                                       | Fixed handler, request validation, database verification, history, locking, SQL application, and baseline logic                                                                                                                      |
| `gootip-auth/scripts/` and `package.json`                                                                 | Exact compatible local generation/check commands, manifest generation, and separate API/migration build and package commands                                                                                                         |
| `gootip-auth/test/`                                                                                       | Disposable PostgreSQL fixtures, failure/isolation/concurrency tests, and both Lambda artifact tests                                                                                                                                  |
| `gootip-auth/README.md`                                                                                   | Local generation, private invocation, baseline, limits, and recovery runbook for auth migrations                                                                                                                                     |
| `gootip-infra/lambda.tf`, `iam.tf`, `network.tf`, `variables.tf`, `outputs.tf`, `environments/dev.tfvars` | Native runner, independent SG, non-secret configuration, and bounded application IAM after a prior bootstrap-root expansion of the SPEC 02.1 runtime boundary and exact PassRole allowlist; secret containers remain bootstrap-owned |
| `gootip-infra/observability.tf`                                                                           | SPEC 06 managed-log and standard-alarm extension for the runner                                                                                                                                                                      |
| `gootip-infra/README.md`                                                                                  | Deployment prerequisite and private operation documentation                                                                                                                                                                          |

Internal runner modules are selected during implementation. The runner uses the existing `gootip-auth` package manifest and lockfile; do not create a sibling `gootip-db-migrations/` project or a shared migration project for auth and core. Core owns its future migration generator and migration files in `gootip-core`; it may use the same deployment orchestration pattern but does not share auth's runner permissions or database history. No application schema migration is placed in the administrative project. Do not create files or Terraform resources under the reserved core service merely to simulate its future integration.

### Permission and ownership matrix

| Principal                                                                                      | Database capability                                                                          | Secrets Manager capability                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `auth_runtime` / authentication Lambda                                                         | Required DML and sequence access in `auth`; no ownership or DDL                              | Authentication signing secret and `auth_runtime` credential only |
| `auth_migrator` / auth migration Lambda                                                        | DDL for owned application objects in `auth`; history and necessary migration data operations | Exact `auth_migrator` credential only                            |
| `lambda_db_config`                                                                             | Fixed administrative bootstrap from SPEC 03                                                  | Master and configured role credentials from SPEC 03              |
| Human baseline operator (`GootipBootstrapAdmin`, through a reviewed exact invocation grant)    | Invoke the operator-only qualified baseline version                                          | No direct database credential retrieval                          |
| Human deployment operator (`GootipTerraformDeploy`, through a reviewed exact invocation grant) | Invoke only the approved apply/validate qualified runner version before SPEC 11 CI           | No baseline adoption or database credential retrieval            |
| Future SPEC 11 CI deployment role, distinct from human `GootipTerraformDeploy`                 | Invoke only the approved apply/validate qualified runner version                             | No baseline adoption or database credential retrieval            |

`auth_migrator` is a non-superuser without role/database creation, replication, bypass-RLS, privileged memberships, or ownership/access outside `auth`. SPEC 03 revokes inherited `PUBLIC` privileges and aligns object ownership/default privileges with the actual object creator. Verify the effective grants instead of assuming schema grants override broad database or role permissions.

Default privileges are configured by administration for the actual migrator role. Existing and newly created application tables/sequences must receive the required runtime grants. History objects are internal; explicitly remove any runtime grants inherited through these defaults so the application cannot modify or forge migration history. Test application DML and history denial together.

The runner verifies its expected database, `current_user`, schema, role attributes/memberships, and relevant ownership/grants before applying SQL. It rejects the master user and unrelated privileged roles. PostgreSQL authorization is the isolation boundary. SQL review and a restrictive `search_path` supplement it; text matching or `search_path` alone cannot enforce cross-schema isolation. Preserve necessary system-catalog access without granting application-object access outside `auth`.

### Lambda and network contract

Use Terraform label `aws_lambda_function.auth_migrations` and physical name `${project}-${env}-auth-migrations`. It has its own role, security group, and exact `auth_migrator` secret allowlist.

The execution role is an application role under the exact SPEC 02.1 bootstrap-owned permissions boundary. Bootstrap must add it to the boundary and exact PassRole allowlist before either the human deployment role or future SPEC 11 CI role can deploy it. Bootstrap also grants the human deployment role exact qualified apply/validate invocation so the runner can be exercised before SPEC 11 exists; that grant excludes the baseline alias/version.

The auth runner uses `nodejs24.x`, `arm64`, native Lambda, the separate ESM artifact `dist/migrations/lambda.mjs`, and Terraform handler `dist/migrations/lambda.handler`. Its ZIP is `migration-lambda.zip`; the auth API retains its existing `dist/lambda.mjs`, `dist/lambda.handler`, and `lambda.zip` contract. There is no API Gateway, Function URL, public trigger, scheduled migration trigger, or application-runtime invocation grant. Operator and deployment invocation permissions are restricted to the intended qualified version. The pipeline pins that version and checks its manifest identity rather than invoking mutable `$LATEST`.

Use private subnets from the SPEC 02.2 VPC. Allow TCP 5432 from the migration SG to the RDS SG and HTTPS 443 to the existing Secrets Manager endpoint. Extend its policy for the new exact principal and secret. Keep the verified RDS TLS contract accepted by SPEC 03, native CloudWatch log delivery, and DNS working. Do not add NAT, a Logs endpoint, or an S3 endpoint to download SQL; SQL is bundled in the deployment ZIP.

Use exact-secret read grants and per-function log-stream writes from the first deployment. Execution-role trust remains limited to Lambda. SPEC 07 later consolidates the Lambda-service VPC permissions and code-originated EC2 denial across every function. No secret-value writes or IAM administration are required.

Read the current migrator credential on each invocation and validate its expected username. Do not retain a password in the ZIP, manifest, invocation payload, Terraform, state, logs, or response. No production signing secret is needed to apply precompiled SQL. Invalid/missing credentials fail before SQL mutation.

### SQL files and artifact manifest

Use fixed-width ordered IDs in filenames, beginning with `000001-initial-auth.sql`. New reviewed changes receive the next available ID and a short kebab-case description. ID ordering is explicit; parallel branches must reconcile collisions before merge. Never edit an already applied migration to change its checksum.

Store and hash the exact committed UTF-8 bytes. Generation is a developer operation against a disposable local database at the previous committed schema state. Plugins or library changes must use the same relevant Better Auth configuration as the candidate application. A generated schema snapshot is not assumed to be an incremental migration; inspect its SQL against an existing-data fixture before committing it.

The migration runner ZIP is a separate artifact from the auth API ZIP. Reuse the existing esbuild approach to produce one minified ESM handler bundle at `dist/migrations/lambda.mjs`; package only that bundle, the reviewed SQL files under `migrations/`, and `migrations/manifest.json`. Keep the payload as small as practical: do not copy `node_modules`, development dependencies, source files, or source maps when they are not needed at runtime. Preserve required runtime modules and validate the actual bundle, since size optimization must not break the handler or PostgreSQL behavior. Its build and package commands are `build:migration-lambda` and `migration-lambda:zip`; the API keeps its existing `build:lambda` and `lambda:zip` commands. Packaging copies only committed, reviewed SQL and manifest files; it never generates or applies SQL. The SQL files and manifest are available inside the deployed Lambda package and require no runtime download or S3 access. The auth API ZIP does not need to contain the migration runner or migration SQL.

Measure both the compressed ZIP and its uncompressed contents, including any layers, during packaging and CI. Keep the uncompressed deployment package at or below AWS Lambda's 250 MB limit. A ZIP up to 50 MB can be uploaded directly through the Lambda API/SDK; when the compressed ZIP exceeds 50 MB, deploy the exact verified artifact through the private S3 release storage defined by SPEC 11. S3 is only the deployment artifact source: the function does not download SQL or other runtime files from S3. Prefer staying below the direct-upload limit, but do not omit required reviewed SQL or weaken verification just to meet it.

The ordered manifest includes:

| Field                                                    | Contract                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `manifest_version`, `service`, `schema`                  | Versioned fixed identity: auth / `auth`                                             |
| `commit_sha`, `better_auth_version`, `generator_version` | Reviewed configuration/library/tool provenance                                      |
| `configuration_sha256`                                   | Digest of the relevant generation configuration and schema/plugin inputs            |
| `migrations`                                             | Ordered entries with unique `id`, relative `file`, and `sha256`                     |
| `initial_schema_fingerprint`                             | Reviewed canonical initial-structure descriptor/digest used for baseline comparison |

SPEC 11 records the manifest digest and runner ZIP hash in its release manifest. A function version cannot substitute different SQL for the same manifest identity. Validate unique IDs, file allowlists, path traversal, ordering, every checksum, and all manifest/file correspondence before database mutation.

### History table

Use `auth.gootip_schema_migrations`, owned by `auth_migrator`, with no runtime modification privileges:

| Column               | Type and meaning                                              |
| -------------------- | ------------------------------------------------------------- |
| `migration_id`       | `text`, primary key; ordered manifest ID                      |
| `checksum_sha256`    | `char(64)`, exact committed SQL hash                          |
| `applied_at`         | `timestamptz`, database application/baseline time             |
| `commit_sha`         | `text`, source release that applied or adopted this migration |
| `run_id`             | `text`, validated workflow/operator correlation ID            |
| `application_mode`   | `text`, `applied` or `baseline_verified`                      |
| `approval_reference` | Nullable `text`; required for verified baseline adoption      |
| `schema_fingerprint` | Nullable `text`; required baseline evidence digest            |

Create/validate this internal table under the migrator and the same lock protocol. This is migration bookkeeping, not a transfer of schema/role bootstrap to the runner. No private credentials or arbitrary SQL are recorded in the table.

Verify the existing history is a valid prefix of the packaged manifest. Reject unknown applied IDs, gaps, invalid ordering, altered checksums, malformed history, or a manifest behind the live database. Verify all applied entries before running any pending SQL. Do not skip a checksum mismatch as though it were already applied.

A successful migration's SQL and history insert commit in the same transaction. Failed SQL leaves no successful row for that migration. Earlier migrations committed during this run remain committed; stopping the deployment does not reverse them. Sanitized CloudWatch outcomes record failures and correlation IDs independently of the successful history table.

### Concurrency and execution protocol

Use one dedicated PostgreSQL connection for the complete auth operation. Acquire an exclusive session advisory lock with a stable, documented database-and-schema identity. Do not key it by workflow/run ID. Use a bounded acquisition loop with a deadline; timeout returns an explicit failure without mutation. The session lock spans history verification, all per-migration transactions, and final validation.

Set reviewed connection, statement, database lock-wait, and total-operation timeouts. Their values must fit within the configured Lambda timeout, the 15-minute service maximum, and the caller/job deadlines, leaving a cleanup margin. Measure them in local/dev tests before cloud enablement. Reject a release needing longer execution rather than trying to continue it through blind retries.

For each pending migration: begin a transaction, apply reviewed SQL on this same connection, validate required outcomes, insert history, and commit. On failure, roll back and stop. Migration files cannot contain their own transaction boundaries, role switching, connection-target changes, or nontransactional operations. Ensure the reviewed SQL policy and tests enforce the transaction contract; a regex-only safety claim is insufficient.

Release the session lock in `finally` and close the connection. A terminated Lambda cannot be assumed to execute `finally`; server-side deadlines and connection-loss cleanup are the fallback. Verify lock recovery in termination/failure tests. After an uncertain outcome, inspect history under the same lock before retrying or activating an application.

SPEC 11 later adds whole-environment Actions concurrency with `cancel-in-progress: false`. This does not replace the database lock: operators, retries, and unrelated callers can bypass workflow concurrency. Administrative bootstrap remains a separate authorized operation; do not overlap ownership/privilege reconciliation with migrations. Record this operational exclusion in both runbooks.

### Invocation and result contracts

The handler supports only fixed operations: `validate`, `apply`, `baseline_check`, and `baseline_adopt`. Database/schema/role/secret identities come from validated deployment configuration, not the event. The two baseline operations use a separate operator-authorized path; ordinary deployment invocation cannot implicitly adopt an existing schema.

| Request field                                       | Meaning                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `operation`                                         | Fixed allowlisted operation                                             |
| `run_id`, `commit_sha`                              | Correlation and reviewed source identity                                |
| `expected_manifest_sha256`                          | Must match the bundled manifest                                         |
| `expected_history_sha256`                           | Required for activation revalidation and baseline adoption after review |
| `approval_reference`, `expected_schema_fingerprint` | Required only for explicit operator-approved baseline adoption          |

Separate invocation authorization from a caller-provided approval string. Use an operator-only qualified baseline alias/version configured for baseline operations, with ordinary deployment permission restricted to an apply/validate version where baseline adoption is disabled. Both paths use the same private role/schema limits and database lock. Terraform owns their configuration. "Deployment role" in this section means either human `GootipTerraformDeploy` before CI enablement or the distinct SPEC 11 CI deployment role afterward. Neither receives baseline-adoption permission.

Baseline evidence binds the initial migration checksum, live structural fingerprint, current history digest, and approval reference. Revalidate all of them under the lock at adoption time. An event that merely says it was approved is insufficient authorization.

Results contain allowlisted fields: `status`, `operation`, `run_id`, `commit_sha`, `manifest_sha256`, `history_sha256`, `applied_ids`, `pending_ids`, and a bounded `error_code`. Status values include `succeeded`, `no_changes`, `baseline_approval_required`, and `failed`. No raw SQL, pg error detail, password, token, row data, or connection string is returned.

GitHub/operator invocation uses synchronous Lambda request/response with caller timeouts sized for the bounded operation. HTTP/API invocation success is not migration success: inspect Lambda `FunctionError`, decode and validate the response, confirm identities/digests, and accept only the appropriate successful status. A missing or invalid response is failure, even if the Lambda Invoke API returns HTTP 200.

A caller timeout/cancellation is an uncertain database outcome, not proof of rollback. Do not activate. Perform `validate` through the authorized private path after acquiring the lock, reconcile committed history, and retry only if the packaged manifest still matches. Never add a public database endpoint to resolve uncertainty.

After migration success, SPEC 10 revalidates the exact manifest/history result before the first public application apply. SPEC 11 preserves the same revalidation contract for later automated releases. If an out-of-band migration changed history, stop and review the release again. This spec has no schema check that mutates the database during normal application initialization.

### Initial database and verified baseline

If there are no existing authentication application objects or conflicting history, `apply` executes the initial SQL normally. An `auth` schema existing from administrative bootstrap is not itself evidence that application tables exist.

If application objects exist without reliable history, normal `apply` must return `baseline_approval_required` without executing the initial SQL or adopting it. `baseline_check` compares the live structure with a canonical expected structure produced by applying the reviewed initial SQL to a disposable database with a compatible engine.

Comparison includes tables, columns, data types, nullability, defaults, constraints, indexes and validity, sequences, and other relevant application objects. Exclude system objects and migration bookkeeping deliberately. Check unexpected application objects as well as missing ones. Validate owners/grants through the separate privilege contract. A Better Auth additive schema check alone is not a complete baseline-equivalence proof.

On exact approved equivalence, the operator explicitly invokes `baseline_adopt`. Record the initial ID/checksum, source, time, approval reference, and verified structural fingerprint in one transaction, without re-running table creation. The operation is not part of every deployment and cannot be authorized by normal apply input.

On mismatch, block adoption and report sanitized differences. Prepare a reviewed reconciliation migration/procedure for the actual starting structure, then repeat equivalence review. Its execution and any bootstrap of history must have explicit operator authorization and a recorded recovery point. Do not blindly apply the initial migration, drop data, mark false equivalence, or bypass the mismatch with a normal deployment.

## Implementation plan

### Stage A — Generation evidence before approval

1. Inspect the installed Better Auth/adaptor exports, actual plugin/schema configuration, and compatible official CLI releases. Reuse or refine `gootip-auth/src/auth/auth.cli.ts` as the local tool-loadable configuration without booting the Hono server/Lambda or importing AWS secret initialization.
2. Run a disposable PostgreSQL experiment for an empty schema and an existing populated schema at the committed baseline. Generate SQL for an additive configuration/plugin change, inspect the diff, apply it using restricted local migrator privileges, and verify no public-schema changes.
3. Record exact tooling, commands, unsafe-change diagnostics, and reproducible results. If incremental generation fails, evaluate `getMigrations()`/`compileMigrations()` locally and update the strategy before approval. Never infer success from current documentation or static exports alone.

Stage A is a planning/evidence gate. This spec remains Draft until that gate is resolved and the user approves it; cloud implementation is not authorized by writing the spec.

### Stage B — Reviewed artifacts and local runner

4. Add the runner source and its lint, format, test, build, and ZIP commands within `gootip-auth`. Reuse the existing Node/pnpm project and lockfile, keep `pg` bundled as pure JavaScript, and verify Node 24 ARM64 portability. Preserve separate API and migration output paths and ZIPs.
5. Establish ordered committed auth SQL and the manifest format. Add exact-byte hashing and validation for duplicate IDs, paths, source/configuration identity, and missing/extra files. Keep the generation command separate from packaging/application.
6. Implement fixed event/config validation and current-user/database/permission checks. Test with the runtime role, wrong migrator, master-like privileged role, and cross-schema grants; all must fail appropriately before mutation.
7. Implement history creation/validation and protect it from runtime permissions. Test empty history, valid prefixes, unknown entries, changed checksums, gaps, and a manifest older than live history.
8. Implement the session lock and bounded timeouts on one dedicated connection. Test concurrent operations, bounded lock failure, cleanup, and lock recovery after connection termination.
9. Implement transaction-per-migration application and final validation. Test rollback with a partially executed SQL file, preservation of earlier commits, no successful failed-history row, reexecution idempotency, and explicit rejection of nontransactional/transaction-control SQL.
10. Implement structural baseline checks and the separately authorized adoption path. Test empty, matching existing, differing existing, raced-after-review, and repeated baseline cases without deleting data.
11. Use esbuild to produce the smallest practical single ESM handler bundle, then package it with the exact SQL and manifest. Measure compressed and uncompressed ZIP size, enforce the Lambda uncompressed limit, and verify the direct-upload/S3 deployment path. Load the actual bundle in tests and verify handler, file layout, identity/digests, safe result contract, and absence of secret files or runtime CLI downloads.

### Stage C — Private AWS execution

12. After prerequisite completion, apply the reviewed bootstrap-root boundary, PassRole, and operator-invocation additions; then add the auth migration Lambda and operator-only baseline path in Terraform with exact IAM/SG grants and managed logs. Verify the plan introduces no public endpoint, master-secret access, NAT, or unintended service. Preserve the separate administrative Lambda.
13. Invoke the exact private runner version using authorized operator access before SPEC 11 is enabled. Verify RDS TLS, credential identity, default privileges, history protection, logs, runtime DML, and inability to alter/access the other application's objects.
14. Validate response handling with success, no changes, SQL failure, lock timeout, Lambda function error, and caller timeout. Exercise safe history reconciliation and an idempotent retry after an intentionally uncertain outcome.
15. Hand the version, manifest, artifact hashes, and result contract to SPEC 10 for the first manual activation and SPEC 11 for its deployment workflow. After SPEC 11 is enabled, the workflow invokes the exact approved runner version automatically when migrations are required, validates the response and database history, and activates auth only after success. Verify migration failure prevents activation and approval-time revalidation detects changed history.

### Stage D — Operation and recovery

> **Development debt:** before staging/production, remove the temporary
> CloudWatch Logs `CreateLogGroup` and `TagResource`/`UntagResource`
> `Resource: "*"` development grants. Retain only exact-ARN management after
> all required log groups have been created. The read-only regional
> `logs:DescribeLogGroups` grant and the exact-ARN log reader remain.

16. Complete generation, baseline, invocation, concurrent-operation exclusion, and forward-recovery runbooks. Verify backup availability through SPEC 02.2 before sensitive changes. Record the effective timeout, connection budget, and measured dev consumption.
17. Document unsupported long or nontransactional changes. Complete evidence for isolation, idempotency, rollback, baseline, cancellation, and pipeline gating before marking the spec Implemented.

## Dev implementation evidence

Live dev execution on 2026-10-19, account `123456789012`, region `us-east-2`:

| Item | Evidence |
| --- | --- |
| Artifact | `migration-lambda.zip`: 281,023 compressed / 1,087,925 uncompressed bytes, `direct_upload`; contains only `dist/migrations/lambda.mjs`, `000001-initial-auth.sql`, and `manifest.json`. |
| Build regression | ESM bundle now loads under a real Node ESM runtime. The earlier version failed Lambda init with `Dynamic require of "node:https" is not supported`; `build-migration-lambda.mjs` now injects a module-scoped `createRequire`, and `test/migration-artifact.spec.ts` loads the bundle in a child Node process. |
| Validate | `validate` through the `deployment` alias: `succeeded`, `pending_ids: ["000001"]`, manifest digest matched. |
| Apply | `apply` through the `deployment` alias: `succeeded`, `applied_ids: ["000001"]`, `pending_ids: []`, history `b011d077…`. |
| Idempotent revalidation | `validate` with `expected_history_sha256`: `succeeded`, `applied_ids: ["000001"]`, `pending_ids: []`, digest matched. A repeated `apply` returned `no_changes` with the same history digest. |
| Alias authorization | Deployment role can invoke only `:deployment`; invoking `:baseline` is IAM-denied. A correctly formed `baseline_adopt` event sent to `:deployment` returns `failed` / `invalid_request` before credentials or database access. |
| Logs | `/aws/lambda/gootip-dev-auth-migrations`, 7-day retention. Structured `auth_migration` reports contain only operation, status, correlation, counts, reason, and digests; no secrets, SQL, or driver detail. The only init failure recorded is the pre-fix bundle version. |
| TLS and identity | Every accepted invocation completed the runner preflight: TLS `verify-full` against the bundled RDS CA, `auth_migrator` identity, expected attributes/memberships, schema ownership/grants, and no `CREATE` on `public`. Invalid TLS, identity, or privilege configuration fails before SQL mutation. |
| IAM corrections found during deployment | `lambda:CreateAlias` and `lambda:GetAlias`/`UpdateAlias` are evaluated against the unqualified function ARN; publishing a version requires `lambda:GetFunctionConfiguration` on the qualified version ARN. Both are scoped to `gootip-dev-auth-migrations`. |
| Log-group creation | Terraform could not send request tags during `CreateLogGroup`, so the log group was created with the AWS CLI using the same four tags and imported as `aws_cloudwatch_log_group.auth_migrations[0]`; the current policy is the reviewed permanent dev exception described above. |

Remaining acceptance debt (not claimed as complete). These are deferred
operational evidence items and do not block dev development:

| Pending item | Resolution condition |
| --- | --- |
| Negative live TLS probes (wrong CA, hostname mismatch, non-TLS) | Before final infrastructure closure |
| Baseline alias authorization | Before the first `baseline_check` or `baseline_adopt` |
| Live SQL-failure, lock-timeout, and caller-timeout probes | Before declaring SPEC 04 fully accepted |
| Backup/PITR evidence through SPEC 02.2 | Before any destructive migration |
| SPEC 11 pipeline gating and incremental cost measurement | During SPEC 11 and SPEC 06 respectively |

Final dev verification (2026-10-19): Lambda version `2`; `deployment` and
`baseline` aliases both on version `2`; ZIP SHA-256
`34ce634e9af04b23fa58e3983c54fa703673d06e94d85c20eee09a31c6f4d2e0`; manifest
SHA-256 `dbc1563d635cd2ad18f7ad86628e9a8b5a325bf569a67ae5aa0928d6d922234b`.
`validate` returned `succeeded` with no pending migrations and the expected
history digest. Baseline remains fail-closed: the deployment role cannot
invoke the `:baseline` alias, and `baseline_adopt` sent to `:deployment`
returns `failed` / `invalid_request` before credentials or database access.

Incremental SPEC 08 migration verification (2026-10-21): the reviewed
`000002-auth-rate-limit.sql` was packaged with manifest SHA-256
`5794f1ab9089939b0a6e8998789a3123daacfc82cd7d9b1ab54dc239e0a8630c` and ZIP
SHA-256 `176bc7b4a8b22c6824487ee72fe54f9e1573a4ef2117a34de1aa9eeabf794548`.
Lambda version 3 has the matching `CodeSha256`
`F2vHtKiyLGgkSH7nL+VPnhVzpO8hF6NN4aqe6r95RUg=`; `deployment` points to v3 and
the `baseline` alias remains on v2. Pre-apply `validate` reported migration
`000001` applied and `000002` pending. `apply` succeeded for `000002`; final
`validate` succeeded with `applied_ids: ["000001", "000002"]`, no pending IDs,
and history SHA-256
`b1039422517fae6f2a66a3262f41f47033e839f6ce7e62d1cbc2578682cc79e5`.

## Acceptance criteria

### Generation and review

- [ ] The actual Better Auth 1.7.7 integrated Kysely adapter and `auth` schema configuration are recorded.
- [ ] Exact compatible official tooling passes the local initial/incremental existing-data proof before final strategy approval.
- [ ] A failed CLI proof leads to documented programmatic evaluation and re-review, not an unapproved AWS fallback.
- [ ] SQL is reviewed, ordered, committed in `gootip-auth/migrations/`, and hashed from exact bytes.
- [ ] Auth migration generation and runner source are maintained in `gootip-auth`; no standalone or shared auth/core migration project is created.
- [ ] Packaging never generates or applies new migration SQL.
- [ ] The migration Lambda ZIP is distinct from the auth API ZIP and contains only its handler, reviewed SQL, and manifest; the manifest and every included file are hash-validated before database mutation.
- [ ] The handler is a single minified ESM esbuild bundle; packaging excludes unnecessary dependencies, source files, and source maps while retaining required runtime behavior.
- [ ] Packaging and CI report compressed and uncompressed ZIP size, reject contents above 250 MB including layers, and use the exact verified S3 artifact when the ZIP exceeds the 50 MB direct-upload limit.
- [ ] The SQL files and manifest are bundled in the migration ZIP and no runtime artifact download or SQL supplied through the invocation event is needed.
- [ ] The manifest ties SQL to the source/configuration and rejects invalid IDs, paths, files, or checksums.
- [ ] Better Auth CLI numbering/history behavior is not assumed; the committed SQL ledger supplies it explicitly.

### Database and authorization

- [x] The private auth runner has an independent execution role, SG, and managed log group.
- [x] Its deployed runtime is Node.js 24 ARM64; `migration-lambda.zip` contains the separate `dist/migrations/lambda.mjs` handler and reviewed SQL/manifest, and passes bundle tests without changing the auth API ZIP contract.
- [x] No public API, Function URL, automatic schedule, or application-role invocation grant exists.
- [ ] The normal deployment workflow invokes the qualified migration Lambda version when validation/application is required, waits for its verified result, and blocks auth activation on failure or uncertainty. Before SPEC 11 is enabled, only the authorized operator invokes it manually.
- [x] The execution role can retrieve only the intended `auth_migrator` credential, never master or runtime credentials.
- [x] Each invocation reads current credentials and rejects an unexpected role, database, or privilege configuration.
- [x] TLS and private networking work through existing RDS/Secrets Manager connectivity without NAT/new endpoints.
- [ ] `auth_migrator` can create or alter its required objects but cannot alter unrelated application objects in `public`.
- [x] Runtime roles cannot perform DDL, assume migrators, forge history, or read migrator/master secrets.
- [ ] Objects created by the migrator receive expected runtime grants without granting runtime access to migration bookkeeping.
- [ ] `lambda_db_config` from SPEC 03 provisions privileges only and never runs Better Auth or TypeORM migrations.
- [x] No secret appears in source artifacts, Terraform/state, events, responses, or tested logs/errors.

### History, locking, and failure behavior

- [ ] History records ID, checksum, time, source, run identity, and baseline approval evidence when applicable.
- [ ] Unknown/gapped/altered history or a manifest behind live history blocks before pending SQL executes.
- [ ] Pending SQL runs in order, one transaction per migration, with its history insert in the same commit.
- [ ] Failed SQL rolls back that migration and stops; earlier commits remain correctly recorded.
- [x] No-change reexecution is successful and creates no duplicate history or schema objects.
- [ ] The exclusive session lock uses a stable database/schema identity and one dedicated connection.
- [ ] Lock acquisition is bounded and concurrent execution cannot apply overlapping migrations.
- [ ] `finally` cleanup and termination/connection-loss fallback are tested without assuming Lambda always runs cleanup code.
- [ ] Timeouts leave a cleanup margin within Lambda/caller limits and unresolved outcomes block activation.
- [ ] Nontransactional SQL and transaction/role-control statements are rejected under a reviewed, tested SQL policy.
- [x] Invoke HTTP 200 alone is not accepted; `FunctionError`, response identity, digest, and status are checked.
- [ ] A timeout retry first reconciles committed history under the lock and does not blindly rerun uncertain SQL.
- [ ] Migration success is revalidated after activation approval waits; changed history prevents activation.

### Baseline and future integration

- [ ] A base without authentication objects applies the initial migration normally.
- [ ] Existing objects without reliable history require explicit baseline review instead of automatic initial SQL.
- [ ] Baseline comparison checks relevant tables, columns, types, defaults, constraints, indexes, sequences, and unexpected objects.
- [ ] Only the authorized operator-only path can adopt a baseline; ordinary deployment cannot enable it through an input string.
- [ ] Adoption revalidates fingerprint/history/checksum and records its approval without recreating application objects.
- [ ] A baseline mismatch blocks and requires reviewed corrective work without dropping data or fabricating equivalence.
- [x] Application startup keeps migrations disabled and `synchronize=false` in AWS.
- [ ] No core implementation or speculative core role/secret is introduced.
- [x] Runbooks cover backup verification, forward correction, compatible code rollback, private restore, and uncertainty recovery.
- [ ] Tests cover empty/existing databases, wrong permissions, checksums, rollback, locking, retries, and baseline authorization.
- [ ] The runner exposes the managed-log contract consumed by SPEC 06, and its measured incremental dev cost is recorded for the SPEC 10 deployment gate.

## Decisions

- **Yes:** isolated native Lambda for infrequent bounded dev migrations. It reuses the private VPC and Secrets Manager path with no persistent migration compute.
- **Yes:** keep auth migration source, generation commands, reviewed SQL, and runner code in `gootip-auth`; build a distinct migration ZIP and deploy a distinct Lambda so application and migration credentials remain isolated.
- **Yes:** reuse esbuild to produce one minified ESM handler bundle per Lambda and keep each ZIP to the minimum runtime payload; the migration ZIP additionally contains its reviewed SQL and manifest.
- **Yes:** treat migration execution as a required step in the SPEC 11 deployment workflow so it is not a manual reminder; until that workflow is enabled, use the reviewed operator invocation path.
- **No:** centralize auth and core migration files or generation systems. Each application owns the migrations for its schema; shared deployment orchestration may invoke their separate runners.
- **No:** ECS/Fargate or another ephemeral job initially. Image retrieval/connectivity and extra infrastructure are unnecessary for the bounded SQL workload. Reconsider only for proven long/nontransactional work.
- **Yes:** reviewed SQL plus an explicit checksum/history ledger, conditional on the local generation evidence gate.
- **No:** CLI download, interactive migration generation, `auth migrate`, or unreviewed `runMigrations()` during ordinary AWS deployment.
- **Yes:** transactions per migration, a session advisory lock, and separate Actions serialization address different failure/concurrency boundaries.
- **Yes:** explicit operator-only verified baseline adoption preserves existing data and meaningful history.
- **Yes:** internal history privilege revocation prevents default runtime grants from permitting ledger tampering.
- **Yes:** forward-compatible expand changes and explicit recovery. Down migrations and code rollback do not automatically recover data.
- **No:** application DDL, master-secret use, admin-Lambda reuse, nontransactional SQL, or automatic destructive schema promotion.

## Recovery and operational limits

Require migrations compatible with the currently active and intended application versions. Prefer expand-and-correct changes. Defer destructive contract steps to a separately reviewed operation with evidence that older versions no longer depend on removed objects.

Verify SPEC 02.2's actual backup/PITR availability before sensitive work; configured retention is not proof of an existing recovery point. Use explicit operator approval and recorded backup evidence for destructive schema changes outside the normal deployment path. Do not create a snapshot for every harmless invocation without a cost/need assessment.

On failure, keep the current application active, inspect sanitized results/history, and prepare a forward correction. Alias rollback is allowed only when the previous code remains schema-compatible. Snapshot/PITR restore is an authorized private recovery procedure with potential data loss since the chosen recovery time, endpoint/secret reconciliation, and reviewed cleanup. It is not an automatic down migration.

Database locks and statement waits count toward the Lambda limit. Long data backfills, large blocking DDL, or nontransactional index creation require another plan/job strategy. Do not silently split unsafe SQL across invocations or assume a killed Lambda rolled everything back.

## Observability and AWS Free plan constraints

Expose structured, sanitized runner events for SPEC 06's seven-day CloudWatch logs and standard error/throttling alarms. Log only operation/run identity, release/manifest/migration IDs, safe timings, status, and bounded error codes. Sanitize pg error fields and avoid SQL text, row values, tokens, passwords, or unfiltered exception stacks. Native Lambda logging does not require adding a VPC Logs endpoint.

Reuse the RDS connection monitoring and account credit/expiry alerts added by SPEC 06. The dedicated runner connection counts toward SPEC 08's measured connection budget. Reserved concurrency can bound Lambda invocations but cannot replace the database lock or become provisioned concurrency.

Estimate on-demand Lambda duration/requests, deployment-version storage, CloudWatch usage, Secrets Manager retrieval, and any cross-AZ traffic. Reuse SPEC 03's migrator secret rather than adding redundant credential storage. Check current `us-east-2` eligibility and remaining credits; no permanently free pricing assumption, new persistent host, or Paid plan conversion is part of this spec.

## Risks

| Risk                                                                    | Mitigation                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Official generator emits a snapshot rather than a safe incremental diff | Mandatory local existing-data proof; programmatic evaluation and re-review if needed                     |
| Additive schema diagnostics miss a baseline difference                  | Canonical structural comparison including constraints/indexes/defaults and unexpected objects            |
| Runtime default grants leak access to history                           | Revoke bookkeeping grants and test runtime history denial alongside normal DML                           |
| Advisory lock is held on a different connection from SQL                | Use one dedicated session for the complete auth migration operation.                                     |
| A cancelled caller assumes all SQL was rolled back                      | Block activation, reacquire lock, inspect committed history, and retry idempotently                      |
| Lambda termination skips cleanup                                        | Bounded server-side timeouts, connection closure behavior, and termination tests                         |
| Changed history invalidates a previously successful migration result    | Manifest/history digest revalidation immediately before activation                                       |
| A baseline approval string is forged by an ordinary deployment          | Operator-only qualified invocation path with adoption disabled for deploy callers                        |
| SQL reaches unrelated `public` objects through inherited grants         | Effective role/ownership audit and negative cross-schema database tests                                  |
| Administrative bootstrap races ownership with migrations                | Separate authorized operation window and explicit runbook exclusion                                      |
| Several migrations succeed before a later one fails                     | Preserve per-migration history; correct forward; never claim full-run atomicity                          |
| Sensitive SQL blocks application traffic or outlasts Lambda             | Compatible changes, measured statement/lock limits, backup/review, and a separate strategy for long work |

## References

- [Better Auth database and migration concepts](https://www.better-auth.com/docs/concepts/database).
- [Better Auth CLI generation and migration commands](https://www.better-auth.com/docs/concepts/cli).
- [Better Auth PostgreSQL schema selection](https://www.better-auth.com/docs/adapters/postgresql).
- Installed 1.7.7 exports and declarations: `gootip-auth/node_modules/better-auth/package.json` and `dist/db/get-migration.d.mts`.
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
- [AWS Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).
- [AWS Lambda Invoke response semantics](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html).

## What is **not** in this spec

- Administrative role provisioning, master credentials, or application-startup migrations.
- Core-service implementation, a shared auth/core privileged Lambda, or frontend hosting.
- GitHub Actions workflow/OIDC implementation, independent application publication, or alias ownership outside Terraform; SPEC 11 consumes this spec's invocation contract.
- Unreviewed dynamic migration application, automatic baseline adoption, automatic down migrations, or nontransactional/long-running jobs.
- Public database access, NAT, persistent compute, additional chargeable endpoints, or a Paid plan upgrade.
