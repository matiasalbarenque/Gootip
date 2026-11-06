# gootip-db-config

Administrative AWS Lambda that bootstraps the Gootip PostgreSQL administrative
contract: Auth and Core runtime/migrator identities, `gootip_dev_operator`, both
schemas, ownership, grants, and default privileges. It executes no application
migration.

The function has no HTTP API, Function URL, or scheduled trigger. It runs only
through the separately authorized operator procedure, and the fixed `bootstrap`
operation cannot receive SQL, database targets, role names, schemas, passwords,
or secret ARNs from the event. SPEC 03 defines this boundary; SPEC 07 owns the
operator invocation permission and the revoke/re-enable controls.

## Contract

- Fixed operation: `bootstrap`.
- Roles: `auth_runtime` (schema usage, table DML, sequence access; no DDL or
  modification privileges on migration history),
  `auth_migrator` (`auth` ownership and DDL), and `gootip_dev_operator`
  (declared-schema DML; no DDL or role administration). All are non-superusers.
- Schema: `auth`, owned by `auth_migrator`.
- Idempotent and atomic: existing roles, schema, and data are preserved; every
  grant and default privilege is reasserted on each run.
- After broad runtime DML grants, reconciliation revokes write privileges from
  `auth.gootip_schema_migrations` when that table exists. Ordinary application
  table DML and default privileges remain granted.
- Serialized: a session-scoped advisory lock (keyed by database and schema)
  prevents two invocations from reconciling at once.

## Requirements

- `uv` (provides Python 3.13).
- Docker for the shared local PostgreSQL service from Infra SPEC 13.
- AWS credentials only for packaging and deployment; Terraform owns the function.

## Local verification

```bash
uv run pytest -m "not integration"  # unit checks, no PostgreSQL required
uv run ruff check . && uv run ruff format --check .
# From the monorepo root, after configuring gootip-infra/local/postgres.env:
./gootip-infra/scripts/local_postgres.sh bootstrap
./gootip-infra/scripts/local_postgres.sh migrate
./gootip-infra/scripts/local_postgres.sh integration
```

The shared command runs Auth, Core, and database-configuration integration
suites serially against one `postgres:18-alpine` server. This package uses
`gootip_test_db_config`, its explicitly allowlisted auxiliary databases, and
`test_db_config_` roles. Cleanup removes only those test resources; the shared
container, persistent volume, and development database remain intact.

Use the shared command to provide the required local admin configuration and
fresh test credentials. Missing configuration, an unexpected destination, or
an unavailable shared server fails an explicit integration run instead of
skipping it. Unit-only checks require no Docker server. No per-suite image
selection or temporary PostgreSQL container is used.

SPEC 08 regression coverage proves that a runtime history-table write grant
created by broad reconciliation is revoked while DML on ordinary existing and
future tables remains usable. Dev reconciliation and the private SPEC 04
`validate` both succeeded on 2026-10-21; the live runner reported the initial
history row intact and migration `000002` pending before its authorized apply.

## Packaging

```bash
./scripts/package_lambda.sh   # writes lambda.zip
```

The archive is built for the Lambda platform (Python 3.13, `aarch64`, manylinux
2.28 = Amazon Linux 2023) so the native `psycopg` wheel matches the runtime. The
handler is `gootip_db_config.handler.lambda_handler`.

## Runtime configuration

Terraform sets every variable. The event cannot influence any of them.

| Variable | Required | Meaning |
| --- | --- | --- |
| `POSTGRES_DB_HOST` / `POSTGRES_DB_PORT` / `POSTGRES_DB_NAME` | yes | Private RDS endpoint and database. |
| `POSTGRES_SSL_MODE` | yes | Must be `verify-full`. Any other value fails configuration. |
| `POSTGRES_CA_PATH` | no | Shared CA bundle, default `/opt/certs/rds-ca-bundle.pem`. |
| `DB_MASTER_SECRET_ARN` | yes | RDS-managed master secret, read at run time. |
| `AUTH_RUNTIME_SECRET_ARN` / `AUTH_MIGRATOR_SECRET_ARN` / `CORE_RUNTIME_SECRET_ARN` / `CORE_MIGRATOR_SECRET_ARN` / `DB_OPERATOR_SECRET_ARN` | yes | Exact role-credential containers. |
| `DB_CONNECT_TIMEOUT` | no | Connection timeout seconds (default 10). |
| `DB_STATEMENT_TIMEOUT_MS` | no | Per-statement timeout (default 30000). |
| `DB_LOCK_ACQUIRE_TIMEOUT_MS` | no | Advisory-lock wait before `lock_timeout` (default 5000). |

Each run reads the current secret versions, so a warm environment never reuses a
master password cached before RDS-managed rotation. Role secrets are validated
against their expected `username` before any SQL mutation.

## Invocation contract

Request:

```json
{ "operation": "bootstrap" }
```

Success response (non-sensitive only; creation counts aggregate both schemas):

```json
{
  "status": "succeeded",
  "correlation_id": "<lambda request id>",
  "operation": "bootstrap",
  "counts": { "roles_created": 5, "schema_created": 2 }
}
```

The first run against a fresh database reports up to five application roles and
two schemas. Core bookkeeping preparation is not counted as a migration; an
empty TypeORM history is reported as `prepared_empty`, never as migrated.
Failures carry only a
bounded code and never a raw error, credential, connection string, or value:

| `error_code` | Cause |
| --- | --- |
| `invalid_event` | The event is not the fixed `bootstrap` request. |
| `invalid_configuration` | A required variable is missing or unsafe. |
| `invalid_secret` | A secret is malformed or names the wrong role. |
| `database_error` | A connection or safety check failed (including restricted role attributes). |
| `lock_timeout` | Another invocation holds the advisory lock past the deadline. |
| `internal_error` | Any other bounded failure. |

## Operator procedures

All AWS steps use short-lived MFA sessions. Mint a source session and assume the
bootstrap role through the SPEC 02.1 procedure:

```bash
aws configure mfa-login --profile gootip-dev \
  --duration-seconds 3600 --update-profile gootip-mfa
# assume /gootip/bootstrap/GootipBootstrapAdmin into profile gootip-bootstrap-admin
```

The bootstrap root (`gootip-infra/bootstrap/`) runs as `gootip-bootstrap-admin`;
the application root runs as `gootip-terraform-deploy`.

### 1. Two-phase secret-container transition

Complete ARNs do not exist before the containers are created, so the transition
uses two reviewed bootstrap applies.

1. First apply — set `role_secret_creation_enabled = true` (requires
   `account_resource_phase_enabled`). This grants temporary, name-and-tag
   constrained `secretsmanager:CreateSecret` for exactly
   `gootip-dev-auth-runtime` and `gootip-dev-auth-migrator`, and creates the two
   empty containers. It does not permit loading or reading values.
2. Record the two generated container ARNs.
3. Second apply — set `role_secret_creation_enabled = false` and supply the exact
   ARNs in `auth_runtime_secret_arn` and `auth_migrator_secret_arn`. This removes
   the temporary `CreateSecret`, expands the manual-value `NotResource`
exception to exactly the three approved containers for that role-secret phase,
and retains container refresh/tag permissions plus `DescribeSecret`, `GetSecretValue`, and
   `PutSecretValue` on only those three. The exact RDS master-secret denial is
   unchanged.

Load values only after the second apply and its negative authorization checks
pass.

### 2. Loading non-production role credentials

Terraform never creates secret values. As `gootip-bootstrap-admin`, load each
username/password pair out of band:

```bash
aws secretsmanager put-secret-value \
  --profile gootip-bootstrap-admin --region us-east-2 \
  --secret-id gootip-dev-auth-runtime \
  --secret-string '{"username":"auth_runtime","password":"<non-production-value>"}'

aws secretsmanager put-secret-value \
  --profile gootip-bootstrap-admin --region us-east-2 \
  --secret-id gootip-dev-auth-migrator \
  --secret-string '{"username":"auth_migrator","password":"<non-production-value>"}'
```

The loader rejects a value whose `username` does not match the configured role
(`invalid_secret`) before any SQL runs. Never place a value in Terraform, a
tracked file, or Git.

### 2a. Loading Core role credentials (SPEC 14)

Load only the approved Core role values, and only after the reviewed bootstrap
plan has pinned both exact secret ARNs and removed the temporary creation grant.
Confirm the active identity first:

```bash
aws sts get-caller-identity --profile gootip-bootstrap-admin
```

For each container, inspect version metadata only immediately before its write.
If an `AWSCURRENT` version is already present, preserve it and stop; do not read
or replace it. When no current version exists, generate a strong random
credential in memory. This script checks the active identity, stops on any
existing current version, sends values through the SDK request body, and prints
only ARN/version metadata. Run it from `gootip-db-config` with its pinned
dependencies available:

```bash
uv run python - <<'PY'
import json
import secrets
import sys

import os
import boto3

session = boto3.Session(profile_name="gootip-bootstrap-admin", region_name="us-east-2")
identity = session.client("sts").get_caller_identity()
if identity.get("Account") != os.environ["TF_VAR_aws_account_id"] or ":assumed-role/GootipBootstrapAdmin/" not in identity.get("Arn", ""):
    raise SystemExit("Unexpected AWS identity; no values were written.")

secrets_manager = session.client("secretsmanager")
credentials = (
    ("core_runtime", "core_runtime", os.environ["TF_VAR_core_runtime_secret_arn"]),
    ("core_migrator", "core_migrator", os.environ["TF_VAR_core_migrator_secret_arn"]),
)
for label, username, arn in credentials:
    try:
        metadata = secrets_manager.describe_secret(SecretId=arn)
    except Exception:
        raise SystemExit(f"Could not inspect {label} metadata; no value written.") from None
    stages_by_version = metadata.get("VersionIdsToStages") or {}
    if metadata.get("ARN") != arn or any(
        "AWSCURRENT" in version_stages
        for version_stages in stages_by_version.values()
    ):
        raise SystemExit(f"STOP: {label} has an existing or unexpected current version.")

    password = secrets.token_urlsafe(48)
    secret_string = json.dumps({"username": username, "password": password}, separators=(",", ":"))
    try:
        result = secrets_manager.put_secret_value(SecretId=arn, SecretString=secret_string)
    except Exception:
        raise SystemExit(f"Write failed for {label}; no value or exception details printed.") from None
    del password, secret_string

    current = secrets_manager.describe_secret(SecretId=arn).get("VersionIdsToStages") or {}
    if not any(
        version_id == result.get("VersionId") and "AWSCURRENT" in stages
        for version_id, stages in current.items()
    ):
        raise SystemExit(f"{label} write returned, but AWSCURRENT verification failed.")
    print(json.dumps({"identity": label, "ARN": result["ARN"], "VersionId": result["VersionId"], "AWSCURRENT": True}))
PY
```

The AWS response contains metadata only. Never run `get-secret-value` for these
containers during this procedure. A later administrative invocation validates
both fixed usernames before opening the database transaction; a mismatch or
unknown existing database state requires a stop, not an overwrite.

### 3. Dev database operator profile and credential replacement (SPEC 05.1)

The operator role is AWS access to only the exact operator credential container;
it does **not** create a route from a workstation to the private database. Add
this non-secret profile configuration to `~/.aws/config`:

```ini
[profile gootip-db-operator]
role_arn = arn:aws:iam::<ACCOUNT_ID>:role/gootip/operations/GootipDatabaseOperator
source_profile = gootip-mfa
role_session_name = gootip-db-operator
duration_seconds = 3600
region = us-east-2
```

After refreshing `gootip-mfa`, verify the assumed identity before any secret
read:

```bash
aws sts get-caller-identity --profile gootip-db-operator
```

Only `gootip-bootstrap-admin` may load or replace the value. Generate it in
memory and pass it through stdin so it is neither printed nor written to a file:

```bash
python3 -c 'import json, secrets; print(json.dumps({"username": "gootip_dev_operator", "password": secrets.token_urlsafe(32)}))' |
  aws secretsmanager put-secret-value \
    --profile gootip-bootstrap-admin --region us-east-2 \
    --secret-id gootip-dev-db-operator \
    --secret-string file:///dev/stdin \
    --query '[ARN,VersionId]' --output text
```

After replacing the value, use the reviewed temporary `lambda_db_config`
procedure below to reconcile the PostgreSQL password, then remove that function
and its invocation permission again. The operator role may read the value but
cannot write it, invoke Lambda, mutate IAM, or access the master/runtime/migrator
containers.

**SPEC 05.2 handoff:** stop here for database connectivity. DBeaver setup,
workstation-to-VPC networking, tunnels, public access, VPN, and any other live
database route are explicitly owned by SPEC 05.2 and are not authorized by this
procedure.

### 4. Invoking the bootstrap

Prerequisites:

- The application root has applied the function with `db_config_deployment_enabled = true`
  and the master, runtime, migrator, and operator-secret ARNs. Deploying the
  function requires the deployment-role Lambda and exact-PassRole expansion owned
  by SPEC 07; SPEC 03 itself grants no deployment or invocation permission.
- For the SPEC 03 development bootstrap only, set
  `db_config_operator_invocation_enabled = true` in the ignored,
  mode-600 `bootstrap/current-bootstrap.local.tfvars`. This is a temporary,
  revocable SPEC 07 authorization brought forward solely to unblock the SPEC 03
  live checks: it grants only `GootipBootstrapAdmin` `lambda:InvokeFunction` on
  the exact unqualified `lambda_db_config` ARN. It grants no application or
  deployment role access and creates no Lambda resource policy. SPEC 07 remains
  responsible for consolidating or revoking this authorization afterward.

```bash
aws lambda invoke \
  --profile <operator-profile> --region us-east-2 \
  --function-name lambda_db_config \
  --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"bootstrap"}' \
  response.json
cat response.json
```

Inspect the sanitized response. Creation counts aggregate Auth and Core; a
repeated run reports zero creations and preserves all data.

### 5. Revocation

- Turn the temporary Auth/Core container-creation grants off after their
  reviewed container-creation plans; supply both exact Core ARNs before enabling
  value operations.
- Set `db_config_operator_invocation_enabled = false` and apply the bootstrap
  root to withdraw the temporary operator invocation authorization after the
  successful live verification. Keep `db_config_deployment_enabled = true` and
  retain the private function, execution role, security group, logging, and
  required private ingress. No standing invocation path is added; re-enable only
  under a separately reviewed temporary grant.

### 6. Recovery and re-enable

- Keep the administrative function deployed after verified handoff. Any later
  re-invocation requires a reviewed temporary authorization plan.
  The master, runtime, migrator, operator-secret ARNs, and runtime boundary must
  be present. After a successful invocation, use the reviewed revocation plan
  immediately; leave the function deployed but do not leave invocation access
  enabled.
- Lost or rotated operator password: replace the exact operator value (step 3),
  then re-enable and invoke the administrative function. The bootstrap reasserts
  `ALTER ROLE ... PASSWORD` for all five application roles.
- `invalid_secret`: the operator container is missing, malformed, or names a
  username other than `gootip_dev_operator`. Correct the out-of-band value before
  re-enabling the function; do not bypass the username check.
- RDS-managed master rotation: no action is needed. Every run reads the current
  master secret version.
- `lock_timeout`: another invocation holds the advisory lock. Retry after it
  completes; a crashed invocation cannot leave the database permanently locked,
  because dropping the connection releases the session lock.
- `database_error` naming restricted attributes: a role holds `SUPERUSER`,
  `CREATEDB`, `CREATEROLE`, `REPLICATION`, or `BYPASSRLS`. A non-superuser
  administrator cannot negate these, so the run fails instead of tolerating
  drift; correct the attribute as a superuser and re-invoke.

## SPEC 14 dev handoff record (2026-10-30)

The existing private `lambda_db_config` completed the SPEC 14 `bootstrap`
operation twice on 2026-10-30. The first sanitized response was `succeeded`,
correlation ID `3af2833c-1286-47db-b93c-6c074d55a00e`, with aggregate counts of
two roles and one schema created. The repeat was `succeeded`, correlation ID
`b64d5db2-d575-4dfc-b5c8-ccc6be552ebf`, with zero roles and schemas created.
Counts aggregate Auth and Core; they do not independently identify each object.
Both Core credential usernames passed the function's fixed-identity validation.

The two previously empty Core containers had no `AWSCURRENT` version before
their individual writes. Random passwords were generated in memory and sent to
Secrets Manager through stdin; no values were placed in Terraform, arguments,
output, or persistent files. Both versions were confirmed current afterward.
The existing Auth runtime and migrator references remained configured, and their
previous `AWSCURRENT` versions were still current after both invocations. No
secret values were read.

The deployed function remains Active with the reviewed code identity:

| Artifact | Identity |
| --- | --- |
| `gootip-db-config/lambda.zip` SHA-256 | `9fa5e807b6b8bd4da0839e03a085a80716c71ad9ea5e304cf73ffbca7a5d5fca` |
| Lambda `CodeSha256` | `n6XoB7a4vU2gg54DoIWoBxbHGtnqXjBM9z/7ynpdX8o=` |

Exact credential-container references in the deployed handoff:

| Identity | Secret ARN |
| --- | --- |
| `core_runtime` | `arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-runtime-Ab1Cd2` |
| `core_migrator` | `arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-migrator-Ab1Cd2` |
| `auth_runtime` | `arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-auth-runtime-Ab1Cd2` |
| `auth_migrator` | `arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-auth-migrator-Ab1Cd2` |

The administrative Lambda's `GetSecretValue` policy and its runtime boundary
were verified to include the exact Core ARNs, with no Core secret wildcard. The
function has no `PutSecretValue` permission. This AWS IAM scope is verified; it
is distinct from the RDS master's PostgreSQL owner-role membership documented
below.

The temporary invocation statement was removed after the repeat. The current
bootstrap policy has no `InvokeExactDbConfigBootstrap` statement; the two exact
Core ARNs remain in its approved secret scope. The administrative function stays
deployed. `core_migrations_deployment_enabled` remains `false`; no Core business
migration runner or migration was deployed or invoked.

### Read-only verification status and Auth comparison

The successful bootstrap performed its guarded inventory and transaction, but
its sanitized response does not include object-level grants, role memberships,
history rows, or an Auth digest. On 2026-10-30 the operator supplied an already
open listener at `127.0.0.1:15432`; it was used without starting, stopping, or
closing the tunnel or changing AWS state. The SQL session was
`gootip_dev_operator`, PostgreSQL 18.6, TLS 1.3 with `verify-full`; every query
ran inside `BEGIN READ ONLY` and ended with `ROLLBACK`. Only catalogs, role
privileges, schema/object ownership, and migration-history metadata were read.

Local raw query results (ignored by the repository's `/audit/` rule as
account-specific evidence) are in:

- `gootip-infra/audit/pg18-spec14-readonly-verification-20261030.txt`
- `gootip-infra/audit/pg18-spec14-auth-grants-20261030.txt`
- `gootip-infra/audit/rds-master-runtime-identity-2026-10-30.txt`
- `gootip-infra/audit/spec14-isolated-tests-20261030.txt`

The summaries and limitations below are the durable handoff record.

The available pre-SPEC-14 Auth baseline is the 2026-10-26 PostgreSQL 18.6
snapshot in `gootip-infra/audit/pg18-postchecks-roles-migrations-20261026.txt`,
`pg18-postchecks-grants-20261026.txt`, and
`pg18-postchecks-effective-grants-20261026.txt`. It records TLS 1.3 as
`gootip_dev_operator`, `auth` owned by `auth_migrator`, seven Auth relations
owned by `auth_migrator`, and Auth history entries `000001` and `000002` with
their recorded checksums. It also records the then-current Auth role attributes,
memberships, default ACLs, and table DML checks. Those files are historical
evidence, not a post-bootstrap snapshot.

### Live SQL findings

- `core` is owned by `core_migrator`; its only table is
  `typeorm_migrations`, also owned by `core_migrator`, plus its owned sequence
  and primary-key index. The TypeORM history table has zero rows (empty-set
  digest `d41d8cd98f00b204e9800998ecf8427e`). No Core business tables or other
  relations were present. The digest is an MD5 of the empty ordered history
  serialization, not a security checksum.
- `core_runtime` has `USAGE` but not `CREATE` on `core`; it has no SELECT, DML,
  or sequence privileges on the Core history objects. `core_migrator` owns the
  schema/history and has the corresponding history-table and sequence
  privileges. `gootip_dev_operator` has `USAGE`, not `CREATE`, on `core`; it can
  SELECT the history table but cannot INSERT/UPDATE/DELETE or use its sequence.
- RDS metadata confirms `MasterUsername=gootip_auth`; its managed master-secret
  ARN matches `db_master_secret_arn` in `environments/dev.tfvars`. Therefore the
  observed direct membership `gootip_auth -> core_migrator` (`admin_option=false`)
  is the intended administrative owner-role membership: `reconcile.py` grants
  the configured Core migrator role to PostgreSQL `current_user`, and SPEC 14
  explicitly permits the administrative login to retain this narrow membership.
  It is not an Auth runtime identity or an unexpected cross-domain grant. The
  effective Core privileges observed through it are expected for the RDS master
  login. Core application identities remain separate: `core_runtime` and
  `core_migrator` have no membership in each other or Auth roles, no effective
  privileges on Auth relations, and no `CREATE` on `auth` or `public`; no
  relations existed in `public`. The raw effective-role evidence is retained in
  `gootip-infra/audit/pg18-spec14-admin-membership-20261030.txt` with this
  corrected interpretation.
- The Auth schema remains owned by `auth_migrator`; the same seven relations
  remain owned by that role. Both history rows (`000001`, `000002`), all recorded
  metadata/checksums, and their ordered digest match the 2026-10-26 baseline.
  The two current default ACL entries also match the recorded baseline. Current
  table-level probes show Auth runtime and operator DML on application tables,
  with history write restrictions; the 2026 baseline reports aggregate table
  privileges, not per-table history permissions, so exact per-object grant
  preservation cannot be inferred from it. The historical membership baseline
  predates SPEC 14 and therefore does not show the subsequently intended
  administrative membership from the RDS master login to `core_migrator`.

This comparison demonstrates that Auth migration history metadata, schema and
relation ownership, and recorded default ACLs currently match the prior
snapshot. It does **not** prove retrospective preservation of Auth row data,
operator/Auth credential authentication, or all per-table privileges: the
baseline has no row counts/data digest or matching per-object grants, and no
pre-bootstrap live snapshot exists for this run. The unchanged Auth secret
references/current versions are separate Secrets Manager evidence, not SQL
credential proof.

Application identity/configuration evidence: the Auth Lambda source requires the
`auth_runtime` username, and its Terraform IAM policy reads only the application
and exact Auth runtime secret ARNs; it contains no master-secret reference. Core
API configuration consumes `POSTGRES_DB_USER`, and the Core runtime README and
integration contract set it to `core_runtime`; unlike Auth's loader, the Core
API datasource does not hard-code/reject a different username. The separate
Core migration runner, enabled in `dev.tfvars` only for the pending Step 9 plan,
is fixed to `core_migrator`;
its IAM policy reads only that exact migrator secret. Neither application role
is granted the RDS master secret.
`environments/dev.tfvars` sets `application_runtime_deployment_enabled=false`;
`core_migrations_deployment_enabled=true` only to prepare the SPEC 06 Step 9
saved plan, which has not been applied. A read-only query as
`GootipTerraformDeploy` confirmed `lambda_db_config` is Active, uses `gootip`
with `verify-full`, and carries the exact Core runtime and migrator secret ARN
references. The same principal was denied
`lambda:GetFunctionConfiguration` on the exact Auth application function
`gootip-auth-dev`; the deployed Auth environment's secret references and
exclusion of master/Core migrator credentials therefore remain unverified.
These source/Terraform contracts are not proof of that deployed configuration.

The isolated TypeORM 1.1.2 preflight, future-object grants, incompatible-history
rejection, concurrency/timeout/rollback, and fixture-cleanup checks passed; see
`gootip-infra/audit/spec14-isolated-tests-20261030.txt`. These establish the
SPEC 14 code-and-handoff behavior on disposable PostgreSQL, not live AWS runner
behavior.

The user accepts the unpreserved pre-mutation inventory and missing historical
Auth row counts/data digest as explicit handoff limitations. This acceptance does
not demonstrate or reconstruct either fact; those acceptance checks remain
unproven and no further reconstruction will be attempted. No pre-bootstrap
per-object privilege snapshot exists either, so retrospective Auth data and
per-object privilege preservation cannot be proven.

Effective logging settings were queried read-only through the existing
TLS-verified tunnel on 2026-10-30 02:15 UTC; see
`gootip-infra/specs/14-core-administrative-bootstrap.md`. At that observation,
`log_statement=none`, duration logging was disabled, and
`log_min_error_statement=error`. No PostgreSQL or CloudWatch logs were read, so
there is no evidence about whether credential-bearing SQL was logged during the
bootstrap or which settings were effective then. A failed
`ALTER ROLE ... PASSWORD` may still have its literal SQL text recorded at the
current error threshold. No parameter or IAM change was made.

Authentication of the application DB credentials and the deployed Auth Lambda
environment were not verified. No `lambda:GetFunctionConfiguration` permission
was added. These limits are not fixed by isolated tests.

SPEC 06 owns the Core runner saved plan/deployment, private invocation, live RDS
migration, post-migration history/grant verification, and application smoke
checks. Its deployment flag is true in `dev.tfvars` only for the pending Step 9
plan; the plan has not been applied. The exact Auth application configuration
read was denied, so do not infer deployed presence from local flags or report
SPEC 06 checks as complete. The expected administrative
`gootip_auth -> core_migrator` membership was not changed.

## Known operational notes

- `ALTER ROLE ... PASSWORD '<value>'` carries the new password as SQL text. It is
  encrypted in transit by the verified TLS session, but the statement text can
  reach the PostgreSQL log if statement logging is enabled. Keep
  `log_statement` and `log_min_duration_statement` at their defaults and do not
  enable statement logging on this database. Passwords are stored hashed
  (`scram-sha-256`), never in clear text.
- The bootstrap login is the RDS master, which is not a true superuser. It can
  create roles with the restricted attributes and set `LOGIN`, `NOCREATEROLE`,
  and `PASSWORD`, but it cannot negate `SUPERUSER`, `CREATEDB`, `REPLICATION`, or
  `BYPASSRLS`. Those are therefore verified rather than reasserted.
- TLS is verified separately against the real RDS instance:

  ```bash
  PYTHONPATH=src uv run python scripts/verify_tls.py
  ```

  The four checks confirm an encrypted session, wrong-CA rejection,
  hostname-mismatch rejection, and non-TLS rejection. They require a private
  client that can reach the SPEC 02.2 database and the same environment
  variables as the function.

## What is verified automatically

| Contract item | Covered by |
| --- | --- |
| Event, configuration, and secret validation before SQL | `tests/test_events.py`, `tests/test_config.py`, `tests/test_credentials.py` |
| TLS parameters, timeouts, encrypted-session check | `tests/test_db.py` |
| Role, schema, grant, and default-privilege SQL composition | `tests/test_reconcile.py` |
| Restricted-attribute drift fails the bootstrap | `tests/test_reconcile.py` |
| Advisory-lock identity and bounded acquisition | `tests/test_locking.py` |
| Sanitized success and failure responses | `tests/test_handler.py` |
| Runtime DML, runtime DDL denial, migrator DDL, cross-schema denial, role-membership denial, future-object grants | `tests/integration/test_effective_privileges.py` |
| Repeated invocation, lock exclusivity, concurrent invocation, end-to-end handler run | `tests/integration/test_orchestration.py` |
