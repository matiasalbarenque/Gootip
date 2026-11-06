# SPEC 05 — Authentication Runtime Credentials

> **Status:** Implementation complete for dev; deferred operational evidence
> **Depends on:** SPEC 02.1, SPEC 02.2, SPEC 03, SPEC 04
> **Date:** 2026-10-15
> **Objective:** Prepare the first `gootip-auth` deployment to use only the restricted `auth_runtime` database credential and remove every application reference and permission for the RDS master secret.

## Why this spec exists

SPEC 03 creates the database roles and bootstrap-owned role-secret containers under the SPEC 02.1 control plane, while SPEC 04 creates the application schema through the restricted migrator. The authentication Lambda has not been deployed, so this stage establishes the correct runtime contract before its first AWS activation instead of performing a privileged-to-restricted live cutover.

The RDS foundation already exists from SPEC 02.2, but no public application exists. Configuration and artifacts can therefore remove master access without preserving a temporarily privileged application path.

## Scope

**In:**

- Authentication Lambda environment configuration for the `auth_runtime` secret ARN.
- Authentication IAM permissions limited to the application secret and `auth_runtime` secret.
- Removal of authentication access to the RDS master secret.
- Runtime loading and validation of the `auth_runtime` username and password.
- Better Auth connection as the only database client in `gootip-auth`.
- Verification that the Better Auth client uses the shared TLS layer from SPEC 02.2 and the TLS contract accepted by SPEC 03.
- Local and deployment documentation for loading the runtime credential and performing the cutover.
- Local artifact and loader checks plus direct restricted-role database checks; SPEC 10 owns the first deployed authentication smoke test.

**Out of scope (for future specs):**

- Creating or changing PostgreSQL roles; SPEC 03 owns that operation.
- Better Auth schema migration execution or application startup migrations.
- TypeORM configuration or migration support.
- Further Hono architecture changes, core runtime credentials, or core deployment.
- Scheduled credential rotation, automatic pool refresh, or RDS Proxy.
- General IAM hardening beyond the exact authentication secret allowlist.

## Data model

### Authentication secret contract

The authentication Lambda reads:

| Secret                           | Use                              |
| -------------------------------- | -------------------------------- |
| Existing application secret      | `BETTER_AUTH_SECRET`             |
| `${project}-${env}-auth-runtime` | PostgreSQL username and password |

The runtime secret must contain:

```json
{
  "username": "auth_runtime",
  "password": "loaded-out-of-band"
}
```

The loader rejects a missing secret, missing password, malformed JSON, or a username different from `auth_runtime` before application initialization. It never logs the value.

The Lambda must not receive `DB_MASTER_SECRET_ARN` after cutover. The master secret remains available only to the administrative function.

### Effective IAM contract

The authentication execution role can call `secretsmanager:GetSecretValue` only for:

- The existing application secret.
- The `auth_runtime` secret.

It cannot read the RDS master secret, either by the default reference or through an override. Secret ARNs are references only and never secret values.

### Files and boundaries

Expected changes:

- `gootip-infra/lambda.tf`, `iam.tf`, reference-only `secrets.tf`, `variables.tf`, `environments/dev.tfvars`, and `README.md`; no secret-container ownership moves into the application root.
- `gootip-auth/src/lambda.ts`, `src/auth/auth.ts`, `src/config/`, and affected tests.

The Better Auth pool continues to use `/opt/certs/rds-ca-bundle.pem` and verified TLS. No TypeORM client is added or restored.

## Implementation plan

1. Confirm that SPEC 03 created the `auth_runtime` role and exact secret container and that SPEC 04 established the reviewed auth schema. Record the non-secret ARN reference and the reviewed `GootipBootstrapAdmin` value-loading procedure; do not grant value or container management to `GootipTerraformDeploy`.
2. Replace the authentication Lambda's master-secret environment reference with `DB_RUNTIME_SECRET_ARN` pointing to the `auth_runtime` container. Remove the master-secret reference from the function configuration.
3. Update `gootip-auth/src/lambda.ts` to load and validate the runtime username/password before creating Better Auth and the Hono Lambda handler. Keep application-secret loading separate and preserve fail-fast behavior.
4. Update the Better Auth connection configuration to use the loaded runtime credential and the shared verified TLS CA path. Confirm that Better Auth is the only initialized database client.
5. Reconcile the authentication IAM policy with the effective secret references. Test allowed reads, denied master-secret reads, denied migrator/core-secret reads, and no secret-value writes.
6. Build and inspect the undeployed Lambda artifact, exercise the loader and Better Auth client against disposable PostgreSQL, and use an authorized private check to prove that `auth_runtime` has required DML but no DDL, cross-schema, or migration-history capability.
7. Complete the first-deployment and rollback runbook for SPEC 10. No rollback path may introduce the master secret into the application configuration.

## Dev implementation evidence

Local verification on 2026-10-19; no application deployment was performed
(`application_runtime_deployment_enabled` remains `false`).

| Item | Evidence |
| --- | --- |
| Artifact | `lambda.zip` contains only `dist/lambda.mjs` (1,765,212 uncompressed / 465,975 zip bytes, SHA-256 `ce6817594715c803dab65c1c808bb46cfd4b81293689d1354630f39c25449340`). The bundle has zero `DB_MASTER_SECRET_ARN` occurrences and one `DB_RUNTIME_SECRET_ARN`. |
| Loader | `loadSecretsToEnv` applies the validated `auth_runtime` username and password and preserves an existing `BETTER_AUTH_SECRET`. Missing secret, malformed/non-object JSON, missing value, missing username or password, and a username other than `auth_runtime` abort before Better Auth, the Hono app, or any connection exists. A `GetSecretValue` failure is replaced with a fixed message naming only `SECRET_ARN` or `DB_RUNTIME_SECRET_ARN`; the SDK error and its cause are dropped, and the test asserts the secret ARN and payload never appear in the message. |
| Runtime database proof | `gootip-auth/test/runtime-integration.spec.ts` against a disposable `postgres:18` container: the reviewed migration is applied as `auth_migrator`, the runner creates the migration history table, the real loader (stubbed Secrets Manager) sets `POSTGRES_DB_USER=auth_runtime`, and the real Better Auth client signs up a user (`auth.api.signUpEmail`); a direct `auth_runtime` connection then reads, updates, and deletes that row. 3/3 pass. |
| Negative PostgreSQL proof | Same run, every probe refused with SQLSTATE `42501`: `CREATE TABLE auth.evil`, `CREATE TABLE public.evil`, `CREATE SCHEMA`, `SELECT` from master-owned `public.master_only`, and `SELECT`/`INSERT`/`DELETE` on `auth.gootip_schema_migrations`. |
| Role contract reused from SPEC 03 | `uv run pytest -m integration` in `gootip-db-config`: 12/12 against a disposable container. `auth_runtime`/`auth_migrator` are non-superusers without `CREATEDB`/`CREATEROLE`, runtime DML works on future migrator objects, runtime DDL is denied, the migrator owns `auth`, runtime is not a member of the migrator, and master-owned/`public` objects are unreachable. Inputs unchanged since SPEC 03. |
| History isolation reused from SPEC 04 | `test/migration-integration.spec.ts` (`MIGRATION_TEST_DATABASE_URL`, disposable `postgres:18`): 12/12. The history table is owned by the migrator with zero effective runtime privileges. Inputs unchanged since SPEC 04. |
| IAM | `gootip-infra/scripts/tests/test_iam_policy_guardrails.py` `AuthRuntimeSecretScopeTests`: source-level scope checks plus a materialized render assertion that the authentication role reads exactly the application secret and `var.auth_runtime_secret_arn`, with no master, migrator, or unrelated ARN, and no Secrets Manager write action or `iam:` action. |
| Terraform and application checks | `terraform fmt -check -recursive` and `terraform validate` clean for the application root and `bootstrap/`; focused guardrail pytest green; `gootip-auth` `test` 218 passed / 15 skipped, `typecheck`, `lint`, `format:check`, `build`, and `build:lambda` green. |

Remaining acceptance debt (deferred operational evidence; does not block dev
development):

| Pending item | Resolution condition |
| --- | --- |
| Live private role probe as `auth_runtime` against the dev RDS instance (DDL, `public`, and history denials from inside the private network) | Before final infrastructure closure; no authorized private diagnostic client exists today, so the equivalent proof was executed against disposable PostgreSQL with the real SPEC 03 bootstrap code, the SPEC 04 runner history DDL, and the real Better Auth client. |
| Deployed database-backed authentication smoke test | SPEC 10 acceptance item. |
| Full-repository `verify_full.sh` cycle | Pre-existing SPEC 04-owned findings (`GootipTerraformDeployAuthMigrationsPermissions` wildcards and the bootstrap policy-split comparator baseline) reproduced unchanged on base commit `bce71f6`; outside SPEC 05 scope. |

No rollback path reintroduces the master secret; see the first-deployment and
rollback runbook in `gootip-infra/README.md`.

## Acceptance criteria

- [x] The spec depends on SPEC 03 for the database contract, SPEC 04 for the auth schema, and SPEC 02.1 for AWS identity, boundaries, PassRole, backend/account guards, and secret ownership. — Evidence: dependency header; the SPEC 03 and SPEC 04 contracts are consumed unchanged.
- [x] The authentication Lambda receives the `auth_runtime` secret ARN and not the master secret ARN. — Evidence: `gootip-infra/lambda.tf` exposes only `SECRET_ARN` and `DB_RUNTIME_SECRET_ARN`; no master reference remains in the application root.
- [x] The authentication IAM policy permits only the application and `auth_runtime` secret ARNs. — Evidence: `iam.tf` `secrets_read` resources are exactly `[var.app_secret_arn, var.auth_runtime_secret_arn]`, asserted on the rendered plan.
- [x] Authentication cannot read the master, `auth_migrator`, or any unrelated future secret. — Evidence: the rendered policy contains only those two ARNs; `AuthRuntimeSecretScopeTests` asserts the master and migrator fixtures are absent.
- [x] Authentication cannot write Secrets Manager values or modify IAM. — Evidence: the policy has a single read action, no Secrets Manager write action, and no `iam:` action; the role keeps only the reviewed attachments.
- [x] The loader rejects malformed, incomplete, or username-mismatched runtime credentials before Better Auth or the Hono handler is initialized. — Evidence: `test/lambda.spec.ts` negative cases and the fail-fast `bootstrap()` order.
- [x] The loader never logs passwords, secret JSON, connection strings, or raw secret errors. — Evidence: the loader performs no logging and replaces `GetSecretValue` failures with a fixed message naming only the environment variable, without ARN, payload, or cause.
- [x] Better Auth connects as `auth_runtime` and uses verified TLS through the shared CA layer. — Evidence: `test/runtime-integration.spec.ts` signs up as `auth_runtime`; `test/auth.spec.ts` covers the CA path and `rejectUnauthorized: true`; the Lambda uses `verify-full` with `/opt/certs/rds-ca-bundle.pem`.
- [x] `gootip-auth` initializes no TypeORM client. — Evidence: no `typeorm` dependency, import, or `synchronize` setting exists in the project.
- [x] No application startup path executes migrations or schema synchronization. — Evidence: `src/lambda.ts` and `src/server.ts` import only `app`, `auth`, and `env`; no migration reference exists in a startup path.
- [x] Local Better Auth and private role checks succeed against the reviewed schema; the first deployed database-backed smoke test is an explicit SPEC 10 acceptance item. — Evidence: `runtime-integration` 3/3 plus the reused SPEC 03 and SPEC 04 suites; the deployed smoke test is deferred to SPEC 10.
- [x] Negative IAM and PostgreSQL permission tests confirm that runtime authentication cannot perform DDL or access the `public` application boundary. — Evidence: `AuthRuntimeSecretScopeTests` plus SQLSTATE `42501` denials for DDL, cross-schema creation, the `public` boundary, and migration-history access.
- [x] Terraform, application build, lint, format, and affected tests pass. — Evidence: `terraform fmt -check -recursive`, `terraform validate` (application root and `bootstrap/`), the focused guardrail pytest, and the green `gootip-auth` test/typecheck/lint/format/build checks listed above.
- [x] Cutover and rollback procedures are documented and rollback does not reintroduce master-secret access as a normal configuration. — Evidence: the `gootip-infra/README.md` runbook keeps the application disabled on rollback and forbids the master secret as fallback configuration.

## Decisions

- **Yes:** `auth_runtime` is the only PostgreSQL credential included in the first deployable Better Auth configuration. The application is never intentionally deployed with the RDS administrator.
- **Yes:** the master credential remains exclusively administrative.
- **Yes:** username validation is mandatory because a password alone does not prove that the intended role is being used.
- **Yes:** Better Auth remains the only database client in the current auth project.
- **No:** keeping master-secret access as a warm-refresh or fallback mechanism.
- **No:** application migrations, TypeORM initialization, unrelated Hono architecture work, or core deployment.
- **No:** Terraform-managed secret values or automatic credential rotation.

## Risks

| Risk                                                     | Mitigation                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Runtime secret username does not match the database role | Validate the username before creating the application.                                                                        |
| IAM and Lambda environment references diverge            | Derive both from the same effective Terraform reference and test the policy.                                                  |
| Auth tables are absent or migration history is invalid   | Keep deployment blocked until SPEC 04 succeeds; do not grant runtime DDL.                                                     |
| A rollback restores master access                        | Keep the application disabled and require a new reviewed runtime configuration instead.                                       |
| A warm Lambda retains an old credential                  | Include bounded refresh/restart behavior in a later dedicated credential-rotation spec; this stage validates new cold starts. |

## What is **not** in this spec

- PostgreSQL role creation, schema bootstrap, or migration execution.
- TypeORM configuration or unrelated Hono architecture changes.
- Automatic rotation, pool replacement, RDS Proxy, CI/CD, or broad IAM redesign.
- Core service implementation or core runtime cutover.
- Public database access, NAT, or a Paid plan upgrade.
