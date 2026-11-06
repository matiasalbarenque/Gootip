# SPEC 14 — Core Administrative Bootstrap

> **Status:** Implementation complete for dev; documented evidence limitations
> **Depends on:** SPEC 02.1, SPEC 02.2, SPEC 03, SPEC 05.1, SPEC 05.2, SPEC 07, SPEC 13
> **Date:** 2026-10-29
> **Objective:** Extend the existing administrative Lambda to provision and verify Core database identities, credentials, schema, and isolated grants in dev, delivering the prerequisite handoff for Core SPEC 06.

## Completion and downstream handoff (2026-10-30)

Dev implementation and the administrative handoff are complete within the
verification boundary recorded below. Partial acceptance criteria remain unchecked;
this status does not assert that every original criterion passed.
The user accepted the missing pre-bootstrap inventory and historical Auth row-data
evidence as limitations, not successful checks. Do not rerun bootstrap, recreate
historical evidence, or broaden permissions to close those gaps.

Core SPEC 06 subsequently completed private AWS migration execution, and Core
SPEC 07 completed the catalog snake_case migration. Empty-history statements below
are dated SPEC 14 evidence, not a claim about today's database. SPEC 09 and
SPEC 07.1 consumed this administrative contract for refresh and hardening.

Current effective RDS logging is documented below, but historical logging,
relevant exports, and credential-procedure compatibility remain unverified.
Any future credential-changing operation must verify its current secure procedure
against effective logging before proceeding. SPEC 07.1 separately accepts Admin
structural/simulation evidence after policy replacement; secret/TLS/log runtime
checks remain residual risk for the next necessary authorized Admin execution.
Neither item authorizes another bootstrap invocation merely for verification.

Auth and Core API activation and initial runtime security checks belong to
SPEC 10's Draft scope. SPEC 10.1 owns subsequent traffic, live rotation, controlled
failures and recovery validation after that deployment. Neither handoff is part
of this completion record. Historical references below to a future Core deployment
spec now refer to this explicitly separated SPEC 10/10.1 ownership.

## Why this spec exists

[Core SPEC 06](../../gootip-core/specs/06-private-typeorm-migrations.md)
requires an independently reviewed administrative handoff before deploying its
private migration executor. Local provisioning from SPEC 13 does not satisfy
that AWS requirement.

The existing `gootip-db-config` package fixes its application configuration to
`auth_runtime`, `auth_migrator`, and `auth`. Extend its existing
`lambda_db_config`; do not create another administrative function.

Local inspection on 2026-10-29 found `db_config_deployment_enabled = true` and
`core_migrations_deployment_enabled = false` in `environments/dev.tfvars`.
On 2026-10-30 the existing administrative Lambda completed the Core bootstrap
and a successful idempotent repeat. The dated operational evidence and remaining
read-only database checks are recorded in `gootip-db-config/README.md`. The Core
migration deployment gate remains disabled.

## Scope

**In:**

- Extend the fixed `bootstrap` operation with `core_runtime`, `core_migrator`,
  schema `core`, and two dedicated role-credential references.
- Bootstrap-owned empty Core credential containers, protected from destruction,
  with values loaded outside Terraform.
- Core schema ownership, role isolation, catalog grants, default privileges,
  and strictly isolated TypeORM history infrastructure.
- Extend `gootip_dev_operator` to Core catalog DML and history SELECT without
  granting DDL, migration execution, or application-role membership.
- Focused changes to existing secret policies and boundaries for exact Core
  ARNs, retaining the existing principals and private network topology.
- Local tests on SPEC 13's shared server and guarded database-config fixtures.
- Reviewed saved dev plans, administrative invocation, repeated reconciliation,
  and sanitized live prerequisite evidence.
- Keep `lambda_db_config` deployed after verification and revoke its temporary
  operator invocation permission.
- A documented handoff consumed by Core SPEC 06 steps 9 and 10.

**Out of scope:**

- Deploying or invoking the Core migration Lambda, applying business migrations
  in AWS, activating the Core API, or changing CI/CD.
- A new administrative Lambda, HTTP endpoint, trigger, NAT, or VPC endpoint.
- Auth schema, migration, credential, or effective-permission changes.
- Existing-table adoption, fake history, history repair, data deletion,
  destructive ownership transfers, or automatic rollback.
- Secret rotation infrastructure, new KMS keys, staging, or production.
- Changes to SPEC 13's local development history-read policy.

## Data model and integration contracts

No business data structures are introduced. This work adds administrative
identities, secret containers, and empty TypeORM bookkeeping where safe.

### Database identities

| Item     | Contract                                                                                    |
| -------- | ------------------------------------------------------------------------------------------- |
| Target   | Existing private dev RDS database `gootip`, verified live                                   |
| Schema   | `core`, owned by `core_migrator`                                                            |
| Migrator | `core_migrator`: LOGIN, Core DDL and ownership only                                         |
| Runtime  | `core_runtime`: schema USAGE, catalog SELECT/INSERT/UPDATE/DELETE, required sequence access |
| Operator | Existing `gootip_dev_operator`: Core catalog DML, required sequences, history SELECT only   |
| History  | `core.typeorm_migrations`, owned by `core_migrator`                                         |

Both Core roles must lack SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, and
BYPASSRLS. Neither may assume the other, Auth roles, the operator, or the
administrative login through direct or inherited membership. The operator
must not assume any application owner/runtime or administrative role.
The administrative login may retain the narrow owner-role membership needed
by the existing provisioning model; it must never be granted to Core logins.

Core identities cannot create schemas or objects in `public`, modify Auth
objects, or administer other identities. Runtime and operator cannot perform
Core DDL or own its objects. Preserve existing Auth access and restrictions.
Inspect unexpected direct and inherited grants before attempting reconciliation;
do not rewrite unrelated role memberships or shared privileges silently.

### Credentials and infrastructure ownership

| Item                       | Name / configuration                                           |
| -------------------------- | -------------------------------------------------------------- |
| Runtime container          | `${project}-${env}-core-runtime`                               |
| Migrator container         | `${project}-${env}-core-migrator`                              |
| Administrative environment | `CORE_RUNTIME_SECRET_ARN`, `CORE_MIGRATOR_SECRET_ARN`          |
| Terraform handoff          | `core_runtime_secret_arn`, existing `core_migrator_secret_arn` |
| Temporary creation control | `core_role_secret_creation_enabled`, default false             |

Each value is a JSON object containing a nonempty `username` and `password`.
Usernames must equal the respective fixed Core identity. Validate all required
credentials before opening the administrative transaction. Events cannot
override names, credentials, schemas, database targets, or SQL.

The bootstrap Terraform root owns the empty containers in `bootstrap/secrets.tf`,
with the existing 30-day recovery window, tags, AWS-managed encryption, and
`prevent_destroy` pattern. Reuse existing containers only after explicit
ownership/state review; do not duplicate, replace, or overwrite them.

Reuse the established two-phase container transition: temporary name/tag/Region
constrained creation, followed by a reviewed plan removing creation permission
and pinning complete ARNs before value operations. Extend both allows and
explicit denies consistently. Values are loaded through the approved manual
bootstrap identity using stdin, without printing or persisting them.
Existing valid Core values are preserved; missing or incompatible values stop
execution for explicit resolution. Do not reload Auth or operator values.

The administrative execution role adds reads of only the two exact Core
credential ARNs. Preserve its existing required credential reads. The deployment
role gains no secret-value access. The database operator retains access to only
its own secret, not Core role credentials. Core SPEC 06 owns the migration
execution role's exact migrator-secret read permission.

No new principal, trust relationship, or PassRole permission is introduced.
Retain the existing master-secret denial for human/deployment principals.
Account-specific ARNs remain non-sensitive configuration references under the
existing repository evidence policy; no credential enters Terraform or state.

### History isolation from the first migration

Broad default table grants would also expose a newly created history table.
Avoid relying on a later administrative invocation to close that window.

For an absent or genuinely empty Core schema, the administrative transaction
prepares an empty `core.typeorm_migrations` table owned by `core_migrator`.
Its structure must match the installed TypeORM 1.1.2 PostgreSQL contract:
generated integer primary key `id`, non-null bigint `timestamp`, and non-null
varchar `name`, with a migrator-owned generated-ID sequence.
Do not insert any history rows or create catalog tables.

This is administrative preparation of bookkeeping infrastructure, not adoption
or execution of a business migration. TypeORM remains the only writer of
applied migration records. Prove compatibility using its public executor and
Core's real migration registry against the prepared disposable fixture.

Reconcile existing catalog table DML and sequence access, then remove all
runtime privileges on the history table and its backing sequence. Grant the
operator only history SELECT, with no backing-sequence privilege. Default
privileges for future catalog tables/sequences belong to `core_migrator` and
grant the respective runtime/operator access. History restrictions must be
reasserted after every broad grant in the same transaction.

Fresh and repeated migrations must retain runtime denial of history SELECT
and writes, operator history-write denial, and successful catalog DML without
requiring another administrative bootstrap. Never drop/recreate history.
Future changes that recreate bookkeeping require a separately reviewed grant
strategy; ordinary additive catalog migrations use the established defaults.

### Existing-state safety

Before any mutation, inspect database identity, Core schema owner, role
attributes/memberships, existing objects, history structure/rows, default ACLs,
and exact secret-container metadata. Use the existing private operator tunnel
for permitted inspection; if its privileges cannot establish a required fact,
report the missing evidence rather than treating an empty result as absence.

- Absent schema or empty schema with expected ownership: eligible for initial
  administrative preparation.
- Compatible TypeORM history with compatible known Core objects: preserve
  rows, IDs, sequences, objects, and data; reconcile only reviewed grants.
- Application objects without compatible history, unknown history records,
  unexpected owners, privileged roles, or uncertain state: stop before mutation.

Compare history with the actual registered Core migrations and their expected
objects. Do not duplicate business migration execution in Python or claim that
history proves full schema equivalence. Initial empty history is reported as
`prepared_empty`, never as already migrated.

### Execution, locking, and lifecycle

Preserve the exact request `{ "operation": "bootstrap" }`, sanitized response
shape, timeout limits, per-invocation credential reads, and verified TLS.
Counts aggregate created roles/schemas across Auth and Core; history-table
preparation must not be misreported as an applied migration.

Reconcile both schemas in one transaction on the existing dedicated connection.
Retain the existing administrative Auth lock for compatibility and acquire the
Core administrative lock in a fixed order. Also acquire the exact Core SPEC 06
migration lock on that connection:
`hashtextextended(current_database() || ':core', 0)`.
The Python SHA-256 administrative lock alone does not coordinate with Core's
current TypeORM runner. Bound acquisition, release in reverse order, and
exercise contention and failure cleanup. Do not run Auth migrations during
administrative reconciliation; this spec does not change Auth's lock protocol.

After successful live verification, keep `db_config_deployment_enabled = true`.
Apply the reviewed revocation plan setting
`db_config_operator_invocation_enabled = false`; verify effective invocation
denial for that temporary operator path. Retain the private function, execution
role, security group, logging, and necessary private ingress.
No scheduled trigger, function URL, or standing replacement invocation path is
added. Future reconciliation requires a separately reviewed temporary grant.
Update the existing runbook's unconditional teardown instructions accordingly.

### Handoff evidence

Record the handoff in `gootip-db-config/README.md` and reference it from the
infra runbook. Include:

- Date, target database/schema, reviewed source revision and administrative ZIP
  digest, deployed code identity, invocation correlation, and repeat result.
- Exact non-sensitive Core secret ARNs in the approved environment handoff,
  with usernames verified but no values or raw secret responses.
- Schema ownership, role restrictions, membership isolation, TLS, negative
  Auth/public probes, and catalog/history privilege outcomes.
- Initial-state classification, applied migration names if any, and history
  digest compatible with Core SPEC 06's canonical ordered name/timestamp array.
- Evidence that temporary container-creation and invocation grants are revoked,
  and that Auth data/history and effective permissions remain preserved.

An empty live schema cannot prove DML against catalog tables that do not exist.
For that state, record local real-TypeORM fixture evidence of first-migration
grants and live checks of prepared history/default ACLs. Core SPEC 06 remains
responsible for actual live catalog DML and history isolation after its apply.
Do not manufacture catalog tables or migration rows to close that criterion.

The handoff is ready only after this spec's administrative live criteria pass.
Core SPEC 06 deployment and its end-to-end acceptance remain separate work.

### File boundaries

| Project / paths                                                                                                                          | Responsibility                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| DB config: `src/gootip_db_config/config.py`, `credentials.py`                                                                            | Fixed Core identities and exact credential references                          |
| DB config: `inventory.py`, `reconcile.py`                                                                                                | Safe initial-state inspection, schema/history preparation, grants              |
| DB config: `handler.py`, `locking.py`                                                                                                    | Atomic multi-schema orchestration and Core lock compatibility                  |
| DB config: `tests/test_config.py`, `test_credentials.py`, `test_inventory.py`, `test_reconcile.py`, `test_handler.py`, `test_locking.py` | Focused failure, compatibility, and sanitization tests                         |
| DB config: `tests/integration/conftest.py`, `test_effective_privileges.py`, `test_orchestration.py`                                      | Guarded namespaced fixtures, isolation, concurrency, repeatability             |
| Core: `test/migration-integration.spec.ts`                                                                                               | Public TypeORM executor compatibility with prepared history and grant fixtures |
| Infra bootstrap: `secrets.tf`, `iam.tf`, `variables.tf`, `outputs.tf`, existing policy tests                                             | Protected containers, phased capabilities, complete ARN handoff                |
| Infra: `lambda.tf`, `iam.tf`, `variables.tf`, `outputs.tf`, `environments/dev.tfvars`, focused `tests/` and `scripts/tests/` fixtures    | Administrative credential wiring and scoped execution policy                   |
| DB config `README.md`; infra `README.md`                                                                                                 | Safe deployment, retained-function lifecycle, dated evidence and Core handoff  |

Keep integration tests serial on the shared PostgreSQL 18 Alpine server.
Use `gootip_test_db_config` and `test_db_config_` roles for Python fixtures;
Core compatibility tests use `gootip_test_core` and `test_core_` roles.
Adapt test identities only at the test boundary. Preserve strict deployed
identity validation. Never mutate development `gootip` as a fixture or stop
the shared container. Restore the Core test grant baseline during cleanup.

## Implementation plan

1. Record read-only live prerequisite inventory and verify existing deployment
   authority. Classify Core state before planning any administrative changes.
   Stop on incompatible or unobservable state; do not infer AWS state from
   local files. Inventory may use existing approved access, never a new grant
   applied merely to bypass this review.
2. Extend configuration and credential validation with fixed Core identities
   and exact ARNs. Add database-free tests for missing/mismatched values and
   ensure failures occur before SQL mutation.
3. Add guarded Core inventory and empty history preparation with focused tests.
   Preserve existing objects and reject incompatible state before reconciliation.
4. Add Core grants, default privileges, history exclusions, and operator access.
   Exercise real sessions against disposable fixtures for positive catalog DML
   and negative history, DDL, membership, Auth, and public access.
5. Extend atomic orchestration and locking. Prove rollback across both schemas,
   unchanged Auth behavior, bounded contention with Core's migration lock,
   and idempotent reconciliation without rewriting history or application data.
6. Add Core integration coverage using the real TypeORM executor against the
   administratively prepared fixture. Verify fresh/repeated apply, preserved
   history isolation, future-object grants, and restored fixture permissions.
   Do not edit already published business migration sources.
7. Extend bootstrap container ownership and phased exact-ARN policies, then
   administrative Lambda wiring and execution boundaries. Add focused policy
   guardrails. Preserve the Core migration deployment flag as false.
8. Update runbooks, run package format/lint and focused unit/integration checks,
   and the complete relevant offline verification once before deployment.
   Package the administrative Lambda once after its final source changes.
9. Review and apply saved bootstrap plans for the Core container creation phase
   and subsequent exact-ARN phase. Verify temporary creation revocation and
   negative secret authorization checks before loading only missing approved
   Core values out of band. Preserve existing credentials and containers.
10. Review the saved application plan for the existing administrative Lambda's
    in-place code/configuration and narrow policy updates. Obtain explicit
    review for expanded exact-secret IAM scope under the repository stop
    conditions. Apply only the reviewed saved plan by filename.
11. Through the established temporary invocation grant, invoke the reviewed
    administrative artifact, verify sanitized success, and repeat. Verify
    ownership, history compatibility, effective grants, login credentials,
    isolation, and preservation of Auth and existing Core data. A lost response
    requires read-only reconciliation before any retry.
12. Revoke temporary invocation through its reviewed saved bootstrap plan while
    retaining the deployed function. Record the sanitized, dated handoff and
    exact configured migrator ARN for Core SPEC 06, leaving its deployment and
    business migration execution to that spec.

## Acceptance criteria

- [ ] **Partial —** Read-only inventory ran inside the guarded bootstrap before
      mutation and accepted the initial state. The sanitized response did not
      preserve the initial objects/history/roles/grants inventory. A live
      post-bootstrap snapshot now confirms the prepared catalog and empty Core
      history, but cannot reconstruct the exact pre-bootstrap inventory.
- [x] **Accredited —** Only the existing private `lambda_db_config` performed
      administrative work; fixed-event validation tests passed, and the function
      completed both authorized invocations.
- [ ] **Partial —** Bootstrap-owned containers, exact ARN handoffs, and
      out-of-band value loading are evidenced. Values were not exposed in
      Terraform, command arguments, output, or persistent files. The live RDS
      statement-logging settings were not independently checked for this run:
      the existing `GootipBootstrapAdmin` session was valid, but AWS denied
      `rds:DescribeDBInstances`; no parameter values were retrieved and no IAM
      policy was changed. Credential-procedure compatibility therefore remains
      unverified against effective logging settings.
- [ ] **Partial —** Auth secret references and their current versions were
      unchanged, and the Auth SQL history metadata, schema/relation owners, and
      default ACLs match the 2026-10-26 baseline. No historical Auth row-count or
      data digest exists and the baseline grants are not per-object, so
      retrospective data/credential/per-object grant preservation is not fully
      provable. RDS metadata confirms `gootip_auth` is the configured master
      login; its membership in `core_migrator` is the intended administrative
      owner-role grant, not an Auth runtime identity.
- [x] **Accredited —** The fixed Core usernames were validated before SQL by the
      successful run; database-free missing/mismatched credential tests passed.
- [x] **Accredited —** The live post-check confirms Core objects are owned only
      by `core_migrator`; `core_runtime` and `core_migrator` have no membership
      in each other or Auth roles, no access to Auth objects, and no `CREATE` on
      `public`. Runtime and operator lack Core `CREATE`. RDS metadata identifies
      `gootip_auth` as the master login; its direct membership in `core_migrator`
      is the allowed administrative owner-role grant created for `current_user`,
      not a Core-to-Auth or application-runtime path.
- [x] **Accredited —** The bootstrap classified absent Core schema/history and
      prepared empty administrative history without migration rows. Live catalog
      checks confirm only the empty TypeORM history table, its sequence, and
      primary-key index; no business relations exist. The isolated Core test ran
      the installed TypeORM 1.1.2 preflight successfully against that empty
      history shape.
- [x] **Accredited —** Live effective privileges confirm runtime cannot SELECT,
      write, or use the history sequence; the operator can SELECT but cannot
      modify history or use its sequence.
- [x] **Accredited —** Isolated PostgreSQL 18 tests applied the registered Core
      migrations through TypeORM 1.1.2, applied them again as a no-op, and proved
      runtime/operator DML on migrator-created objects and future grants. This is
      SPEC 14 fixture evidence only; it is not the SPEC 06 AWS migration.
- [x] **Accredited —** Isolated Core preflight rejected both untracked objects
      without history and incompatible migration-history contents; no adoption,
      fake execution, or repair was accepted.
- [x] **Accredited —** Isolated tests exercised concurrent serialized bootstrap,
      advisory-lock timeout and lock release, TypeORM/admin lock contention, and
      transactional rollback after an injected migration failure.
- [x] **Accredited —** The 86 previously passing unit tests were reused; this run
      passed all 25 DB-config integration tests and the TypeORM integration test.
      Test-only databases/roles were removed and verified absent. The shared
      development database was not used or changed.
- [x] **Accredited —** `verify_full.sh` passed after correcting only the
      `core_migrator_secret_arn` whitespace alignment in `environments/dev.tfvars`.
      Both Terraform roots validated; 135 pure infra tests and the materialized-
      plan cleanup test passed; offline guardrails reported zero failures.
- [x] **Accredited —** The reviewed boundary, application, temporary-invocation,
      and revocation plans were applied by filename; each contained only the
      expected in-place updates and no creates, replacements, or deletes.
- [ ] **Partial —** Live bootstrap and repeat succeeded. The Lambda validated
      credentials and prepared Core under its TLS-enforcing configuration.
      Read-only TLS-verified SQL now confirms Core ownership, empty history,
      effective history permissions, and Auth history/ownership/default-ACL
      continuity with 2026-10-26. RDS metadata confirms the bootstrap login
      identity, and the observed admin-to-owner membership is expected. Auth
      row-data preservation remains unprovable retrospectively; the isolated
      tests do not substitute for before/after evidence on RDS.
- [x] **Accredited —** Temporary invocation is absent from the current bootstrap
      policy; exact Core secret ARNs remain. `lambda_db_config` remains Active
      and private.
- [x] **Accredited —** Dated evidence records the exact Core migrator ARN, code
      identity, invocation IDs/results, empty-state preparation, live effective
      permissions, and Auth comparison. It also records the isolated test results
      and, when recorded, left SPEC 06 AWS deployment/invocation/migration checks
      outstanding. Later SPEC 06 evidence records their completion.

### Verification boundary (2026-10-30)

The operator supplied an already open, TLS-verified tunnel for the read-only
post-check; the instance/tunnel lifecycle was not touched. AWS RDS metadata
confirms `MasterUsername=gootip_auth`, matching Terraform's `rds_db_user`. The
direct `gootip_auth -> core_migrator` membership is the expected owner-role grant
to the administrative `current_user`, permitted by SPEC 14; it is not an
application runtime identity. Auth history metadata, ownership, and default ACLs
were compared with the 2026-10-26 baseline. There is no historical row-data
digest or per-object privilege snapshot, so those cannot be claimed
retrospectively. Later isolated PostgreSQL 18 tests passed DB-config integration
(25/25) and the actual TypeORM 1.1.2 migration-integration suite (1/1); all
test-only databases/roles were removed. This covers SPEC 14's code/fixture gates
for preflight, grants, bad history, concurrency, rollback and cleanup. SPEC 06
owns the AWS runner deployment, live invocation/migration, and post-migration
catalog and effective-permission proof. Core API deployment and its application
smoke test are outside SPEC 06 and remain deferred to the API deployment scope.
See `gootip-db-config/README.md` for application identity scope, AWS Lambda read
limitations, and evidence paths.

The requested RDS logging read was attempted with the existing valid
`GootipBootstrapAdmin` MFA/assumed-role session. `rds:DescribeDBInstances` was
denied for `gootip-dev`; the existing role therefore cannot establish the
effective parameter group or CloudWatch log exports through that API. No live DB
tunnel was listening, no parameters were changed, and IAM was not expanded. Since
the credential procedure can submit `ALTER ROLE ... PASSWORD` as SQL text, its
compatibility with the effective statement-logging configuration remains
unverified; do not assume those settings suppress sensitive SQL from logs.

### Follow-up read-only tunnel check (2026-10-29)

The documented local PostgreSQL forward `127.0.0.1:15432` was checked with
`lsof` and a TCP connect probe; no listener was present. No tunnel was started,
no database credential was read, and no SQL or log data was queried. Therefore
the effective statement, duration, and error logging settings remain unknown.
This check describes only current local connectivity and provides no evidence
about the settings that were active during the earlier Core bootstrap. A new
read-only check requires an already available tunnel to the dev RDS endpoint on
`127.0.0.1:15432` and a usable database session; no IAM change is authorized or
implied by this record.

### Effective PostgreSQL logging settings (2026-10-30 02:15 UTC)

The existing SSH forward was available on `127.0.0.1:15432`. A read-only
`pg_settings` query connected to database `gootip` as
`gootip_dev_operator`, using `sslmode=verify-full` and the verified regional RDS
CA. The server reported `2026-10-30 02:15:19 UTC`. Only parameter metadata was
queried; no PostgreSQL or CloudWatch logs were read. The operator secret was
supplied to the client process without printing or persisting its value. No
database or RDS settings were changed.

| Parameter | Effective value | Source | Pending restart |
| --- | --- | --- | --- |
| `log_statement` | `none` | `default` | No |
| `log_duration` | `off` | `default` | No |
| `log_min_duration_statement` | `-1 ms` | `default` | No |
| `log_min_duration_sample` | `-1 ms` | `default` | No |
| `log_statement_sample_rate` | `1` | `default` | No |
| `log_min_error_statement` | `error` | `default` | No |
| `log_min_messages` | `warning` | `default` | No |
| `log_parameter_max_length` | `-1 bytes` | `default` | No |
| `log_parameter_max_length_on_error` | `0 bytes` | `default` | No |

At this observation time, successful statements are not selected by
`log_statement`, and duration logging is disabled. Statements causing `ERROR`
or higher can still be logged by `log_min_error_statement`; therefore a failed
credential-changing SQL statement could expose literal SQL text. The zero
`log_parameter_max_length_on_error` setting disables bind-parameter logging on
errors, but does not establish that a literal embedded in SQL text is safe.
This check does not read logs or prove whether any credential-bearing statement
was logged. These are current effective database settings only; they do not
establish which settings were active during the earlier bootstrap.

The user accepts the unpreserved pre-bootstrap inventory and lack of historical
Auth row counts/data digest as explicit limitations of this handoff. This records
acceptance of the evidence boundary only: neither limitation is demonstrated,
reconstructed, or marked as a satisfied acceptance criterion. No further attempt
will be made to recreate that historical evidence. The current settings are
recorded above; relevant RDS log exports and credential-procedure compatibility
remain unverified. Do not rerun the bootstrap or change permissions for this
follow-up.

## Decisions

- **Yes: extend the existing administrative function.** Its reviewed boundary
  already owns role/schema provisioning; the migration Lambda stays unprivileged.
- **Yes: live dev verification belongs here.** Code-only completion does not
  supply the prerequisite that blocked Core SPEC 06.
- **Yes: extend the human operator to Core.** The user confirmed catalog DML
  and history SELECT, retaining the existing separation from administrative roles.
- **Yes: retain the function and revoke temporary invocation.** The user chose
  this lifecycle while Core migration work continues; update the old teardown advice.
- **Yes: prepare empty standard history before exposing catalog defaults.**
  This avoids temporarily granting runtime access to history and requires no
  rewrite of business migrations or event-trigger framework.
- **No: insert or repair migration history.** Existing incompatible state needs
  separately reviewed adoption work.
- **No: grant Core credentials to the database operator.** Its existing identity
  is sufficient for interactive data work.
- **No: treat local fixtures as live AWS proof.** Record local grant-mechanism
  evidence separately from live administrative and later migration evidence.
- **No: deploy Core migrations here.** Core SPEC 06 consumes this handoff and
  retains responsibility for its own saved plan, apply, and end-to-end checks.

## Risks

| Risk                                                            | Mitigation                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Broad grants reopen history access                              | Prepare history first and restrict table/sequence privileges within the same transaction; test first and repeated apply |
| Manually created Core objects are mistaken for a fresh schema   | Inspect before mutation and reject incompatible ownership/history                                                       |
| Python administrative locks do not contend with TypeORM         | Acquire Core's exact SQL lock in addition to stable administrative locks                                                |
| Extending one bootstrap changes Auth behavior                   | Atomic rollback tests and before/after live checks of Auth history, data, and effective permissions                     |
| TypeORM bookkeeping changes after a dependency upgrade          | Test the real installed public executor against prepared history before adopting the upgrade                            |
| Secret value and database password diverge                      | Validate identities before mutation, preserve known values, reconcile atomically, and verify real login afterward       |
| A retained administrative function keeps sensitive capabilities | No triggers/public access; revoke temporary invocation and require reviewed reauthorization                             |

## What is **not** in this spec

No Core business migration deployment, API activation, pipeline implementation,
Auth refactor, new administrative function, secret rotation service, existing-data
adoption, destructive repair, public networking, staging, or production work.
