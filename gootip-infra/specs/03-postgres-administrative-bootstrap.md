# SPEC 03 — PostgreSQL Administrative Bootstrap

> **Status:** Implementation complete for dev; deferred operational evidence
> **Depends on:** SPEC 02.1, SPEC 02.2
> **Date:** 2026-10-15
> **Objective:** Create an isolated Python administrative Lambda that bootstraps PostgreSQL schemas, roles, ownership, grants, and role secret containers without executing application migrations.

## Why this spec exists

SPEC 02.2 deploys RDS without deploying the authentication Lambda. A separate administrative boundary is required before the application can use a restricted runtime credential, so this stage defines the initial database roles and schemas before any public application exists.

This spec creates the administrative capability only. Application migrations are owned by SPEC 04, and authentication runtime configuration is owned by SPEC 05.

SPEC 02.1 remains the source of truth for human roles, account/backend guards, application IAM boundaries, PassRole, and secret-container ownership. This spec defines two authentication database-role containers and administrative runtime permissions, but they must enter the control plane through a reviewed bootstrap-root expansion before the application root references them.

## Scope

**In:**

- New sibling project `gootip-db-config/` implemented in Python.
- Python 3.13, ARM64 Lambda, `psycopg` 3, `boto3`, `uv`, `pytest`, and Ruff with pinned versions.
- Native Lambda handler with no HTTP framework, API Gateway, Function URL, or scheduled trigger.
- Terraform-managed `aws_lambda_function.gootip_db_config` with physical name `lambda_db_config`.
- Private subnet connectivity, an independent administrative security group, and exact Secrets Manager permissions.
- Shared RDS CA layer from SPEC 02.2 and `psycopg` TLS verification.
- Live verification of the foundation TLS contract, including certificate and hostname validation, `pg_stat_ssl`, and rejection of a non-TLS connection.
- Two non-superuser roles: `auth_runtime` and `auth_migrator`.
- `auth` schema ownership, grants, default privileges, and removal of permissive database or `public` grants that defeat isolation.
- Two empty Secrets Manager containers for role credentials, owned by the SPEC 02.1 bootstrap root; the application root receives only their exact ARNs.
- Fixed operation contract with no arbitrary SQL, passwords, role names, or database targets in events.
- Readable Python modules separated by responsibility with docstrings and task-oriented comments.
- Local disposable PostgreSQL integration tests for idempotency, isolation, defaults, and concurrency.
- Operator documentation for loading credentials and invoking or revoking administrative access.

**Out of scope (for future specs):**

- Changing `gootip-auth` to use `auth_runtime`; SPEC 05 owns that configuration.
- Better Auth or TypeORM migration execution.
- Creating application tables or business tables.
- Deploying `gootip-core` or a core migration executor.
- Automatic password rotation or scheduled invocation.
- Arbitrary SQL supplied by an event or operator.
- CI/CD, OIDC, replacement of the SPEC 02.1 IAM/account-guard architecture, or observability resources owned by later specs.

## Data model

### Database access contract

| Role            | Intended schema | Runtime or migration capability                                                     |
| --------------- | --------------- | ----------------------------------------------------------------------------------- |
| `auth_runtime`  | `auth`          | Schema usage, required table DML, and required sequence access; no DDL or ownership |
| `auth_migrator` | `auth`          | DDL and ownership for auth application objects only                                 |

Both roles are non-superusers. They cannot create databases or roles, replicate, bypass row-level security, or assume another service role. `auth_runtime` is not a member of `auth_migrator`. Access outside `auth`, including application objects in `public`, is denied by effective privilege tests, not by `search_path` alone.

Default privileges target the actual object-creating migrator. Existing and future application tables and sequences receive runtime grants. Administrative and migration bookkeeping objects do not receive runtime write access.

### Secret containers

Terraform creates empty containers with these names:

```text
${project}-${env}-auth-runtime
${project}-${env}-auth-migrator
```

Values are loaded out of band. Each value contains `username` and `password`. The administrative loader validates that the username matches the configured role before any SQL mutation.

Each authorized operation reads the current master and role-secret versions. A warm administrative environment must not reuse credentials cached before RDS-managed master credential rotation.

The policy transition uses two reviewed bootstrap applies because complete generated secret ARNs do not exist before container creation. The first apply grants `GootipBootstrapAdmin` temporary `CreateSecret` constrained by the two exact names and required Gootip tags, creates the empty containers, and does not permit loading their values. Bootstrap then obtains and validates the two complete generated ARNs. The second apply removes `CreateSecret`, expands the application-secret-only `NotResource` exception from SPEC 02.1 to exactly those three approved ARNs, and retains container refresh/tag permissions plus manual `DescribeSecret`, `GetSecretValue`, and `PutSecretValue` only on them. The exact RDS master-secret denial remains unchanged. Values are loaded and ARN references are exposed to the application root only after the second apply and its negative authorization checks pass.

### Python project boundary

The implementation must favor readable modules over a single handler file or one-line methods. The exact filenames may be selected during implementation, but responsibilities must remain separated into modules for:

- Handler and fixed event validation.
- Environment/configuration validation.
- Secrets Manager loading and credential validation.
- TLS PostgreSQL connection creation and timeouts.
- Database inventory and role/schema inspection.
- Role, schema, ownership, grants, and default-privilege reconciliation.
- Transaction and advisory-lock coordination.
- Safe result formatting and sanitized error handling.

Each public method has a descriptive name, a docstring explaining its task, and comments only where the SQL or security boundary is not self-evident. The handler coordinates modules and does not contain the full bootstrap SQL.

### Fixed invocation contract

The only accepted operation is `bootstrap`. Database identity, role names, schema names, secret ARNs, and CA path come from validated environment configuration. The event cannot provide SQL, alternate targets, passwords, or arbitrary role names.

Results contain only operation status, a correlation ID, and non-sensitive reconciliation counts. Raw SQL errors, credentials, connection strings, and database values never appear in logs or responses.

## Implementation plan

1. Create `gootip-db-config/` with pinned Python tooling, reproducible ARM64 packaging, Ruff, pytest, and a minimal Lambda handler. Verify the project runs locally without an HTTP server.
2. Implement configuration validation, fixed event validation, and Secrets Manager loading. Test missing fields, invalid usernames, secret values with no password, and arbitrary event fields before connecting to PostgreSQL.
3. Implement the TLS connection factory using `psycopg` 3, `sslmode=verify-full`, the shared layer path, RDS hostname validation, bounded connection/statement timeouts, and no secret logging. Verify the deployed layer, a valid encrypted session, wrong-CA rejection, hostname-mismatch rejection, and non-TLS rejection against the SPEC 02.2 database.
4. Implement inventory and reconciliation modules for schemas, roles, ownership, memberships, grants, and default privileges. Keep SQL explicit, named by task, and transaction-safe.
5. Add the stable advisory-lock protocol and idempotent bootstrap transaction. Concurrent invocations must serialize and repeated invocations must produce no destructive changes.
6. Add the administrative Lambda, networking, and bounded application IAM resources to the application root. In a prior reviewed bootstrap-root change, perform the exact secret-policy transition, create or import the two empty role-secret containers, remove temporary `CreateSecret`, and expand the SPEC 02.1 runtime boundary and exact PassRole allowlist as required. Verify the final policy uses only complete generated ARNs and preserves the RDS master-secret denial. Do not grant `GootipTerraformDeploy` secret-container or secret-value management.
7. Build a disposable PostgreSQL test fixture. Verify runtime DML, runtime DDL denial, migrator DDL, cross-schema denial, role-membership denial, future-object grants, repeated invocation, and concurrent invocation.
8. Load non-production role credentials through the reviewed `GootipBootstrapAdmin` procedure after its exact-ARN permissions are approved, invoke the function through the separately authorized operator procedure, inspect the sanitized response, and document revocation and re-enable steps.

## Acceptance criteria

- [x] `gootip-db-config` is Python 3.13, ARM64-compatible, and uses pinned `psycopg` 3, `boto3`, pytest, Ruff, and reproducible packaging.
- [x] The project has no HTTP framework and no public or scheduled trigger.
- [x] Terraform creates `aws_lambda_function.gootip_db_config` with physical name `lambda_db_config`.
- [x] The administrative Lambda uses an independent execution role and security group.
- [x] The Lambda uses the shared CA layer and `psycopg` verifies the RDS certificate and hostname.
- [x] The deployed layer contains only `certs/rds-ca-bundle.pem` and exposes it at `/opt/certs/rds-ca-bundle.pem`.
- [x] A real administrative Lambda bootstrap on 2026-10-18 connected with `verify-full` and succeeded; `db.connect` checked its own backend in `pg_stat_ssl` and rejects a non-encrypted session.
- [ ] **Acceptance debt:** live wrong-CA, hostname-mismatch, and non-TLS rejection probes remain deferred. There is no private diagnostic client, and this spec will not add an operational surface solely for those probes.
- [x] IAM allows the function to read only the master secret and two configured authentication-role secrets.
- [x] Bootstrap Terraform owns the two empty role-secret containers; Terraform creates no secret values, and the application root consumes exact ARN references only.
- [x] Bootstrap uses name-and-tag-constrained `CreateSecret` only for the reviewed container-creation apply, removes it immediately afterward, and updates the manual-value `NotResource` exception to exactly the three approved complete secret ARNs while preserving the exact RDS master-secret denial.
- [x] Missing or invalid credentials fail before SQL mutation.
- [x] Each authorized operation reads current master and role-secret versions, including after RDS-managed master credential rotation.
- [x] Only the fixed `bootstrap` operation is accepted.
- [x] Events cannot select SQL, database targets, schemas, roles, passwords, or secret ARNs.
- [x] Bootstrap creates the two non-superuser authentication roles and `auth` schema idempotently.
- [x] Runtime roles cannot create/alter/drop application objects or assume migrator roles.
- [x] `auth_migrator` is restricted to `auth` and cannot alter unrelated application objects in `public`.
- [x] Existing and future application tables and sequences receive intended runtime grants.
- [x] Runtime roles cannot modify migration or administrative bookkeeping objects.
- [x] Repeated invocation preserves schemas, roles, and data and reports no destructive action.
- [x] Concurrent invocations cannot reconcile conflicting state simultaneously.
- [x] Secret values, passwords, raw SQL, and unfiltered database errors are absent from artifacts, events, responses, and logs.
- [x] Integration tests cover positive and negative PostgreSQL permissions and concurrency.
- [ ] Operator loading and invocation were exercised for development; revocation and recovery remain operational evidence debt.

## Decisions

- **Yes:** Python 3.13 with `psycopg` 3. It is the requested implementation language and provides a direct PostgreSQL client without an application framework.
- **Yes:** ARM64 native Lambda with dependencies packaged into the ZIP. No runtime package download is allowed.
- **Yes:** create only `auth_runtime`, `auth_migrator`, and their two secret containers because authentication is the only executable database-backed service.
- **No:** pre-provision future core roles or secrets. The future core service must define its real schema and permission needs in its own reviewed spec.
- **Yes:** Terraform manages containers but never secret values; container creation and operator-value permissions remain in the reviewed bootstrap control plane.
- **Yes:** readable modules, docstrings, task comments, and explicit SQL responsibilities take priority over compressed abstractions.
- **No:** application migrations in the administrative Lambda. Migration execution requires a separate reviewed executor.
- **No:** arbitrary SQL or dynamic administrative targets in events.
- **Yes:** dependency on SPEC 02.1 for AWS identities, boundaries, PassRole, backend/account guards, and secret-container ownership; this spec does not redesign those controls.
- **Yes:** complete the live TLS acceptance here because this is the first private client deployed after the SPEC 02.2 foundation.

## Risks

| Risk                                                         | Mitigation                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `psycopg` native packaging is incompatible with Lambda ARM64 | Build in a Linux ARM64-compatible environment and import/test the built artifact.                                  |
| Default `PUBLIC` or database grants leak isolation           | Inventory effective privileges and run negative tests with each role.                                              |
| Concurrent bootstrap invocations race                        | Use a stable PostgreSQL advisory lock and bounded acquisition timeout.                                             |
| Terraform or logs expose secret values                       | Keep values out of Terraform and sanitize all responses and errors.                                                |
| Future core work copies the authentication boundary          | Require a separate spec based on the actual core service and schema instead of pre-provisioning speculative roles. |

## What is **not** in this spec

- Authentication credential cutover, application migration execution, or Better Auth table creation.
- Core API, core migrations, or core Lambda deployment.
- Public administration, scheduled execution, arbitrary SQL, or automatic password rotation.
- CI/CD, OIDC, replacement of the SPEC 02.1 account/IAM architecture, NAT, RDS Proxy, or a Paid plan upgrade.
