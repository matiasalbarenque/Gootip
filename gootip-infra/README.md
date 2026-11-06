# gootip-infra

Terraform infrastructure for the existing Gootip AWS Sign up for AWS (new)
project in `us-east-2`.

See the [Postman collection guide](docs/postman-collection.md) for generating
and importing the dev API collection after loading the infra MFA session.

## Local Terraform plan artifacts

Saved plans and related JSON/output files belong in `artifacts/plans/` inside
the Terraform root being used. Bootstrap uses `bootstrap/artifacts/plans/`.
Both directories are ignored by Git. Existing loose plans have been moved there
without changing their contents; historical filenames in audit records remain
the names used at execution time.

The project's `.envrc` creates both directories and sets
`TF_CLI_ARGS_plan=-out=artifacts/plans/tfplan`. With direnv loaded, a plain
`terraform plan` saves to that path, including when using `-chdir=bootstrap`.
Use a descriptive filename for a plan that needs a separate review:

```bash
mkdir -p -m 700 artifacts/plans
terraform plan -out=artifacts/plans/change-name.tfplan -var-file=environments/dev.tfvars
terraform show artifacts/plans/change-name.tfplan
# Apply only after reviewing this exact saved plan.
terraform apply artifacts/plans/change-name.tfplan
```

Without direnv, create the directory and pass `-out` explicitly as above.
Explicit CLI flags override the environment default, so keep their paths under
`artifacts/plans/` too. Do not overwrite a plan still awaiting review or apply.
This organization does not relocate Terraform state, backend configuration,
credentials, audit evidence, or deployment ZIPs.

### Local dev AWS references

Keep the account-specific AWS resource references for the application root in
the ignored `.env.aws-dev` file next to `.envrc`. Define these Terraform inputs
with the `TF_VAR_` prefix using the exact references for your dev deployment.

- `db_master_secret_arn`, `db_operator_secret_arn`, `auth_runtime_secret_arn`,
  `auth_migrator_secret_arn`, `core_runtime_secret_arn`, and
  `core_migrator_secret_arn`
- `application_runtime_boundary_arn` and `core_migrations_runtime_boundary_arn`
- `db_tunnel_ami_id`

Set `TF_VAR_aws_account_id` to the independently confirmed dev account and
`GOOTIP_DEV_API_URL` to the reviewed HTTPS origin used by the Auth administrator
script. The bootstrap root also requires the exact reviewed
`TF_VAR_deployment_application_client_security_group_id`,
`TF_VAR_deployment_db_tunnel_ami_id`, and
`TF_VAR_deployment_db_tunnel_subnet_id`. Keep these pins in the same local file
and load it before using either Terraform root. Use the same approved AMI ID
for `TF_VAR_db_tunnel_ami_id` and `TF_VAR_deployment_db_tunnel_ami_id`.

For example, set `TF_VAR_db_tunnel_ami_id` to the approved dev tunnel AMI ID.
Run `direnv allow` from `gootip-infra/` to load the file before planning with
`-var-file=environments/dev.tfvars`. Without direnv, export the same variables
in the shell before running Terraform. Keep secret values in Secrets Manager.

## SPEC 08 bounded authentication traffic test

Run only after the SPEC 04 migration is validated/applied and SPEC 10 explicitly
activates the application. This contract is a cap, not a production load target:

- Maximum duration: 5 minutes; maximum requests: 500 total, including retries.
- Keep API Gateway stage throttling at 10 requests/second and burst 20; do not
  raise either limit during the test.
- Stop if RDS `DatabaseConnections` exceeds 56, Lambda errors occur, or the
  existing SPEC 06 throttling/consumption alarms fire. Never raise the reserved
  concurrency cap of 5 to continue.
- Before and after, record `auth."rateLimit"` row count and query latency for
  expired-row cleanup. Stop if row count grows by more than 500 or cleanup
  latency exceeds 1 second; investigate before another run. Cleanup is
  opportunistic and not batch-bounded.
- Stop immediately on elevated database CPU, unexpected spend/consumption
  notification, or any customer-impacting error. Disable public activation via
  the reviewed SPEC 10 rollback procedure; do not destroy or replace database
  resources.

Record request count, duration, API throttle responses, Lambda errors/throttles,
RDS connection peak, counter rows before/after, cleanup latency, and SPEC 06
alarm/consumption outcomes. These limits do not provide per-account protection
or an absolute spending cap.

## IAM creation-API exception

An AWS create API that cannot authorize a resource before it exists may use a
single-action `Resource: "*"` grant only with exact Region and required request
tag conditions, an exact tag-key allowlist, and `Null aws:TagKeys = false`.
The action list may not use wildcards; all later resource management uses the
exact ARN.

## Account preflight

Run the authentication gate independently from the Free Plan eligibility and
billing gate. Passing authentication does not imply that the account is
eligible for application or other potentially billable resource creation.

### Authentication and identity gate

```bash
aws sts get-caller-identity --profile gootip-dev
```

The result must identify the `gootip` IAM user and return a twelve-digit
Account ID. Confirm that ID and the assigned Region independently in AWS
Settings for the exact project. Do not derive both the actual and expected
values from the same CLI profile, and do not record the Account ID in Git.

### Eligibility and billing gate

```bash
aws freetier get-account-plan-state \
  --profile gootip-dev \
  --region us-east-2
aws iam get-account-summary --profile gootip-dev
aws iam get-account-properties --profile gootip-dev
```

The expected account plan is `FREE` with status `ACTIVE`. Also record the
current expiration, remaining credits, eligible-service access, and relevant
quotas in AWS Settings. Do not create application or other potentially
billable resources while this gate is unresolved. IAM/STS role creation and
repair are independent from plan eligibility.

An authorization denial is evidence, not permission to add a temporary grant.
Record a denied read with the independent AWS Settings evidence and classify it
under SPEC 02.1. Do not add or retain an IAM policy to bypass a denied
eligibility, account-property, or SCP read.

### Official references

- [AWS Free Tier](https://aws.amazon.com/free/)
- [Choosing an AWS account plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)
- [Compare AWS sign-up options](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html)
- [Supported services for the new AWS experience](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html)
- [IAM and STS](https://docs.aws.amazon.com/IAM/latest/UserGuide/introduction.html)
- [IAM and STS quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)
- [Secure API access with MFA](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_configure-api-require.html)
- [Using an IAM role in the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-role.html)
- [AWS CLI configuration and `mfa-login`](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html)
- [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)

## Backend configuration rendering

The tracked application root retains its current backend until the legacy state
inventory and protected migration step. The bootstrap root starts with local
state and receives its S3 backend block only when it is ready for its reviewed
migration. Never copy an Account ID, bucket, key, or role ARN into a tracked
file.

After independently confirming the twelve-digit Account ID and creating the
account-qualified bucket through the approved bootstrap phase, render the
bootstrap files immediately before its migration:

```bash
./scripts/render_backend_config.sh \
  --root bootstrap \
  --confirmed-account-id "<ACCOUNT_ID>"
```

Do not render or activate the application backend yet. During the separate
application-state migration step, first inventory the active backend and both
candidate keys, preserve its configuration and state evidence, prove the
destination is empty, and establish the reviewed migration permissions. Only
then render the application configuration:

```bash
./scripts/render_backend_config.sh \
  --root application \
  --confirmed-account-id "<ACCOUNT_ID>"
```

The renderer requires the canonical root profile, verifies the selected STS
assumed-role ARN, checks the independently confirmed account, derives
`gootip-terraform-state-<ACCOUNT_ID>`, and verifies bucket ownership by listing
only the canonical state prefix with `--expected-bucket-owner`. It renders only
these canonical keys:

| Root        | Profile                   | Key                            |
| ----------- | ------------------------- | ------------------------------ |
| Bootstrap   | `gootip-bootstrap-admin`  | `bootstrap/terraform.tfstate`  |
| Application | `gootip-terraform-deploy` | `gootip/dev/terraform.tfstate` |

Generated `backend.tf` and `.s3.tfbackend` files are ignored. If an output file
already differs from the rendered contract, the command stops instead of
overwriting it. Review the active backend, remove the stale file deliberately,
and rerun; never use deletion to bypass an uncertain state location.

## AWS profiles (SPEC 02.1 target)

SPEC 02.1 supersedes the original direct-user profile flow. Entering this
directory exports
`AWS_PROFILE=gootip-terraform-deploy`; `gootip-dev` remains only the permanent
source profile used to mint fresh MFA credentials. Leaving the directory
unsets/restores the previous value.

Setup (once per machine):

```bash
brew install direnv
# add to ~/.zshrc:
eval "$(direnv hook zsh)"
# restart your shell, then trust this repo once per checkout:
cd gootip-infra && direnv allow .
```

Verify:

```bash
cd gootip-infra && echo $AWS_PROFILE  # prints: gootip-terraform-deploy
cd .. && echo $AWS_PROFILE             # unset or restored
```

Pre-apply check (always run before Terraform):

```bash
echo $AWS_PROFILE  # must print gootip-terraform-deploy
```

### MFA source session and automatic renewal (SPEC 02.4)

Entering this directory — or opening an interactive shell inside it — verifies
the long-lived `gootip-mfa` source session and prompts for an MFA code only when
that session is missing or AWS explicitly reports its token expired. A valid
session is reused silently; moving between directories inside the tree does not
prompt again; non-interactive shells, CI, and `direnv exec` never prompt. direnv
still selects `AWS_PROFILE`; the hook only manages the source session.

Setup (once per machine):

```bash
# direnv, as in the section above.
brew install direnv
eval "$(direnv hook zsh)"                # in ~/.zshrc

# install the hook from your checkout (absolute path).
echo "source $PWD/scripts/gootip-mfa.zsh" >> ~/.zshrc

# store the MFA device ARN locally (never commit it).
aws configure set mfa_serial <MFA_DEVICE_ARN> --profile gootip-dev

# request one-hour role sessions in both role profiles.
# AWS caps an assumed-role session at one hour when it chains from the
# gootip-mfa session, so a larger request fails the assumption.
aws configure set duration_seconds 3600 --profile gootip-bootstrap-admin
aws configure set duration_seconds 3600 --profile gootip-terraform-deploy
```

Renew the source session on demand while you stay inside the directory:

```bash
gootip-mfa-refresh
```

Both the hook and `gootip-mfa-refresh` run
`aws configure mfa-login --profile gootip-dev --duration-seconds 10800
--update-profile gootip-mfa`. Set `GOOTIP_MFA_DISABLE=1` to disable the hook for
the current shell.

**Independent lifetimes.** `GetSessionToken` source credentials (`gootip-mfa`)
and `AssumeRole` role credentials expire independently. An assumed role issued
near the end of the source session can stay usable after the source credentials
expire, because the three-hour `aws:MultiFactorAuthAge` condition is evaluated
when the role is assumed, not continuously. Do not read three hours as a shared
hard cutoff.

The **source** session lasts three hours; each **assumed-role** session lasts one
hour. AWS caps a session assumed by role chaining — including assumption from the
`gootip-mfa` `GetSessionToken` credentials — at one hour
([AWS: role chaining session duration](https://repost.aws/knowledge-center/iam-role-chaining-limit)),
so requesting more than one hour in a role profile fails. The three-hour source
session means you enter an MFA code roughly every three hours, while the CLI
re-assumes each role hourly without another prompt for as long as the source
session is valid. Cached role credentials may survive a renewal, so verify with a
fresh assumption rather than a cached one.

**Troubleshooting:**

- `gootip-mfa: could not verify ... (access denied | network failure | invalid
  credentials | unrecognized error)` — the check hit an uncertain failure and
  deliberately did not launch login. Fix the cause (network, credentials,
  permissions) and rerun `gootip-mfa-refresh`.
- `gootip-mfa: no MFA device ARN is configured` — run setup step 3 above.
- `gootip-mfa-refresh: needs an interactive terminal` — run it in an interactive
  shell, never from a script or CI.
- `ValidationError: ... exceeds the 1 hour session limit for roles assumed by
  role chaining` — a role profile is requesting more than one hour. Set
  `duration_seconds = 3600` for that profile; the source session stays three hours.

**Manual live validation.** With an MFA-authenticated `gootip-mfa` session, force
a fresh role assumption without touching caches or the parent shell:

```bash
role_arn=$(aws configure get role_arn --profile gootip-terraform-deploy)
env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN \
  aws sts assume-role --profile gootip-mfa --role-arn "$role_arn" \
    --role-session-name gootip-verify --duration-seconds 3600 \
    --query AssumedRoleUser.Arn --output text
```

Run it once with a fresh source session and again after the source session is
older than one hour (and younger than three): both must succeed **without a new
MFA code**, and each assumed-role session lasts one hour.

**Rollback to the previous one-hour behavior:** remove the marked
`# >>> gootip-mfa (SPEC 02.4) >>>` … `# <<< gootip-mfa (SPEC 02.4) <<<` block
from `~/.zshrc`, restore the `~/.zshrc.gootip-mfa.bak.*` and
`~/.aws/config.gootip-mfa.bak.*` backups, and set
`aws configure set duration_seconds 3600 --profile <role>` for both role
profiles. The IAM-side rollback (the shared MFA-age condition back to 3,600
seconds; the role maximums already stay at 3,600) is described in
`bootstrap/README.md`.

Personal overrides: copy `.envrc` to `.envrc.local` (git-ignored) and edit
the copy — never edit the tracked `.envrc` for personal use.

## Foundation topology and deferred authentication artifact

SPEC 02.2 creates two private RDS subnets, no Internet or NAT gateway, and one
Secrets Manager interface endpoint in the explicitly selected private subnet.
The endpoint uses private DNS. Native Lambda logging does not require a Logs
interface endpoint, so none is created. This accepted dev topology trades
endpoint-AZ availability for lower fixed cost; it is not Multi-AZ endpoint
resilience.

The authentication Lambda and public HTTP API remain disabled until SPEC 10,
so foundation plans do not require an application ZIP or public application
URL. Build the Hono Lambda artifact only for that later deployment:

```bash
pnpm --dir ../gootip-auth build:lambda
pnpm --dir ../gootip-auth lambda:zip
```

The ZIP contains only `dist/lambda.mjs`; the Lambda handler remains
`dist/lambda.handler`. Terraform also publishes the official regional RDS CA
bundle as a shared layer and configures the application for verified
PostgreSQL TLS. Before every foundation plan, create the deterministic CA layer
archive from the official `us-east-2` trust store, retain it and its checksum
with the saved plan, and verify the exact bytes immediately before apply:

```bash
./scripts/package_rds_ca_layer.sh
terraform plan -out=artifacts/plans/foundation.tfplan -var-file=environments/dev.tfvars
./scripts/verify_rds_ca_layer.sh
terraform apply artifacts/plans/foundation.tfplan
```

Never run the packaging script between the saved plan and its apply. The ZIP
contains only `certs/rds-ca-bundle.pem`; the archive and checksum are ignored
local operational records, not application secrets.

## Authentication runtime credential (SPEC 05)

SPEC 03 created the `auth_runtime` role, the `auth` schema, and the empty
bootstrap-owned container `${project}-${env}-auth-runtime` under the SPEC 02.1
control plane; SPEC 04 established the reviewed auth schema through the
restricted migrator. The application root consumes only the non-secret ARN
reference recorded in `environments/dev.tfvars`:

```hcl
# environments/dev.tfvars (reference, never a value)
auth_runtime_secret_arn = "arn:aws:secretsmanager:us-east-2:<ACCOUNT_ID>:secret:gootip-dev-auth-runtime-<SUFFIX>"
```

Secret-container ownership never moves into this root: `bootstrap/secrets.tf`
creates the container, and `GootipTerraformDeploy` still cannot manage
containers or values (its explicit `DenySecretsManagerMutationAndValues` and
`DenyNonRdsSecretsManagerCreateAndTag` denies are unchanged).

Value loading stays out-of-band and administrative. Only `GootipBootstrapAdmin`
may read and write the approved values, through `OperateExactApprovedSecretValues`
in `GootipBootstrapAdminPermissions`, which names exactly the application
secret, the `auth-runtime`, `auth-migrator`, and `db-operator` containers after
the reviewed phase-2 apply. The reviewed procedure lives in
`gootip-db-config/README.md` ("Loading non-production role credentials"): as the
`gootip-bootstrap-admin` profile, run `put-secret-value` with
`{"username":"auth_runtime","password":"<non-production-value>"}` after phase 2,
never from Terraform, a tracked file, or Git. The administrative function
rejects a username that does not match the configured role before any SQL runs.

### First deployment and rollback (handoff to SPEC 10)

SPEC 05 prepares the contract but deploys nothing: `application_runtime_deployment_enabled`
stays `false`, so no authentication Lambda, HTTP API, or runtime IAM exists yet.
SPEC 10 owns the first activation and the deployed database-backed smoke test. Use
this order for the reviewed cutover.

Preconditions, all required before planning the first application deployment:

1. SPEC 03 bootstrap is applied on dev: the `auth_runtime` role, the `auth` schema,
   and the empty `${project}-${env}-auth-runtime` container exist, and the phase-2
   apply pinned both role-secret ARNs.
2. SPEC 04 migrations are applied: the migration runner reports `succeeded` with no
   pending migrations and the expected history digest. Missing, gapped, or drifted
   history blocks activation; the runtime role never receives DDL.
3. The runtime value is loaded out-of-band by `GootipBootstrapAdmin` (step above).
   Terraform holds the ARN reference only.
4. The application root supplies the reviewed `app_secret_arn`,
   `application_runtime_boundary_arn`, and `auth_runtime_secret_arn`, and the artifact
   was built from the reviewed commit (`pnpm --dir ../gootip-auth build:lambda` then
   `pnpm --dir ../gootip-auth lambda:zip`).
5. The saved plan contains only the expected creates or in-place updates, and the
   `gootip-auth-${env}` function environment contains `SECRET_ARN` and
   `DB_RUNTIME_SECRET_ARN` only — never `DB_MASTER_SECRET_ARN`.

Cutover:

```bash
# Plan with application_runtime_deployment_enabled = true for this reviewed deployment.
terraform plan -out=artifacts/plans/auth-runtime.tfplan -var-file=environments/dev.tfvars
terraform show -json artifacts/plans/auth-runtime.tfplan | jq '.planned_values' > artifacts/plans/auth-runtime.plan.json
# Review the exact function environment, IAM allowlist, and absence of unexpected
# creates, replacements, or deletes, then apply the reviewed saved plan by filename.
terraform apply artifacts/plans/auth-runtime.tfplan
```

Then run SPEC 10's database-backed smoke test (sign-up and sign-in through the public
API) and confirm the sanitized logs contain no credential material. Authentication now
connects as `auth_runtime`.

Rollback, with no privileged fallback:

- Disable the runtime instead of restoring master access: set
  `application_runtime_deployment_enabled = false` and apply the reviewed saved plan.
  That removes the authentication Lambda, its runtime IAM, and the HTTP API, while the
  `auth_runtime` role, the `auth` schema, the migration history, and the secret
  containers stay intact.
- Never put the RDS master secret back into the application configuration. The master
  credential is administrative-only (`lambda_db_config`); a broken runtime requires a
  new reviewed runtime configuration and a forward correction, not temporary privilege.
- If the loaded runtime value is wrong or has rotated, reload the container as
  `GootipBootstrapAdmin` (`put-secret-value`) and let new cold starts pick it up; a warm
  Lambda keeps its previous credential until it is recycled. Bounded refresh and
  rotation belong to SPEC 09, not to this configuration.
- Rollback must not destroy RDS data, backups, state, secret containers, or protected
  networking; those are stop conditions in `AGENTS.md`.

### Auth activation package — 2026-10-31

Every precondition in the handoff above is now satisfied for dev: Auth migration
`000003` was applied and post-validated under the unchanged v4 artifact, and the
authorized operator created the initial administrator through the private tunnel.
The result is submitted for one review as two saved plans, applied in this order
only after approval:

| Order | Saved plan | Content |
| ----- | ---------- | ------- |
| 1 | `bootstrap/artifacts/plans/spec10-auth-api-permissions-preapproval-20261031.tfplan` (SHA-256 `31a61edaf3473c07333d76c173a3fff484160af3272282e781868ab1319e0f1d`) | 2 in-place policy updates |
| 2 | `artifacts/plans/spec10-auth-activation-postmigration-20261031.tfplan` (SHA-256 `078bda14292d8317f0097465118ddd904c6dacfcadb7b05e712855229fee2c2f`) | 17 creates, 2 in-place updates |

Both plans contain no delete and no replacement. The bootstrap plan updates only
`GootipTerraformDeployApiGatewayPermissions` and
`GootipTerraformDeployApplicationPermissions`, with `lambda:AddPermission` limited
to the Auth function and the reviewed Auth routes; it adds no Core route grant.
The application plan keeps the Secrets Manager endpoint policy deterministic and
limited to the two Auth secret references, adds only the Auth `api-5xx` alarm to
the operational SNS policy, omits `DB_MASTER_SECRET_ARN` from the function
environment, and its `source_code_hash` matches `gootip-auth/lambda.zip`.

Neither plan has been applied. Public traffic is not active, and Core activation
remains gated on validating the Auth issuer and JWKS first.

## RDS recovery window under the Free Plan

The active AWS Free Plan rejected the original seven-day automated-backup
retention during foundation creation. SPEC 02.2 therefore uses
`backup_retention_period = 1` for the dev database: automated backups remain
enabled, but the recovery window is one day rather than seven. Deletion
protection remains enabled and destruction still requires a final snapshot;
do not change retention to zero or upgrade the account plan without separate
approval.

`BETTER_AUTH_URL` is the public API origin without `/api/auth`. AWS application
resource names retain the `gootip-auth` identity; the canonical state key is
defined separately below.

## Shared local PostgreSQL (SPEC 13)

One project-scoped PostgreSQL 18 service serves local development and all
integration suites. Its persistent Compose volume is `postgres_data`; ordinary
stop/start and `docker compose down` preserve it. Never use `down -v` or remove
the volume as part of routine cleanup.

Initial setup and normal workflow:

```bash
cp local/postgres.env.example local/postgres.env
# Set local-only passwords in local/postgres.env; do not commit it.
./scripts/local_postgres.sh bootstrap
./scripts/local_postgres.sh migrate
./scripts/local_postgres.sh integration
```

The service listens on `127.0.0.1:5433`; development database `gootip` uses
`auth` and `core` schemas with separate runtime and migrator roles. Configure
`gootip-auth/.env` with `auth_runtime` and `AUTH_RUNTIME_PASSWORD`, and
`gootip-core/.env` with `core_runtime` and `CORE_RUNTIME_PASSWORD`. Migration
credentials are supplied only to the explicit migration command. `bootstrap`
reasserts the role/schema contract without dropping data; `migrate` applies the
reviewed auth ledger and existing TypeORM migrations. The integration command
uses separate allowlisted databases and namespaced roles, executes suites
serially, and removes only those test resources. It never stops PostgreSQL or
removes the persistent volume.

The SPEC 13 workstation cutover recreated the active local database from
committed migrations; it did not import application rows from either old
container. The previous `gootip-auth` and `gootip-core-postgres-1` containers
are stopped, and their old volumes are intentionally retained. Only after both
applications and the shared integration command pass, remove those exact
containers without `-v`:

```bash
docker rm gootip-auth gootip-core-postgres-1
```

Do not remove either old volume, the `postgres_data` volume, or unrelated Docker
resources. To diagnose a startup failure, inspect:

```bash
docker compose --env-file local/postgres.env -f compose.local.yaml logs postgres
docker compose --env-file local/postgres.env -f compose.local.yaml ps
```

The local PostgreSQL volume remains available for correction after a failed
migration.

The S3 backend follows SPEC 02.1: the bootstrap root creates and protects
`gootip-terraform-state-<ACCOUNT_ID>`, while this application root uses only
`gootip/dev/terraform.tfstate`. Do not initialize until the account and backend
guards in SPEC 02.1 pass.

## Core administrative bootstrap (SPEC 14)

SPEC 14 extends the existing private `lambda_db_config` to create and reconcile
the Core administrative contract. Its application-root configuration requires
exact references for both Core credential containers:

```hcl
core_runtime_secret_arn  = "arn:aws:secretsmanager:us-east-2:<ACCOUNT_ID>:secret:gootip-dev-core-runtime-<SUFFIX>"
core_migrator_secret_arn = "arn:aws:secretsmanager:us-east-2:<ACCOUNT_ID>:secret:gootip-dev-core-migrator-<SUFFIX>"
```

Terraform manages only the empty containers and narrowly scoped IAM references;
credential values are loaded out of band using the metadata-first, no-overwrite
procedure in `gootip-db-config/README.md`. The exact Core ARNs are recorded in
`environments/dev.tfvars`; they are references, never credentials. The boundary
and application plans have been applied, and the administrative bootstrap plus
its idempotent repeat succeeded. Its dated evidence and read-only SQL checks are in
`gootip-db-config/README.md`. RDS metadata confirms `gootip_auth` is the configured
master login; its `core_migrator` membership is the expected bootstrap
owner-role grant made to `current_user` and allowed by SPEC 14. It does not
represent an application runtime credential. Auth's runtime contract requires
`auth_runtime`; Core's documented API runtime uses `core_runtime` through
`POSTGRES_DB_USER` (the datasource accepts the configured value rather than
hard-coding it). The Auth IAM policy is scoped to its app/runtime secrets, while
the separate Core migration runner is scoped to the Core migrator secret. The
Auth application flag remains `false`. The Core migration flag is `true` in
`dev.tfvars`; the reviewed Core runner plans have been applied and SPEC 06's
manual migration sequence completed. This does not deploy or activate the Core
API. The current logging check through TLS-verified SQL
reported `log_statement=none`, duration logging disabled, and
`log_min_error_statement=error`. No logs were read; these current settings do not
prove which settings were active during bootstrap. The user accepts the missing
pre-bootstrap inventory and historical Auth row-data digest as evidence limits;
they are not reconstructed or claimed as verified.

The deployment role read `lambda_db_config` configuration successfully: it is
Active, `python3.13`, targets `gootip` with `verify-full`, and contains the exact
Core runtime and migrator secret ARN references. The read-only
`lambda:GetFunctionConfiguration` request for the exact Auth application
function `gootip-auth-dev` was denied. Therefore the mandatory live check that
the deployed Auth function's environment contains only its application and
`auth_runtime` secret references, and excludes the RDS master and Core migrator
credentials, remains blocked. No permission was added.
On 2026-10-30, a separate read-only `lambda:GetFunctionConfiguration` request
for `gootip-dev-auth-migrations` was also denied to `GootipTerraformDeploy`;
`gootip-dev` could read it. This was a diagnostic request, not a Terraform
requirement for the SPEC 07.1 policy plan: the focused plan succeeded under the
deployment role, and the pinned AWS provider 6.68.0 `aws_lambda_function`
refresh calls `GetFunction`. The provider uses `GetFunctionConfiguration` in
version-update wait paths; no Lambda update or version publish is in this plan.
No permission was added for the diagnostic request.
The SPEC 14 boundary plan grants read scope only to the exact Core secret ARNs;
`core_migrations_log_access_enabled` stayed false in that administrative phase.
The separate SPEC 06 boundary correction is now prepared as a saved plan (see
Step 4 evidence below), not applied. The temporary invocation grant has been
revoked while the administrative Lambda remains deployed.

## Private Core migrations (SPEC 06)

The Core migration runner is a separate private Node.js 24 ARM64 Lambda. The
application root defaults `core_migrations_deployment_enabled` to `false`; the
reviewed dev input enables the private runner. Its reviewed bootstrap capability
and application plans have been applied, and the live dev migration acceptance
sequence is recorded in `../gootip-core/audit/dev-core-migrations-20261030.json`.
The runner is separate from the Core API, which remains un-deployed. Local SPEC 13
setup does not satisfy the AWS administrative prerequisite, and this executor does not create
database roles, schemas, secret containers or values, or grants.

The 2026-10-30 `deployment` alias read-only check found version `2`, no weighted
routing, and code digest
`JolJ1DUKkeKR/23eIStrOvX0QGzetawqNrxM8eokp5g=`. The official migration build
and ZIP commands were run in a detached worktree at the recorded release commit
`9c5fd9b8878d0823c539b539f0a785fb5c94179a`; its manifest SHA-256
`f864a96ccd1ce4b2b90b9cc2c6aac14f61414d07dffc2c68d23fd0af9a0a0632` and ZIP
digest matched the release audit and deployed version. The real ZIP is restored
at `../gootip-core/migration-lambda.zip` for Terraform planning.

For a future deployment or re-enablement, verify the live administrative
handoff and record its non-sensitive evidence:

- The target database contains the `core` schema owned by `core_migrator` and
  separate `core_migrator` / `core_runtime` identities with no membership
  between them.
- The bootstrap-owned credential secret already exists and contains the
  `core_migrator` username and password. Terraform must never create or load the
  value.
- The exact full secret ARN is in this account and `us-east-2`; `core_runtime`
  has runtime DML but cannot perform DDL or read/write `core.typeorm_migrations`.
- Both roles are confined to Core: verify neither can alter Auth objects or
  create objects in `public`; verify catalog DML succeeds for runtime.
- Record whether Core is empty or has compatible TypeORM history. Existing
  objects without compatible history stop this workflow; do not adopt them,
  fake migrations, or repair history here.

The current input supplies these non-sensitive references:

```hcl
core_migrations_deployment_enabled   = true
core_migrator_secret_arn             = "arn:aws:secretsmanager:us-east-2:<ACCOUNT_ID>:secret:gootip-dev-core-migrator-<SUFFIX>"
core_migrations_runtime_boundary_arn = "arn:aws:iam::<ACCOUNT_ID>:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary"
```

The executor reads only that exact Core migrator secret. Its client security
group has no default egress: it can reach only the existing RDS security group
on PostgreSQL 5432 and the existing Secrets Manager endpoint security group on
HTTPS 443. Reciprocal RDS and endpoint ingress references are present only while
the feature is enabled. The Lambda reuses the already-deployed shared RDS CA
layer; it does not create or deploy a second layer. Its deployment alias ARN is
exported as `core_migrations_deployment_alias_arn`; the dev alias currently
targets published version `1` without weighted routing. See the dated Core
evidence for the matching artifact and history digests.

Build `../gootip-core/migration-lambda.zip` from the reviewed Core commit before
planning. Apply the separately reviewed bootstrap deployment capability only
through its own approved saved plan; this application plan does not provision or
repair bootstrap IAM. Then review and save the application plan, checking that
it contains only the intended Core role/policy, Lambda, alias, log group, client
security group, narrow security-group rule changes, and the exact secret/boundary
references. Stop on any unexpected resource, delete, or replacement. Apply only
the reviewed saved plan by filename under the repository deployment policy.

After deployment, use the Core README's manual migration runbook. Verify the
`deployment` alias still points to the reviewed published version and has no
weighted routing immediately before each call. Do not update the alias or run
another deployment during validation/apply/reconciliation. The deployment
principal may invoke only this Core alias; never invoke the unqualified function
or a numeric version. Transport success is not migration success: retain the
sanitized result and require the returned status, empty pending list after apply,
and matching post-validation history digest. On a timeout or uncertain result,
run `validate` against the unchanged artifact before any retry; never blindly
repeat `apply`.

## PostgreSQL lifecycle contract (SPEC 12)

`rds_engine_version` is the PostgreSQL major prefix `18`, not an exact patch.
The `aws_rds_engine_version` data source resolves it with `latest = true` and
`parameter_group_family = "postgres18"`, while `aws_db_instance.main` keeps the
prefix. The applied patch is reported separately as live state, so an
AWS-approved `18.x` minor update never creates a Terraform downgrade plan.

- `auto_minor_version_upgrade = true` lets AWS apply approved PostgreSQL 18
  minor releases inside `maintenance_window = "sun:03:00-sun:04:00"` UTC
  (Sunday 00:00-01:00 in Argentina).
- `apply_immediately = false` keeps the planned upgrade inside that window.
- `allow_major_version_upgrade = true` authorizes the reviewed in-place major
  change only. It never permits an automatic PostgreSQL 19 upgrade.
- `gootip-dev-postgres18` (family `postgres18`) is created as a separate
  resource while the existing `gootip-dev-postgres` (family `postgres17`) stays
  managed and untouched. Both preserve `rds.force_ssl = 1`.
- The first upgrade plan creates PostgreSQL 18 and points `aws_db_instance.main`
  at it in place: one add, one change, zero deletes. A separate cleanup plan
  removes only `gootip-dev-postgres` after 18.6 is `in-sync` and the 24-48h
  observation passes.
- The instance stays private, Single-AZ, `db.t3.micro`, encrypted, protected by
  deletion protection, and backed by the one-day retention described above.

Run the pre-upgrade checks through the private tunnel with verified TLS:

```bash
./scripts/db_access.sh tunnel

# `host` must stay the real RDS endpoint for verify-full certificate matching;
# `hostaddr` is the local tunnel listener.
DB_HOST="$(./scripts/db_access.sh info |
  awk -F': ' '/^Certificate hostname:/{print $2}')"
PGPASSWORD="$(./scripts/db_access.sh password)" \
  psql "host=$DB_HOST hostaddr=127.0.0.1 port=15432 dbname=gootip \
  user=gootip_dev_operator sslmode=verify-full \
  sslrootcert=.db-access/rds-ca-bundle.pem" \
  -f scripts/postgresql18_prechecks.sql
```

An empty result set is clean. Critical findings stop the upgrade; warnings are
recorded for a targeted post-upgrade `REINDEX` or `ANALYZE`, never a blanket
run.

RDS cannot downgrade a major version in place. The rollback model is a
separately reviewed restore of the retained snapshot
`gootip-dev-pre-pg18-20261025` into a new instance and endpoint cutover. Keep
that snapshot until post-upgrade observation confirms no regression; deleting
it is a separate approved cleanup. The next required major-version review is
before PostgreSQL 18 standard support ends on February 28, 2031.

## Private dev database access (SPEC 05.2)

The dev PostgreSQL instance stays private. Workstation access uses one
private EC2 Instance Connect Endpoint and one stopped-by-default `t4g.micro`
tunnel host. `scripts/db_access.sh` is the sole documented entry point. It
fixes profile `gootip-db-operator`, Region `us-east-2`, the account, resource
names, database identifier, remote SSH port, and remote PostgreSQL port; it
does not create NAT, an Internet Gateway, a VPN, an SSM endpoint, public RDS,
or a public instance address.

### Prerequisites and operator profile

Install or confirm:

- AWS CLI v2 with the `ec2-instance-connect` commands.
- OpenSSH `ssh` with normal host-key verification enabled.
- `bash`, `jq`, `unzip`, `shasum`, and `grep`.
- DBeaver Community.
- The reviewed local `rds-ca-layer.zip` and `rds-ca-layer.zip.sha256`. If they
  are absent or stale, recreate them from the official regional trust store:

  ```bash
  ./scripts/package_rds_ca_layer.sh
  ```

  The helper verifies the checksum and exact archive contents on every use.
  Never point it at an unverified CA file.

The `gootip-mfa` source profile must already work with the SPEC 02.4 MFA hook.
Create the database-operator role profile once per machine, replacing
`<ACCOUNT_ID>` with the independently confirmed account:

```bash
aws configure set region us-east-2 --profile gootip-db-operator
aws configure set source_profile gootip-mfa --profile gootip-db-operator
aws configure set role_arn \
  arn:aws:iam::<ACCOUNT_ID>:role/gootip/operations/GootipDatabaseOperator \
  --profile gootip-db-operator
aws configure set duration_seconds 3600 --profile gootip-db-operator

aws sts get-caller-identity --profile gootip-db-operator
```

The identity must be the `assumed-role/GootipDatabaseOperator/...` role in the
expected account. The helper repeats this check and refuses any other account
or role. Do not raise the role duration above one hour; the role maximum and
the endpoint tunnel limit are both 3,600 seconds.

### Commands

Run these from `gootip-infra/`:

| Command                           | Use                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./scripts/db_access.sh info`     | Discover the tagged resources, verify and extract the CA, and print only the non-sensitive DBeaver settings.                                                                                                                                      |
| `./scripts/db_access.sh tunnel`   | Start the host if it is stopped, wait until EC2 reports it running, and keep `127.0.0.1:15432` forwarding to PostgreSQL in the foreground. SSH connectivity confirms operating-system readiness without waiting for the slower EC2 status checks. |
| `./scripts/db_access.sh password` | Print only the current operator password on stdout for DBeaver's shell-command authentication.                                                                                                                                                    |
| `./scripts/db_access.sh stop`     | Stop the exact tagged tunnel host after an interrupted session or for recovery.                                                                                                                                                                   |

`GOOTIP_DB_LOCAL_PORT` may change only the local listening port. It must be an
integer from 1024 to 65535; the default is `15432`. Remote SSH remains `22`,
remote PostgreSQL remains `5432`, and the database identifier remains
`gootip-dev`.

`info` and `tunnel` verify the archive before using any TLS material and write
the reviewed bundle to the ignored `/.db-access/rds-ca-bundle.pem`. Do not edit
that file by hand or substitute a downloaded bundle that the helper has not
verified.

### DBeaver Community settings

Start `./scripts/db_access.sh tunnel` in a terminal and keep it in the
foreground. DBeaver does not own the SSH session; close the tunnel with
`Ctrl-C` only after disconnecting DBeaver.

| Setting                   | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Driver                    | PostgreSQL                                                                           |
| Host                      | `localhost`                                                                          |
| Port                      | `15432`, or the validated `GOOTIP_DB_LOCAL_PORT` override                            |
| Database                  | `gootip`                                                                             |
| Username                  | `gootip_dev_operator`                                                                |
| Authentication            | Password from shell command, using the absolute `Password command` printed by `info` |
| Saved password            | Disabled                                                                             |
| SSL mode                  | `verify-full`                                                                        |
| CA certificate            | The absolute `CA certificate` path printed by `info`                                 |
| Certificate hostname      | The actual RDS endpoint printed by `info`                                            |
| Skip hostname validation  | Disabled                                                                             |
| Verify server certificate | Enabled                                                                              |

The certificate hostname must remain the real RDS endpoint even though the
database host is `localhost`. Wrong CA and wrong-host tests must fail; never
disable server-certificate or hostname verification to make a connection work.

### Host keys and normal shutdown

First use follows normal OpenSSH trust-on-first-use behavior. Verify the
presented tunnel-host fingerprint through an independent source before
accepting it. Later key mismatches must fail; investigate a host replacement
instead of setting `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`,
or any other verification bypass. Remove a stale known-hosts entry only after
the replacement is reviewed.

When `Ctrl-C` closes the foreground tunnel, the helper stops the instance only
if that invocation changed it from stopped to running. A host that was already
running is left running, so coordinate with any other active session. A tunnel
failure after a successful start runs the same cleanup.

If the terminal disappears, the process is killed, or cleanup cannot confirm
the stop, run:

```bash
./scripts/db_access.sh stop
```

`stop` re-discovers the exact tagged host, confirms its identity, and stops it.
It is safe when the host is already stopped. Verify the final state with:

```bash
aws ec2 describe-instances --profile gootip-db-operator --region us-east-2 \
  --filters "Name=tag:Name,Values=gootip-dev-db-tunnel" \
  --query 'Reservations[].Instances[].State.Name' --output text
```

The expected output is `stopped`. Starting a tunnel is an intentional runtime
change; a routine Terraform plan may show the stopped-state resource returning
to its desired value. Stop the tunnel before applying any plan, and treat an
unexplained running host as drift to investigate, not as permission to delete
or replace it.

### Credential rotation

Rotate the `gootip-dev-db-operator` value through the reviewed out-of-band
loader, never through Terraform, a tracked file, or a shell command that leaves
the value in history. The loader procedure is described in
`gootip-db-config/README.md`; the value must keep the
`{"username":"gootip_dev_operator","password":"..."}` shape. `db_access.sh
password` reads the current value on each call, and DBeaver stores no password.
Reconnect after rotation; an existing database session may keep the previous
credential until it is closed.

### Common failure states

- `Could not verify the gootip-db-operator profile` or an MFA error: refresh
  the source session with `gootip-mfa-refresh`, then verify the role profile
  with `aws sts get-caller-identity --profile gootip-db-operator`.
- `Refusing ... expected ... account` or `... operator role`: the profile is
  pointing at the wrong account or role. Fix the local profile; do not work
  around the helper.
- `Expected exactly one tagged ...` or `unexpected state`: the tunnel
  resources are missing, duplicated, or drifting. Inspect the reviewed
  Terraform plan and do not add tags or resources by hand. Stop if the state is
  uncertain.
- `not ready` for the Instance Connect Endpoint: wait for the reviewed
  deployment to finish and retry.
- `did not pass verification`: recreate and verify the CA archive with
  `./scripts/package_rds_ca_layer.sh`; never use a failed or missing checksum.
- `missing the expected username or password` or `not the reviewed secret
  container`: use the reviewed out-of-band loader and confirm the secret ARN
  reference. Do not print the secret to diagnose it.
- `verify-full` or certificate-hostname failure: use the CA path and RDS
  endpoint exactly as printed by `info`. Never disable verification.
- `Address already in use`: choose another unprivileged local port with
  `GOOTIP_DB_LOCAL_PORT`, update DBeaver, and leave the remote ports fixed.
- `Permission denied` or an Instance Connect timeout: confirm the host is
  running, the endpoint is ready, and the reviewed security-group references
  are intact. Use CloudTrail for the session APIs; SSM is deliberately absent.
- `stop` cannot find the host: confirm the SPEC 05.2 application plan has been
  applied and inspect the tag/state drift. Do not create a replacement host or
  change tags manually.

## IAM policy guardrails (SPEC 02.3)

`scripts/check_iam_policy_guardrails.py` renders every Gootip customer managed
policy through `scripts/iam_policy_evaluator.py` in an isolated root with
stubbed credentials and a local backend, then fails when:

- a policy exceeds 5,500 non-whitespace characters (4,500 is the healthy
  warning budget, 6,144 is the AWS limit);
- a role exceeds eight managed-policy attachments (ten is a failure);
- a policy is declared inline, or any wildcard action, resource, or principal
  lacks a reviewed justification in `REVIEWED_WILDCARDS`.

### Verification cycles (SPEC 03.2)

After every edit, run the fast, plan-free cycle:

```bash
./scripts/verify_fast.sh
```

It runs `terraform fmt -check -recursive`, both `terraform validate`
invocations, and only the pure Python tests selected from the command with
`pytest -k`. It materializes no Terraform plan and makes no AWS call. Each root
is initialized with `terraform init -backend=false` only when it is not already
initialized, and the provider is reused from `$TF_PLUGIN_CACHE_DIR` (default
`~/.terraform.d/plugin-cache`, created on demand by the evaluator).

Before review or merge, run the full offline cycle:

```bash
./scripts/verify_full.sh
```

It runs the fast cycle, then the full driver renders the six unique
configurations once: five bootstrap variants in one isolated root and the
application variant in another. This requires two `terraform init` runs; the
separate plans are shared by the checker, comparator, and endpoint and Lambda
policy tests. The materializer's cleanup test uses mocks and runs in the fast
cycle without starting Terraform.
The full cycle is offline, makes no AWS calls, and needs no AWS credentials. Neither script
pipes through `tail`, `sed`, or any pipeline that hides an exit code: both stop
at the first error and stream its real output.

### Live-AWS gate (separate, mandatory before relevant IAM plans or applies)

The offline cycles never call AWS. These two commands do; they are not run by
`scripts/verify_full.sh`, and they are not assumed to use the same profile:

```bash
# Run from the bootstrap MFA session that corresponds to the bootstrap role.
terraform -chdir=bootstrap test

# Needs a principal explicitly authorized for access-analyzer:ValidatePolicy.
python3 scripts/validate_policies.py --profile <PROFILE>
```

`gootip-bootstrap-admin` does not hold `access-analyzer:ValidatePolicy` in the
standing configuration, so it is not presented as the profile for
`validate_policies.py`.

`bootstrap/scripts/compare_bootstrap_policy_split.py` complements the checker: it
proves the SPEC 03.1 split preserves each role's effective permissions by
comparing the union of normalized statements against the versioned pre-split
baseline fixture at `bootstrap/tests/fixtures/03.1-presplit-role-unions.json`. The
fixture is sanitized: its `account_id` must equal the evaluator's
`FIXTURE_ACCOUNT_ID`, so a real Account ID can never enter it.

The checker evaluates the bootstrap and application roots plus a third
`bootstrap-diagnostics` render. That render carries the SPEC 02.3 read-only
policy and role inventory, which is gated by `diagnostics_inventory_enabled`
(default `false`), so the SPEC 03.1 capacity split never renders it while its
size and wildcard review keep running under SPEC 02.3's own scope.

Neither the checker nor the comparator reads canonical state or makes an AWS
request. The full driver shares the same six fresh plans between both checks and
the application maximum policy assertions; no plan cache persists between runs.

It also gates the two maximum renders against both ceilings without any apply:
`BOOTSTRAP_TRANSITION` (the SPEC 03.1 temporary grant, checked for size and for
its exact two SIDs) and `BOOTSTRAP_ROLE_SECRET_MAXIMUM` (the SPEC 03 role-secret
ARN handoff, which grows the core and the application runtime boundary to their
largest approved shape).

`scripts/validate_policies.py` is the Access Analyzer half. It renders every
configuration first, calls `ValidatePolicy` only — never `ListAnalyzers`, so no
analyzer needs to exist in the account — follows every finding `nextToken` to
exhaustion instead of trusting the first page, and exits non-zero on an `ERROR`
or `SECURITY_WARNING`:

```bash
python3 scripts/validate_policies.py --profile <PROFILE>
```

`<PROFILE>` must be a principal that explicitly holds
`access-analyzer:ValidatePolicy` in `us-east-2`. In the standing configuration
`gootip-bootstrap-admin` does not hold it. SPEC 02.3 supplies the permission
through an explicit D1/D2 window rather than a standing grant: a separately
approved D1 apply sets `diagnostics_inventory_enabled` to `true` and adds exactly
three read-only statements, validation runs inside that window from an authorized
principal, and a separately approved D2 apply returns it to the default `false`.
After D2 the normal and `-refresh=false` plans must both report no changes.

`scripts/compare_iam_inventory.py` first renders a refresh-free plan for each
Terraform root and rejects pending IAM policy, role, or attachment changes.
It never applies a plan; temporary plans are deleted on success and failure.
It then pulls canonical state from both roots, compares each present managed policy's
default version semantically, and compares each Gootip role's live managed-policy
attachments (including AWS-managed policies) with attachments in state. Use an
explicit profile that can plan both roots and read their policy versions and role attachments;
its report omits ARNs, account IDs, and policy documents:

```bash
python3 scripts/compare_iam_inventory.py --profile <READ_ONLY_PROFILE> \
  --application-var-file=/path/to/effective-application.tfvars.json \
  --bootstrap-var-file=environments/dev.tfvars \
  --bootstrap-var-file=current-bootstrap.local.tfvars
```

Use the same effective variable files as the deployed configuration. Paths are
relative to their Terraform root. Repeat `--application-var-file` or
`--bootstrap-var-file` in precedence order; each root defaults to
`environments/dev.tfvars` when no files are supplied for it. Refresh-free plans
can still read data sources and acquire the normal backend lock. Unrelated
non-IAM changes are not applied and do not fail this IAM-only check.

## Dev observability and notifications (SPEC 06)

### SPEC 07.1 consumer inventory — Phase A

Classification is based on `environments/dev.tfvars`, the current Terraform
resource addresses, and the dated dev deployment evidence below. Function and
role ARNs are bound from the validated dev account (`123456789012`), Region
(`us-east-2`), and Terraform physical names; they identify unqualified
functions. This is an inventory, not a claim that disabled resources have been
deployed or that Phase B authorization/network checks have passed.

| Consumer | State | Terraform function / physical name / unqualified ARN | Execution role / boundary | Log group / client security group |
| --- | --- | --- | --- | --- |
| Auth API | Defined, disabled (`application_runtime_deployment_enabled = false`) | `aws_lambda_function.gootip_auth[0]` / `gootip-auth-dev` / `arn:aws:lambda:us-east-2:123456789012:function:gootip-auth-dev` | `aws_iam_role.lambda[0]` / `arn:aws:iam::123456789012:role/gootip/application/gootip-auth-dev-lambda` / boundary `arn:aws:iam::123456789012:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary` | `/aws/lambda/gootip-auth-dev` / `gootip-dev-application-client` |
| Administration | Deployed (`db_config_deployment_enabled = true`) | `aws_lambda_function.gootip_db_config[0]` / `lambda_db_config` / `arn:aws:lambda:us-east-2:123456789012:function:lambda_db_config` | `aws_iam_role.db_config[0]` / `arn:aws:iam::123456789012:role/gootip/administrative/gootip-db-config-dev-lambda` / boundary `arn:aws:iam::123456789012:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary` | `/aws/lambda/lambda_db_config` / `gootip-dev-db-config` |
| Auth migrations | Deployed (`auth_migrations_deployment_enabled = true`) | `aws_lambda_function.auth_migrations[0]` / `gootip-dev-auth-migrations` / `arn:aws:lambda:us-east-2:123456789012:function:gootip-dev-auth-migrations` | `aws_iam_role.auth_migrations[0]` / `arn:aws:iam::123456789012:role/gootip/application/gootip-dev-auth-migrations-lambda` / boundary `arn:aws:iam::123456789012:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary` | `/aws/lambda/gootip-dev-auth-migrations` / `gootip-dev-auth-migrations` |
| Core migrations | Deployed (`core_migrations_deployment_enabled = true`) | `aws_lambda_function.core_migrations[0]` / `gootip-dev-core-migrations` / `arn:aws:lambda:us-east-2:123456789012:function:gootip-dev-core-migrations` | `aws_iam_role.core_migrations[0]` / `arn:aws:iam::123456789012:role/gootip/application/gootip-dev-core-migrations-lambda` / boundary `arn:aws:iam::123456789012:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary` | `/aws/lambda/gootip-dev-core-migrations` / `gootip-dev-core-migrations` |
| Core API | Future-only; no Terraform runtime resource | Source contract: `CORE_RUNTIME_SECRET_ARN`, `secretsmanager:GetSecretValue`, username `core_runtime`; no physical function name or function ARN is assigned | Future deployment spec must bind the role and boundary | Future deployment spec must bind log group and client security group |

The existing deployed-resource classification is corroborated by the dated
SPEC 09 dev inventory (three deployed functions; neither API deployed) and the
Core migration acceptance record at
`../gootip-core/audit/dev-core-migrations-20261030.json`. SPEC 14 supplies the
administrative contract and confirms the Core migration handoff. Core API
source behavior is taken from `../gootip-core/src/config/database/runtime-credential.ts`;
its runtime secret and `core_runtime` username do not imply an API resource.
No future Core API ARN, role, log group, security group, attachment, or endpoint
principal is invented here. Auth's disabled configuration remains an offline
policy/fixture target; it is not a live API verification.

Managed log-group and client-group Terraform bindings are respectively
`aws_cloudwatch_log_group.{gootip_auth,db_config,auth_migrations,core_migrations}`
and `aws_security_group.{application_client,db_config,auth_migrations,core_migrations}`.
Their stable log-group ARNs are
`arn:aws:logs:us-east-2:123456789012:log-group:/aws/lambda/<physical-name>`;
append `:*` only for stream resources. Core API's ARN and those future
infrastructure identities remain unbound by design.

### SPEC 07.1 policy and call inventory — Phase A

**Current effective dev configuration.** The deployed roles use the shared
`GootipApplicationRuntimeBoundary` ARN above. The admin role and both migration
roles also attach the AWS-managed `AWSLambdaBasicExecutionRole` and
`AWSLambdaVPCAccessExecutionRole`; each has a separate exact-secret managed
policy in `iam.tf`. Auth has those same configured attachment/resource
addresses behind its disabled flag. The boundary currently permits the five
Lambda VPC-interface actions in `us-east-2`, and limits log writes to the
managed function log groups; it is an upper bound, not a substitute for each
role's identity policy. No endpoint policy is currently configured on
`aws_vpc_endpoint.secretsmanager`.

| Consumer | Effective secret references / source call | Current identity secret policy | Current invocation path |
| --- | --- | --- | --- |
| Auth API (disabled) | `SECRET_ARN` (unset in canonical dev inputs; must be an explicit fixture/approved override) at `AWSCURRENT` and optional `AWSPREVIOUS`; `DB_RUNTIME_SECRET_ARN` = `gootip-dev-auth-runtime-Ab1Cd2` at `AWSCURRENT`. `gootip-auth/src/lambda.ts` calls only `secretsmanager:GetSecretValue`. | `aws_iam_policy.secrets_read[0]` allows GetSecretValue on app + Auth runtime ARNs when enabled; boundary separately caps secret access. | Disabled API Gateway permission `aws_lambda_permission.api`; no application role invoke grant. |
| Administration | `DB_MASTER_SECRET_ARN` (RDS-managed master), `AUTH_RUNTIME_SECRET_ARN`, `AUTH_MIGRATOR_SECRET_ARN`, `CORE_RUNTIME_SECRET_ARN`, `CORE_MIGRATOR_SECRET_ARN`, `DB_OPERATOR_SECRET_ARN`, all set in dev inputs. `gootip-db-config/src/gootip_db_config/credentials.py` makes `GetSecretValue` calls only. | `aws_iam_policy.db_config_secrets_read[0]`, six exact ARNs in `iam.tf`; keep only secrets required by the currently enabled fixed bootstrap operation when reconciling. | Exact `lambda:InvokeFunction` is in bootstrap deployment policy for `lambda_db_config`; no Lambda resource-policy grant. |
| Auth migrations | `MIGRATION_CREDENTIAL_SECRET_ARN` = `gootip-dev-auth-migrator-Ab1Cd2`; `gootip-auth/src/migration-runner/credentials.ts` calls GetSecretValue. | `aws_iam_policy.auth_migrations_secrets_read[0]`, one exact ARN. | Bootstrap deployment policy permits only the reviewed `deployment` alias. The `baseline` alias is intentionally excluded from deployment-principal invocation by SPEC 04; application principals receive no invoke grant. |
| Core migrations | `MIGRATION_CREDENTIAL_SECRET_ARN` = `gootip-dev-core-migrator-Ab1Cd2`; `gootip-core/src/migration-runner/credentials.ts` calls GetSecretValue. | `aws_iam_policy.core_migrations_secrets_read[0]`, one exact ARN. | Bootstrap deployment policy permits only the reviewed `deployment` alias; application principals receive no invoke grant. |
| Core API (future-only) | `CORE_RUNTIME_SECRET_ARN` = `gootip-dev-core-runtime-Ab1Cd2`, `AWSCURRENT`; source call in `gootip-core/src/config/database/runtime-credential.ts`. | No role/policy/endpoint principal exists. Future deployment spec must bind exact identities. | No function or invocation principal exists. |

Secret values are never part of this inventory. Auth's loader explicitly sends
`VersionStage: AWSCURRENT` for the required application and runtime reads, then
`AWSPREVIOUS` for the optional application-secret read. It tolerates only a
missing previous version (`ResourceNotFoundException`); access denial is an
error. Core runtime explicitly requests `AWSCURRENT`; both migration executors
and the admin use an unqualified `GetSecretValue` request, which resolves the
current version. Auth app-secret ARN is intentionally not fabricated because
the dev tfvars leave it unset.

The reachable application AWS API surface is Secrets Manager `GetSecretValue`
only. PostgreSQL client operations are network/database traffic, not AWS API
permissions. Lambda service VPC setup separately requires
`ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`,
`ec2:DescribeSubnets`, `ec2:DeleteNetworkInterface`,
`ec2:AssignPrivateIpAddresses`, and `ec2:UnassignPrivateIpAddresses`. Native logging requires
`logs:CreateLogStream` and `logs:PutLogEvents` against the corresponding
managed log group stream ARN; no function code needs `logs:CreateLogGroup`.

**Replacement policy and attachment contract.** Use independent managed
policies named `<physical-function-name>-logs` and
`<physical-function-name>-vpc`, each attached only to that function's role:

| Role / Terraform binding | Replacement policy ARN suffixes | Attachment pairs |
| --- | --- | --- |
| Auth `aws_iam_role.lambda[0]` | `policy/gootip-auth-dev-logs`, `policy/gootip-auth-dev-vpc` | `lambda_logs["auth"]`, `lambda_vpc_scoped["auth"]` |
| Admin `aws_iam_role.db_config[0]` | `policy/lambda_db_config-logs`, `policy/lambda_db_config-vpc` | `lambda_logs["db_config"]`, `lambda_vpc_scoped["db_config"]` |
| Auth migrations `aws_iam_role.auth_migrations[0]` | `policy/gootip-dev-auth-migrations-logs`, `policy/gootip-dev-auth-migrations-vpc` | `lambda_logs["auth_migrations"]`, `lambda_vpc_scoped["auth_migrations"]` |
| Core migrations `aws_iam_role.core_migrations[0]` | `policy/gootip-dev-core-migrations-logs`, `policy/gootip-dev-core-migrations-vpc` | `lambda_logs["core_migrations"]`, `lambda_vpc_scoped["core_migrations"]` |

The `-logs` documents contain only the two stream-write actions and their
single corresponding log-group stream ARN. Each `-vpc` document contains only
the six Lambda interface actions in the configured Region (wildcard resource
is required for these EC2 actions) and a separate conditional Deny for the
code-originated actions under that role's exact unqualified function ARN.
Keep the boundary's wildcard EC2 Allow/Region ceiling intact; it is owned by
SPEC 02.1 and may not be broadened here. Lambda resources now depend on both
replacement attachments. Step 4 installed the replacements for the three
deployed functions. The AWS-managed basic/VPC attachments remain attached until
replacement permissions and behavior are verified; their separate saved
withdrawal plan is documented below and must not be applied while evidence is
incomplete.

**Step 4 offline policy evidence.** Offline coverage renders all four function
policies, including the
defined-but-disabled Auth function. It checks exact stream resources, all six
regional ENI actions, each function's unqualified `lambda:SourceFunctionArn`,
present/absent context behavior, exact role bindings, and retention of legacy
attachments during the transition. These tests are offline policy evidence, not
live IAM simulation. The current configuration removes those attachment
resources only to render the reviewed withdrawal plan; AWS attachments remain
until that plan is explicitly applied.

Read-only service-interface evidence collected 2026-10-30 in `us-east-2`:

- The three deployed functions (`lambda_db_config`, Auth migrations, and Core
  migrations) reported `Active` and `LastUpdateStatus=Successful`, each with
  the two configured private subnets and its distinct client security group.
- `DescribeNetworkInterfaces` found six Lambda ENIs, all `in-use`, with the
  expected function descriptions and client groups across those subnets.
- CloudTrail lookup found successful `CreateNetworkInterface` events under the
  exact db-config, Auth-migrations, and Core-migrations execution roles. The
  events predate installation of these replacement policies; they establish
  existing Lambda service-interface use, not post-transition authorization.
  No function was invoked or updated for this evidence.

Remaining focused policy checks for later steps:

- Allow Auth `SECRET_ARN` at `AWSCURRENT` and `AWSPREVIOUS`, Auth runtime at
  `AWSCURRENT`, and Core runtime at `AWSCURRENT`; distinguish missing Auth
  previous version from denied access.
- Deny each API principal the other service's secret and all master, operator,
  and migration secrets; deny secret writes for runtime and migration roles.
- Allow each migration role only its own migrator secret; constrain admin reads
  to the currently enabled fixed operation's exact secret set.
- Evaluate endpoint principal/action/resource pairs as intersections with the
  identity policies, including allowed exact secrets and denied cross-consumer
  secrets/writes. Keep the operator and migration alias invocation grants
  exact; reject application-role invocation of admin and migration functions.

Offline policy evaluation is not live IAM simulation or a network test. The
focused Step 4 saved plan was
`artifacts/plans/spec07.1-step4-replacement-policy-install-20261030.tfplan`
(SHA-256 `7b5a3dc1152c832d56305638b14230818d0a0e38f0cfaa9b41348728216157de`).
It proposed exactly 12 creates: six replacement policies and six attachments
for the three deployed functions (`db_config`, Auth migrations, Core
migrations), with zero updates or deletes and no Lambda code changes. It was
applied as saved: 12 added, 0 changed, 0 destroyed.

### Step 4 AWS policy inspection — 2026-10-30

This section is a historical snapshot before `ec2:DescribeSubnets` was added,
before the Core boundary log opt-in was restored in local inputs, and before
Admin's approved transition. Current versions and final simulation evidence are
recorded under the Admin transition below.

IAM `GetPolicy`/`GetPolicyVersion` returned all six replacement policies at
default version `v1`, with one attachment each. Their live documents contain
only the two log-stream write actions scoped to the matching group, or the five
EC2 Lambda VPC interface actions with the configured Region condition and the
unqualified function-source conditional Deny. `ListAttachedRolePolicies`
confirmed the matching log/VPC policy pair on each role and that
`AWSLambdaBasicExecutionRole` plus `AWSLambdaVPCAccessExecutionRole` remain
attached to all three roles. No broad attachment has been removed.

AWS IAM policy simulation (not a function/API invocation) evaluated the five
VPC actions as allowed for all three roles with `aws:RequestedRegion=us-east-2`
and no `lambda:SourceFunctionArn`; the replacement VPC policy and the broad
AWS VPC policy both matched. With each function's exact `lambda:SourceFunctionArn`,
all five actions returned `explicitDeny`, matched the replacement policy, and
did not match the AWS VPC policy. This verifies the role-policy decision for
those supplied contexts, not Lambda's ENI lifecycle.

Log simulation using the policy's `...:log-group:<group>:*` resource returned
`allowed` for `db_config` and Auth migrations and `implicitDeny` for another
group. Core migrations returned `implicitDeny` for its own group: the attached
runtime boundary is still version `v6`, and its
`AllowOnlyApprovedRuntimeLogStreams` resource list omits
`/aws/lambda/gootip-dev-core-migrations`. Thus the Core log replacement is
attached but is not an effective allow through the boundary; the basic AWS
policy cannot override that boundary.

### Approved Core boundary correction — 2026-10-30

The missing Core log ARN is an implementation-phase omission, not a new IAM
ceiling expansion. SPEC 02.1 makes the bootstrap-owned runtime boundary the
ceiling and assigns its changes to bootstrap. SPEC 14 authorizes the
administrative function's exact Core secret reads but does not authorize the
migration runner. Core SPEC 06 separately requires the runner's dedicated role
to read only its exact migrator secret and write only its managed logs, and
explicitly calls for an infrastructure boundary review. The existing
`core_migrations_log_access_enabled` opt-in implements that separate SPEC 06
capability by adding only the Core runner log-group ARN; its default remains
false. The focused IAM test file already asserts both the disabled default and
the exact opt-in ARN; no broader permission or new code path was needed.

With `AWS_PROFILE=gootip-bootstrap-admin` and the account ID checked against
STS, `terraform -chdir=bootstrap test -filter=tests/iam.tftest.hcl` passed all
25 tests. The saved plan
`bootstrap/artifacts/plans/spec06-core-log-boundary-20261030.tfplan` (SHA-256
`3d9746ef46a3a39d59e8708e52eafd6ac890ad1e434eafa927f5ace7244b3e55`). Its JSON
was checked: exactly one in-place update to
`aws_iam_policy.application_runtime_boundary`, adding only
`arn:aws:logs:us-east-2:<account>:log-group:/aws/lambda/gootip-dev-core-migrations:*`;
zero creates or destroys. After rechecking the SHA-256 and exact plan diff, it
was applied as saved: 0 added, 1 changed, 0 destroyed. IAM now reports default
boundary version `v7`; comparison with `v6` confirms the only policy change is
that exact Core log-group ARN in `AllowOnlyApprovedRuntimeLogStreams`. No
bootstrap administrative function was executed.

There is a second log-evaluation limit: simulation of Auth's concrete existing
`log-stream` ARN returned `implicitDeny`, although the same AWS simulator
returned `allowed` for the corresponding group ARN ending `:*`. AWS's
[CloudWatch Logs IAM guide](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/iam-identity-based-access-control-cwl.html)
documents that suffix as granting access to all streams. Treat the concrete
stream result as unresolved simulator/effective-permission evidence; no log
write was attempted. The log permissions are therefore not fully verified for
retirement.

The exact inputs were re-read from CloudWatch Logs: the group ARN ended in
`log-group:/aws/lambda/gootip-dev-auth-migrations:*`; the existing stream ARN
was `log-group:/aws/lambda/gootip-dev-auth-migrations:log-stream:2026/10/28/[3]28df709660ba468bbd30704cac2a176b`.
The reproduction used AWS IAM `SimulatePrincipalPolicy` through
`aws iam simulate-principal-policy`, against the actual Auth role, its attached
policies, and boundary v7. Inputs were `logs:CreateLogStream` and
`logs:PutLogEvents`, the resource ARN separately set to the actual stream or
the CloudWatch group ARN, and context `aws:RequestedRegion=us-east-2` plus the
exact Auth `lambda:SourceFunctionArn`. The group ARN was `allowed` for both
actions (the broad AWS managed and replacement policies matched); the actual
stream ARN was `implicitDeny` for both, with no matched statements and no
boundary decision detail.

A minimal AWS IAM `SimulateCustomPolicy` reproduction used the live replacement
policy's resource pattern with `logs:PutLogEvents` and the exact actual stream
ARN. It returned
`implicitDeny`, both with the deployed `...:log-group:/aws/lambda/...:*`
resource pattern and with the policy resource set to that exact stream ARN.
The same exact-stream policy and action returned `allowed` for a synthetic log
group name without a leading slash, using the same region, account, stream-name
shape and context values. This makes an IAM Simulator matching discrepancy
for slash-prefixed group names a plausible hypothesis, not an established
cause; it does not prove whether the service would authorize a real request.
AWS's [CloudWatch Logs IAM guide](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/iam-identity-based-access-control-cwl.html)
documents `log-group:<name>:*` as matching all streams and documents the
specific `log-stream:<name>` ARN form. The simulator discrepancy is therefore
still unresolved. No log write was attempted, and neither group-level nor
synthetic simulation validates access to the concrete stream.

After the boundary update, `SimulatePrincipalPolicy` for the Core role and its
exact group ARN returns `allowed` for both write actions with boundary v7
allowing them; AWS has not yet returned a Core stream ARN from
`DescribeLogStreams`. This verifies only the simulator's group-level result,
not access to a real Core stream or a log write.

### Step 4 dependency and ENI lifecycle boundary

The transition configuration initially made each deployed Lambda depend on its
new log/VPC attachments and the AWS-managed basic/VPC attachments. The staged
Core-only configuration removes just the Core migration attachment resources
and dependency references. Its saved two-detach plan was applied under the
explicitly approved Core-only exception; Admin and Auth migrations retain both
broad policies and dependency edges.

On 2026-10-30, after the replacement policies were installed, read-only EC2
inventory found two Lambda ENIs per enabled function (Admin, Auth migrations,
Core migrations); all six were `in-use` and attached. No
`CreateNetworkInterface`, `AssignPrivateIpAddresses`,
`UnassignPrivateIpAddresses`, or `DeleteNetworkInterface` events were found in
the post-install probe window. This confirms existing ENI use only, not a
complete create/assign/unassign/delete lifecycle under the replacement policy.
No configuration, scale, or ENI changes were made to force such a cycle.

The concrete log-stream simulator discrepancy documented above remains
unresolved as simulator evidence. The post-detachment Core validation below
confirmed native log records persisted in its CloudWatch group under the scoped
replacement policy. This does not establish replacement-only ENI lifecycle
authorization. Offline tests, group-level simulation, and existing ENI inventory
are not evidence of a complete create/assign/unassign/delete cycle.

Offline policy tests, AWS policy inspection/simulation, and live service
lifecycle verification are separate evidence classes. The first two do not
establish that Lambda can complete its ENI lifecycle under the replacement
policies.

Steps 5–6 endpoint and network evidence is recorded below. Step 7's secret
retrieval, verified PostgreSQL TLS, and native log delivery are now evidenced
for the two read-only migration validations below. Replacement-only permission
sufficiency and a complete ENI lifecycle remain unproven.

### SPEC 07.1 steps 5–7 — policy and network evidence, 2026-10-30

**Secret identities and invocation.** At the initial read-only inventory,
before the later Core-only transition, all three enabled execution roles had
both AWS-managed execution policies attached. Their customer-managed secret
policies are exact:

| Enabled role | Allowed action and secret set |
| --- | --- |
| `gootip-db-config-dev-lambda` | `secretsmanager:GetSecretValue` on exactly the RDS master, Auth runtime, Auth migrator, Core runtime, Core migrator, and database-operator secret containers. The fixed administrative reconciliation reads all six. |
| `gootip-dev-auth-migrations-lambda` | `secretsmanager:GetSecretValue` on only `gootip-dev-auth-migrator`. |
| `gootip-dev-core-migrations-lambda` | `secretsmanager:GetSecretValue` on only `gootip-dev-core-migrator`. |

The disabled Auth runtime's configured identity policy remains limited to the
application and Auth-runtime secrets; its Auth tests already passed for
`AWSCURRENT`, `AWSPREVIOUS`, and optional missing-previous behavior (18/18).
No secret value was read or emitted for this inventory. The exact Auth and Core
migration deployment grants allow only their respective `:deployment` aliases.
The temporary `lambda_db_config` invocation flag is false, and the live
deployment base/db-config policies contain no `lambda:InvokeFunction` grant.
No application role has an invocation grant. No function was invoked during
that initial inventory.

**Endpoint policy.** The available Secrets Manager interface endpoint now has a
custom policy containing only `secretsmanager:GetSecretValue` for three active
role principals: administration on its six exact operation secrets, Auth
migrations on its one migrator secret, and Core migrations on its one migrator
secret. No wildcard principal, action, resource, or future Core API principal
is present. The disabled Auth runtime is not an active endpoint principal; its
endpoint-policy grant must be included in the reviewed SPEC 10 activation plan
before the API is enabled. These endpoint permissions intersect with (and do not
replace) the exact identity policies.

**Network.** Read-only EC2 inspection after apply confirmed:

- Each client group (reserved application client, enabled administration, Auth
  migrations, and Core migrations) can egress only TCP 5432 to the RDS security
  group and TCP 443 to the endpoint security group. No CIDR egress remains.
- RDS ingress is TCP 5432 from those four client groups and the reviewed private
  database-tunnel group only. Endpoint ingress is TCP 443 from the four client
  groups only; both destination groups have no egress.
- The tunnel-to-RDS path remains present. Existing Core migration egress rules
  were reused rather than recreated.
- The endpoint is `available`, private DNS is enabled, and its selected subnet
  is in `us-east-2a`. The accepted single-AZ development topology has no
  second-AZ endpoint failover and can incur cross-AZ transfer cost for clients
  in the other AZ; adding another endpoint is outside scope.

The bootstrap deployment network policy was updated in place by the saved plan
`bootstrap/artifacts/plans/spec07.1-step6-exact-vpce-capability-reviewed-20261030.tfplan`
(SHA-256 `b2df652205df84a656d697124e44aa304c362c43a6755eeb17f9801728a3173a`).
It added only `ec2:ModifyVpcEndpoint` for the exact endpoint ARN under
`aws:RequestedRegion = us-east-2`; IAM reports policy version `v15`. Apply
result: 0 added, 1 changed, 0 destroyed. The earlier candidate plan that would
have removed the existing Core log boundary ARN was not applied; the reviewed
plan preserved that ARN.

To keep the rendered policy below the repository's 5,500-character failure
guardrail, `ec2:DescribeAvailabilityZones` was folded into the existing
Region-scoped network-discovery statement. Its action, wildcard resource, and
`aws:RequestedRegion` condition are unchanged; the offline role-union comparator
records and verifies this exact statement merge. The resulting policy size is
5,489 characters. The saved reconciliation plan
`bootstrap/artifacts/plans/spec07.1-step6-network-policy-size-reconcile-20261030.tfplan`
contained only one in-place update of `GootipTerraformDeployNetworkPermissions`
(0 added, 1 changed, 0 destroyed): it preserved the exact endpoint grant and
made no effective permission expansion. That reviewed plan was applied.

The application saved plan
`artifacts/plans/spec07.1-step5-6-network-endpoint-20261030.tfplan` initially
proposed 16 creates, 6 in-place updates, and no deletes. Its apply installed the
endpoint policy and the applicable SG rules, then reported duplicate-rule errors
for Core egress that was already managed by existing standalone resources. The
configuration was corrected to reuse those rules. The existing private tunnel
ingress rule was imported into the standalone rule resource without changing
AWS. The reviewed import plan
`artifacts/plans/spec07.1-step6-network-import-operator-rule-reviewed-20261030.tfplan`
(SHA-256 `4dcdadc1fc01bb1273621857d4ff8c0d7687ff0676a10fb386fa52b81e353e8a`)
performed 1 import, 0 adds/changes/destroys. A fresh read-only Terraform plan,
`artifacts/plans/spec07.1-step6-network-final-reconcile-20261030.tfplan`,
reported no changes. The initial failed apply plan is retained as history and
must not be applied again. The final AWS SG and endpoint observations above
were read-only; there was no secret retrieval, database connection, Lambda
invocation, log write, or ENI lifecycle probe.

**Phase B status at this checkpoint.** The two migration `validate` probes and
their evidence are recorded below. The concrete log-stream simulator
discrepancy and replacement-only ENI lifecycle evidence remained unresolved.
The Core-only transition and its post-detachment validation are recorded in the
later section; Admin and Auth migrations still retain their broad attachments.

### SPEC 07.1 read-only validation evidence — 2026-10-30

Auth migrations `deployment` version 3 and Core migrations `deployment`
version 2 were each invoked once with `operation=validate`. Before invocation,
their deployed `CodeSha256` values were matched against the local ZIPs and the
aliases were confirmed to target those versions. These `validate` operations
read migration history and validate identity; neither applies migration SQL.
Both returned HTTP 200, Lambda `FunctionError` was absent, status was
`succeeded`, and `pending=0` (Auth history count 2; Core history count 3).
No administrative Lambda was invoked.

Each run successfully loaded its allowlisted migrator secret inside Lambda and
connected to the private PostgreSQL 18.6 RDS instance using the configured
`verify-full` TLS mode. Secret values were never emitted or persisted. The
database reported `available`, `rds.force_ssl=1`, and parameter-group status
`in-sync`. Auth emitted its bounded, sanitized `auth_migration` report;
CloudWatch Logs contained the Auth report and native `START`/`END`/`REPORT`
records for both invocations. The deployment role lacks
`logs:DescribeLogStreams`; persistence was confirmed read-only with the existing
`gootip-dev` profile, without changing IAM.

These initial checks established successful secret retrieval, TLS database
connectivity, read-only validation, and log delivery while both AWS-managed
policies were attached. They did **not** establish replacement-only sufficiency.
The post-detachment Core evidence and continuing ENI limitation follow below.

### Broad-policy withdrawal plan and rollback

The saved plan
`artifacts/plans/spec07.1-step4-broad-attachment-withdrawal-20261030.tfplan`
contains exactly six deletes: the `AWSLambdaBasicExecutionRole` and
`AWSLambdaVPCAccessExecutionRole` attachments for Admin, Auth migrations, and
Core migrations. It contains zero creates and zero updates. The plan has not
been applied; read-only IAM inspection confirmed both policies are still
attached to all three roles. Do not apply it until replacement log access and
the required ENI behavior have been independently demonstrated without relying
on the broad grants. Successful probes above occurred during overlap and are
not sufficient authorization evidence.

Rollback if a future authorized withdrawal causes a failure: restore the six
`aws_iam_role_policy_attachment` blocks in `iam.tf` and their matching
`depends_on` entries in `lambda.tf` from the pre-withdrawal revision; run
`terraform fmt` and focused tests; create a **new** saved plan under
`artifacts/plans/` and review that it contains exactly six re-attachments and no
other changes before applying that reviewed filename. Do not reuse or edit the
withdrawal plan for rollback. Preserve functions, networking, secrets, state,
and database data throughout.

### Proposed single-role transition — Core migrations

The evidence below records the state at the time of the Core transition, before
the approved SPEC 07.1 amendment and six-action correction. Its earlier lifecycle
blocker language is superseded by the final permission verification recorded
under Admin below; no complete ENI lifecycle was observed.

This staged transition supersedes the six-detach plan above; that older plan is
historical and must not be applied. Only Core migrations was selected. The
Terraform configuration removes only its two AWS-managed attachment resources
and matching `depends_on` entries. Admin and Auth migrations retain both broad
attachments and their dependency edges.

Read-only inventory of
`arn:aws:iam::123456789012:role/gootip/application/gootip-dev-core-migrations-lambda`
found the three scoped attachments (`...-secrets-read`, `...-logs`, and
`...-vpc`) plus `AWSLambdaBasicExecutionRole` and
`AWSLambdaVPCAccessExecutionRole`. The live replacement documents are v1: the
Logs policy allows only `CreateLogStream`/`PutLogEvents` on the Core group's
streams; the VPC policy allows the five Lambda ENI interface actions in
`us-east-2` and explicitly denies those actions when
`lambda:SourceFunctionArn` is the unqualified Core function ARN. The live
permissions boundary is v7: it includes the exact Core log-group stream ARN and
allows those five ENI actions in the configured Region. The secret policy is
limited to `GetSecretValue` on the exact Core migrator secret. These layers
intersect; the broad policies currently also contribute permissions.

`iam:SimulatePrincipalPolicy` was denied to the deployment identity. Existing
records establish a group-level Core log simulation allow, not actual access to
a concrete Core stream. The prior read-only Core validation did deliver native
logs while broad policies were attached; that is overlap evidence only. Existing
ENIs remain `in-use`; no safe post-install create/assign/unassign/delete cycle
has been observed. Replacement-only runtime sufficiency is therefore not
proven.

A focused plan was saved as
`artifacts/plans/spec07.1-step4-core-migrations-two-policy-withdrawal-20261030.tfplan`.
Its refreshed diff contains exactly two deletes (the Core role's basic and VPC
attachments), zero creates, and zero updates. It was applied as the reviewed
saved plan: 0 added, 0 changed, 2 destroyed. A fresh read-only IAM check after
apply confirmed both broad policies are absent from Core while the three scoped
policies remain attached. At that historical checkpoint Admin and Auth
migrations still had both broad policies attached.

**Historical spec gate and approved exception.** Under the earlier SPEC 07.1
wording, the user authorized only the two Core attachment detaches. That
checkpoint did not close the spec or authorize other roles. The later approved
amendment replaces lifecycle observation with AWS-documented permission
verification and supersedes that earlier blocker.

**Post-transition read-only validation — 2026-10-30.** After apply, Core
`deployment` v2 ran one `operation=validate` invocation. It returned HTTP 200,
no `FunctionError`, `succeeded`, and `pending=0` (history count 3); no migration
SQL was applied. Successful completion confirms that the allowlisted secret
could be resolved in memory and PostgreSQL connected using TLS `verify-full`.
The invocation run ID was
`spec071-core-post-withdrawal-20261030T214845Z` (Lambda request ID
`6f9cd33b-1c6d-44d7-b7a2-7c942fb8c6b4`).
The native `START`/`END`/`REPORT` records were present in the invoke tail and
were subsequently found persisted in the Core CloudWatch group under the
`gootip-dev` read-only profile. No secret value was printed or persisted. No
Auth validation was repeated. This verifies Core secret/database/log behavior
after detachment. It did not observe an ENI lifecycle; the amended criterion is
verified separately by the six-action policy checks below.

**Rollback.** If a future Core regression requires rollback,
restore the Core pair of `aws_iam_role_policy_attachment` blocks in `iam.tf` and
their two `depends_on` entries in `lambda.tf`. Run `terraform fmt` and focused
guardrail tests, then create a fresh saved plan and verify it contains exactly
two attachments and no other changes before applying that reviewed filename. A
rollback plan must be freshly generated against the post-detachment state. Never
reuse the withdrawal plan for rollback. Preserve functions, networking,
secrets, state, and database data.

### Auth migrations transition — 2026-10-30

The following was recorded before the approved SPEC 07.1 amendment and six-action
correction; lifecycle-related blocker language is superseded by the final
permission verification below.

Auth migrations was transitioned separately from Core. The saved plan
`artifacts/plans/spec07.1-step4-auth-migrations-two-policy-withdrawal-20261030.tfplan`
was reviewed after a fresh refresh and contains exactly two deletes:
`auth_migrations_basic[0]` and `auth_migrations_vpc[0]`, both attached to
`gootip-dev-auth-migrations-lambda`; zero creates and zero updates. The user
approved a separate, limited Auth exception; the reviewed saved plan was applied
as saved: 0 added, 0 changed, 2 destroyed. A post-apply read-only IAM check
confirmed the two broad attachments absent and the three scoped attachments
still present. Admin retained both broad policies at that historical checkpoint.

Auth's replacement log/VPC/secret policies remained attached with the boundary.
The concrete-stream Logs simulation discrepancy and lack of an observed ENI
lifecycle were limitations of that historical evidence. The later isolated
policy simulation and amended permission criterion supersede them; no ENI
lifecycle is claimed.

After detachment, Auth `deployment` v3 ran a single read-only
`operation=validate`. It returned HTTP 200, no `FunctionError`, `succeeded`, and
`pending=0` (history count 2); no migration SQL was applied. Successful
completion verifies the allowlisted secret was resolved in memory and the
PostgreSQL connection used TLS `verify-full`. The bounded Auth report and native
`START`/`END`/`REPORT` records were found persisted in CloudWatch under the
existing read-only profile. Run ID:
`spec071-auth-post-withdrawal-20261030T220213Z`; Lambda request ID:
`38b9c87e-58d1-4d25-840f-543ff29ffdbb`. No secret value was emitted or
persisted. This validation did not observe an ENI lifecycle; the revised
documented-permission criterion is verified separately below.

Rollback for an authorized Auth transition: restore the two
`auth_migrations_basic` / `auth_migrations_vpc` attachment blocks in `iam.tf`
and their `depends_on` entries in `lambda.tf`; format and run the focused
guardrail tests; then save a fresh rollback plan and verify exactly two
reattachments and no other changes before applying that reviewed filename.
Never reuse the withdrawal plan for rollback.

### Admin verification possible without invoking the bootstrap

No `lambda_db_config` invocation was made. Read-only inspection confirmed the
function is `Active` with a successful last update, Python 3.13, the private
subnets and its dedicated client security group, and the `/aws/lambda/lambda_db_config`
log group. Only environment-variable **names** were inspected. Its role is
`gootip-db-config-dev-lambda`, bounded by
`GootipApplicationRuntimeBoundary`; before transition its three scoped policies
and both broad AWS-managed attachments were present. The post-transition
read-only attachment check confirms only its three scoped policies remain.
Replacement Logs policy is v1, VPC policy v2, and exact six-secret read policy
v2. Boundary v8 includes the Admin log group, all six configured-Region ENI
actions, and the exact secret ceiling.
The Lambda resource policy lookup returned `ResourceNotFound`, so there is no
function resource policy granting invocation. Terraform source and tests also
keep the fixed secret allowlist and private dependencies explicit.

Without running the function, safe checks include read-only Lambda/role/policy/
boundary/alias metadata, attached-policy and resource-policy inspection, exact
secret-ARN and endpoint-policy review, RDS parameter/TLS configuration and SG
inspection, historical CloudTrail/CloudWatch reads, artifact hash comparison,
and offline unit/guardrail tests. These can establish configuration and
authorization structure, not end-to-end behavior under the Admin execution
role. The Admin handler accepts only `operation=bootstrap`; after event
validation it reads all configured secrets, connects as the master user, and
executes reconciliation in a transaction. There is no read-only/dry-run
operation. An invalid event exits before those steps and cannot prove them.
Therefore do not use `lambda_db_config` as a policy probe. The offline
guardrail tests check the exact per-function Logs ARN, all six regional ENI
actions, the unqualified function-source Deny, and present/absent source-context
behavior. In a new read-only `SimulateCustomPolicy` check, the live Admin Logs
and VPC replacement documents were evaluated together with live boundary v8,
without either broad managed policy in the simulator input. For Admin,
Auth migrations, and Core migrations, all six VPC actions were `allowed` in
`us-east-2` with `lambda:SourceFunctionArn` absent, `explicitDeny` with the exact
unqualified function ARN, and `implicitDeny` in another Region. Logs writes were
`allowed` for each function's group and `implicitDeny` for another group. The
live VPC policies are v2; Logs policies are v1. This verifies simulated policy
decisions for the replacement documents and boundary, not Lambda service
execution, endpoint policy, a concrete log-stream write, secret retrieval, or a
TLS connection.

**AWS-documented action correction — 2026-10-30.** The current AWS
[Lambda VPC permissions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
require six execution-role actions, including `ec2:DescribeSubnets`; the prior
five-action list was incomplete. After restoring the omitted current bootstrap
opt-ins locally, the reviewed bootstrap plan
`bootstrap/artifacts/plans/spec07.1-six-vpc-actions-boundary-reviewed-20261030.tfplan`
changed only `GootipApplicationRuntimeBoundary` to add that action (0 added,
1 changed, 0 destroyed). It preserved Core's log-group boundary grant and the
exact deployment `ec2:ModifyVpcEndpoint` grant. The reviewed application plan
`artifacts/plans/spec07.1-six-vpc-actions-application-20261030.tfplan` changed
only the three deployed VPC replacement policies to add that same action (0
added, 3 changed, 0 destroyed). Both saved plans were applied by filename. The
isolated simulation above then verified the six-action permissions and
conditions; no runtime function was invoked.

The approved SPEC 07.1 amendment accepts structural and isolated simulation
evidence for Admin's policy replacement without invoking its bootstrap. Runtime
secret/TLS/log checks remain residual risk for the next necessary administrative
execution, not closure blockers. ENI lifecycle observation is replaced by
documented-permission verification. AWS caller-side permissions for changing
Lambda VPC configuration are separate; this transition changed IAM attachments
only and did not change any function's VPC configuration.

**Admin transition — 2026-10-30.** The user-approved saved plan
`artifacts/plans/spec07.1-admin-two-policy-withdrawal-20261030.tfplan`
contained exactly two deletes from `gootip-db-config-dev-lambda`:
`AWSLambdaBasicExecutionRole` and `AWSLambdaVPCAccessExecutionRole`; 0 creates,
0 updates. It was applied by that filename: 0 added, 0 changed, 2 destroyed.
Post-apply IAM inspection confirms only `lambda_db_config-logs`,
`lambda_db_config-vpc`, and `gootip-db-config-dev-secrets-read` remain attached.
Auth/Core were not invoked or revalidated.

**Rollback.** If an authorized future Admin regression requires restoration,
restore only the `db_config_basic` and `db_config_vpc` attachment blocks in
`iam.tf` and their two `depends_on` entries in `lambda.tf`. Run format and
focused guardrail checks, create a fresh saved plan against post-detachment
state, and verify it contains exactly those two reattachments and no other
changes before applying that reviewed filename. Never reuse the withdrawal
plan. Preserve the function, networking, boundary, secrets, database, and state.

The application root owns these CloudWatch Logs groups with seven-day
retention:

| Group                                    | Use                      | Status                                                                                                       |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `/aws/lambda/gootip-auth-dev`            | Deferred auth Lambda     | Reserved; SPEC 10 deploys the function                                                                       |
| `/aws/lambda/lambda_db_config`           | Administrative Lambda    | Reserved; created only if SPEC 03 enables the function                                                       |
| `/aws/lambda/gootip-dev-auth-migrations` | Private migration Lambda | Existing group is already in Terraform state; 6,254 stored bytes were observed before adoption and preserved |
| `/aws/apigateway/gootip-dev-auth`        | HTTP API access logs     | Reserved; SPEC 10 attaches access logging                                                                    |

Current alarms use the SNS topic exported as `operational_alarms_topic_arn`:

- Migration Lambda `Errors`: at least one error in one 60-second period.
- RDS `CPUUtilization`: above 80% for two consecutive 300-second periods.
- RDS `DatabaseConnections`: above 56 during one 300-second period. The
  alarm threshold remains 56. Reconcile it against the updated aggregate
  connection budget before either API is activated; do not raise it to permit a
  test.

### Shared RDS connection budget and runtime credential contract (SPEC 09)

**Dated baseline: 2026-10-30, dev, `us-east-2`.** Read-only inventory found
three deployed Lambdas: `lambda_db_config`, `gootip-dev-auth-migrations`, and
`gootip-dev-core-migrations`. Neither API is deployed. Core migrations reserve
concurrency 1 and use pool maximum 1. Auth migrations and administration have no
reserved-concurrency setting, so observed single invocations are not hard
capacity limits. The preceding seven-day CloudWatch observation had a maximum
of three database connections; it does not establish two-API capacity.

The earlier SQL observation was `max_connections = 81`, with 3
`superuser_reserved_connections` and 2 `reserved_connections`. The current RDS
parameter API returns a memory-derived expression, so **81 and the resulting
usable client capacity must be reconfirmed through SQL before live activation**.
No new SQL capacity measurement is claimed here. The existing alarm remains at
56; the first alarm value is 57. The prior SPEC 08 arithmetic is not a two-API
budget and must not be reused as one.

Use this planning inventory; `TBD` means no allocation or verified bound exists,
not zero connections. For each consumer, calculate ordinary use and refresh or
deployment overlap separately, then include retained idle environments and
headroom. Concurrency multiplied by pool size is an estimate, not a global cap.

| Consumer                                                |                   Pool maximum | Configured concurrency |                                      Ordinary estimate |                                                                                Candidate/retiring overlap | Activation / limitation                                                    |
| ------------------------------------------------------- | -----------------------------: | ---------------------: | -----------------------------------------------------: | --------------------------------------------------------------------------------------------------------: | -------------------------------------------------------------------------- |
| Auth API                                                |                              2 |             5 reserved |                                                     10 | Up to 10 additional (two generations at pool maximum 2 across concurrency 5; 20 total during replacement) | Not deployed; SPEC 10 owns activation                                      |
| Core API                                                |                      2 default |    Not allocated (`C`) |                                                `2 * C` |                                    Up to `2 * C` additional; `4 * C` total while both generations coexist | Not deployed; separate deployment spec and concurrency allocation required |
| Auth migrations                                         |    1 connection per invocation |             Unreserved |           Not finitely bounded by reserved concurrency |                                                              None; invocation-scoped connection is closed | Deployed; concurrent invocations remain a planning limitation              |
| Core migrations                                         |                              1 |             1 reserved |                                                      1 |                                                              None; invocation-scoped connection is closed | Deployed                                                                   |
| Administration (`lambda_db_config`)                     |  Per operation, one connection |             Unreserved |           Not finitely bounded by reserved concurrency |                                                               None; operation-scoped connection is closed | Deployed; concurrent invocations remain a planning limitation              |
| Database operator                                       |        Per workstation session |  No Lambda reservation |                             TBD; count active sessions |                                                                                  None for runtime refresh | Private operator access; concurrent sessions must be counted               |
| Other clients                                           |                            N/A |                    N/A |                                                    TBD |                                                                                                       TBD | Inventory before activation                                                |
| Retained idle environments / deployment-version overlap | Existing pools may remain open |       Not a strict cap | Measure; not inferable from reserved concurrency alone |                                           Include old and candidate generations where simultaneously live | Measure connection peaks during bounded live validation                    |

Budget method: obtain SQL-verified `max_connections`,
`superuser_reserved_connections`, and `reserved_connections`; calculate usable
client capacity as the first value minus both reserved values. Sum each
consumer's ordinary estimate, the maximum applicable candidate/retiring and
deployment overlap, retained idle connections, operator/other-client allowances,
and explicit operational headroom. Compare that total to usable capacity and
reconcile the 56 alarm threshold before activation. The SQL values, unknown
unreserved invocation peaks, and Core concurrency allocation are activation
gates; no reservation, connection limit, or alarm change is authorized by this
documentation.

For simultaneous API refresh, let `C` be a separately approved Core reserved
concurrency. The planning estimate is at most 20 Auth connections while both
Auth generations coexist, plus `4 * C` Core connections while both Core
generations coexist (pool maximum 2, two generations). This excludes retained
idle environments, deployments, migrations, administration, operators, other
clients, and headroom; it is not a hard ceiling. Since Core has no concurrency
allocation and Auth migrations/administration are unreserved, there is no
verified aggregate maximum today. Do not interpret the historical SQL
observation (`81 - 3 - 2 = 76` usable client connections) as current capacity;
reconfirm it from SQL before activation. Keep the RDS `DatabaseConnections`
alarm at 56; 57 is the first value above its `GreaterThan` threshold.

The incomplete aggregate expression is `20 + 4 * C + 1` for overlapping Auth,
Core, and the one-reserved Core migration invocation, **plus** concurrent Auth
migrations, administrative operations, operator sessions, other clients,
retained/deployment environments, and headroom. The unreserved Auth migration
and administration consumers have no concurrency ceiling recorded here, so the
expression is not a verified total and must not be used to approve activation.

#### API timing inputs and credential identities

Both API runtimes must validate these non-sensitive inputs at startup. Defaults
are contract values; all operation deadlines must also fit within the remaining
Lambda invocation budget, including after a frozen environment resumes.

| Environment input                        | Default | Validation contract                                |
| ---------------------------------------- | ------: | -------------------------------------------------- |
| `DB_CREDENTIAL_REFRESH_INTERVAL_SECONDS` |     300 | Positive integer                                   |
| `DB_CREDENTIAL_REFRESH_RETRY_SECONDS`    |      30 | Positive integer, less than refresh interval       |
| `DB_CREDENTIAL_MAX_STALE_SECONDS`        |     900 | Positive integer, greater than refresh interval    |
| `DB_CREDENTIAL_DRAIN_TIMEOUT_SECONDS`    |       5 | Positive integer, within remaining invocation time |

Secrets Manager retrieval, candidate TLS connection validation, and SDK retries
also require finite deadlines. AWS API entry points accept only their exact
runtime secret reference and identity: Auth uses `DB_RUNTIME_SECRET_ARN` for
`auth_runtime`; Core uses `CORE_RUNTIME_SECRET_ARN` for `core_runtime`. Auth
alone reads its existing signing secret through `SECRET_ARN`. Neither API may
fall back to environment database credentials or another service's,
migrator, operator, or master credentials. Local HTTP and migration CLI
configuration remains environment-based. Terraform may carry references and
timing inputs only, never credential values. Full ARNs come from the existing
bootstrap handoff and must not be guessed.

### Manual database credential and Auth signing-key rotation (SPEC 09)

This is an operator procedure for a future approved activation, not an
authorization to rotate or deploy. Auth and Core remain separate single-user
identities: `auth_runtime` uses `DB_RUNTIME_SECRET_ARN`; `core_runtime` uses
`CORE_RUNTIME_SECRET_ARN`. Never substitute master, migrator, operator, or the
other API's credentials. Core has no application signing key.

#### Pre-rotation checks

1. Confirm the owner approved the service-specific window and recovery operator.
   Check the service's current deployment/spec gate, secret ARN handoff, exact
   runtime identity, TLS CA/hostname verification, current Lambda version and
   timing configuration. SPEC 10's 2026-11-01 handoff records both dev APIs as
   deployed; revalidate those bindings from the latest SPEC 10.1 evidence before
   a future rotation.
2. Confirm a usable recovery path and the current database/secret pair without
   printing either value. Keep secret retrieval and password entry inside the
   authorized operator tool; do not put values in command arguments, SQL history,
   terminal recordings, shell tracing, tickets, source, or logs.
3. For a database rotation, arrange both the authorized PostgreSQL role-password
   update and the matching Secrets Manager update as one controlled operation.
   Updating Secrets Manager alone does not change PostgreSQL. Existing sessions
   can continue using the old password, so do not treat a successful request on
   a warm pool as validation.
4. For Auth signing-key rotation, inspect the secret JSON privately and verify:
   current `BETTER_AUTH_SECRET` is non-empty and has at least 32 characters;
   `BETTER_AUTH_SECRET_VERSION` is a positive integer that will increase;
   `BETTER_AUTH_PREVIOUS_SECRETS` contains every still-required historical key
   with unique lower integer versions and non-empty values; and the entries do
   not conflict with `AWSPREVIOUS`. Keep the list ordered current-first and then
   previous versions descending. Never include values in the review record.

#### Auth signing-key format and rotation

The signing secret container accepts this JSON shape (placeholders only):

```json
{
  "BETTER_AUTH_SECRET": "<current value>",
  "BETTER_AUTH_SECRET_VERSION": 2,
  "BETTER_AUTH_PREVIOUS_SECRETS": [{ "version": 1, "value": "<retained previous value>" }]
}
```

An initial secret may omit `BETTER_AUTH_SECRET_VERSION` and is treated as
version 1. Every rotation after that must provide a greater integer. Preserve
all keys still needed to decrypt Better Auth encrypted data or verify
versioned-key JWTs; for example, a version 3 payload may need retained entries
for versions 2 and 1. **Secrets Manager `AWSPREVIOUS` exposes only the immediately
previous secret payload. It does not guarantee that older key history survives
multiple rotations.** Carry the complete required history forward in
`BETTER_AUTH_PREVIOUS_SECRETS` on every new payload. The runtime merges that list
with the immediate `AWSPREVIOUS` value, rejects malformed or duplicate entries
within a list and conflicting definitions across sources, and merges identical
overlap. It cannot know whether an operator omitted an older key
that some persisted data still needs.

After publishing the approved current value, allow an invocation to load the
new secret set and validate the complete Auth generation before it serves
requests. Better Auth 1.7.7 versioned keys retain supported encrypted values and
JWT verification while the relevant old key remains present. Session cookies
are signed with the current secret, not the versioned key list: browsers with
pre-rotation cookies must sign in again. Rotation does not delete the matching
database session rows. A controlled signing rollback must publish a matching
secret set with a new, higher `BETTER_AUTH_SECRET_VERSION` and complete history;
moving `AWSCURRENT` backward or rolling Lambda code back alone is not recovery.

#### Runtime database password update and verification

Use the authorized out-of-band database operator procedure for exactly one
runtime role at a time. In the approved change window:

1. Change that PostgreSQL role's password through the private operator
   procedure. Do not use application SQL or put the value in a command line.
2. Immediately publish the matching `{ "username": "<exact runtime identity>",
   "password": "<new value>" }` payload to that service's existing Secrets
   Manager container through the authorized secure channel. Do not write the
   payload to a tracked file, shell history, or log.
3. Do not force cold starts or candidate refreshes during the mismatch interval.
   Then verify a **new TLS connection** using the exact runtime identity, RDS CA
   verification, and a read-only identity query such as `SELECT current_user`.

This database-first order keeps the secret as the prior authoritative pair until
the database change is committed, then minimizes the gap before publishing its
match. It still has a mismatch window and does not promise zero downtime. Do not
run application SQL to change passwords.

Do not rely on an existing connection or session. The runtime validates the
candidate connection and identity before replacing its pool/generation. Observe
the relevant Lambda errors and RDS connection metric only within the approved
deployment test limits; do not raise the 56 alarm to make a test pass.

#### Mismatch recovery

- If the database password changed but the secret update failed, either complete
  the matching secret update or restore the database role to the securely
  retained prior password. Verify the resulting pair with a fresh TLS connection.
- If the secret changed but the database update failed, either complete the
  authorized database update or publish a new secret version matching the
  database's actual password. Do not move labels blindly or assume a secret-only
  rollback changes PostgreSQL.
- If the database operation's result is uncertain, stop and establish the
  actual role state through the authorized private procedure before attempting
  another change. Never replay an HTTP request, write, or transaction whose
  outcome may be ambiguous.
- During a mismatch the API can continue on an old usable generation only
  within its configured maximum-stale window. After that it returns sanitized
  service-unavailable responses; initial-load or candidate failures also fail
  closed. Restore a matching database/secret pair first, then allow a fresh
  invocation to validate and recover. Do not use master credentials as fallback.

#### Recorded evidence and deployment handoffs (2026-10-30)

- Auth: 244 unit/HTTP tests passed, 21 skipped by their documented integration
  gates; typecheck, lint, format check, build, and Lambda build passed. Focused
  signing-key tests covered Better Auth 1.7.7 versioned encryption/JWT behavior,
  key retention, signing-only and simultaneous database/signing generation
  replacement, and expected browser-cookie sign-in after rotation.
- Local PostgreSQL: the serial isolated integration run passed its Auth, Core,
  and db-config suites and preserved the development sentinel. The separate
  SPEC 09 disposable-container tests performed real password changes for both
  runtime usernames, mismatch recovery, identity isolation, connection overlap
  and cleanup. The container was temporary and used no TLS; these are not AWS,
  RDS-capacity, or verified-TLS results.
- Not performed: live Secrets Manager stage behavior, SQL reconfirmation of
  usable RDS capacity, AWS verified-TLS candidate checks, peak measurement on
  RDS, an actual password/signing-secret rotation, or API deployment. Auth live
  rotation belongs to SPEC 10; final Auth IAM/TLS review belongs to SPEC 07.1;
  Core API activation/rotation requires its separate deployment spec. Keep these
  as explicit gates and do not claim this local evidence satisfies them.

#### SPEC 10.1 operational handoff (updated 2026-11-05)

SPEC 10.1 passed for its bounded dev scope. The initial traffic report is
`artifacts/validation/spec10.1-20261101T174133Z.json`; the separate step-4
preflight/rotation record is
`artifacts/validation/spec10.1-rotation-attempt-20261101T190327Z.json`.

- **Normal use — passed:** 236 Core requests and 60 Auth requests; combined
  achieved rate 4.933 req/s. Reconstructed peak overlap was 5 Core, 2 Auth and
  6 combined. The historical SQL filter counted only visible backend types.
- **Shared limiter — passed:** 3 admissions and 1 expected HTTP 429 with
  `Retry-After`; counter rows remained 2 before and after.
- **20 req/s burst — deferred/unproven:** 25/25 Core responses were HTTP 200 at
  5 req/s, with no unexpected 5xx or non-limiter 429. The five-request Core in-flight limit and observed latency made
  this an observed-rate check, not a 20 req/s test. Revisit only for a concrete
  capacity need or changed conditions.
- **Credential transitions — verified on 2026-11-05:** Auth and Core adopted
  their new database credentials in separate runs. Auth then adopted signing
  version 2, verified JWT continuity, and confirmed browser reauthentication.
  The signing campaign's aggregate SQL peak remains unmeasured. See the
  [credential campaign evidence](docs/credential-function-diagnostic.md#verified-reconnect-recovery).
- **Aggregate SQL follow-up — passed:** 40 HTTP 200 responses and 19 SQL samples
  over verified TLS. The peak was six aggregate connections, including the
  monitor and internal RDS connections. See the
  [normal-use follow-up](specs/10.1-dev-api-operational-validation.md#aggregate-sql-monitoring-follow-up).
- **Accounting:** traffic campaign remains 349/500 used, 151 remaining. The
  initial rotation preflight consumed 0/500. Later rotation ledgers are separate.
  No credentials, secret values
  or API request bodies are recorded.

SPEC 11 consumes this handoff with the recorded dev limits and explicit deferrals.
The November 5 rotation reports provide live adoption evidence. SPEC 09 supplies
the local refresh and recovery coverage.

Before any future Lambda is activated against this RDS instance, its owning spec
must document its exact runtime identity and secret allowlist, client lifecycle,
pool maximum, concurrency allocation, refresh and cleanup behavior, overlap
allowance, and updated aggregate budget with focused evidence.

Set `TF_VAR_alarm_notification_email` in the ignored
`gootip-infra/.env.notifications` file and keep that file private. From
`gootip-infra/`, use the following format with your actual alert address.

```dotenv
TF_VAR_alarm_notification_email=alerts@example.invalid
```

Run `direnv allow` to load the file through `.envrc`. In a shell without
direnv, export the same variable before planning. The subscription to `gootip-dev-operational-alarms` in `us-east-2` is confirmed, and
the operator reports that a manual test message published to the topic was
received at the subscribed email address. This satisfies SPEC 06's scoped SNS
delivery-test criterion; no Lambda failure or database load was induced.

The Terraform-managed fixed monthly actual-cost budget
`gootip-dev-monthly-actual-cost` is USD 10 with one `ACTUAL` email notification
when cost exceeds 80% (USD 8). The live budget is in `us-east-1`, the AWS
Budgets control-plane Region. Credits and refunds are excluded so credits
cannot hide underlying consumption. Budget data is delayed and evaluated at
most daily; this is not a spending cap. No forecast, budget action, or automatic
shutdown is configured.
AWS documents monthly cost budgets as available in its Free Plan onboarding;
the exact budget was confirmed absent before creation and is now managed by this
Terraform root.

As of 2026-10-20, `GetAccountPlanState` reported `FREE`/`ACTIVE`, USD 136.69 in
remaining credits, and expiration at 2027-04-08 15:54 UTC (170 days remaining).
Free account plans have Always Free offers; `GetFreeTierUsage` returned no
current usage entries. [AWS documentation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/tracking-free-tier-usage.html)
describes periodic native Free Plan credit-balance and expiration notices,
separate from the monthly cost budget. The operator confirmed this account uses
the AWS New Experience: its Billing UI exposes Cost Explorer, Free Tier, and
Budgets, but no Billing preferences page or configurable **Receive AWS Free
Tier usage alerts** toggle. Per AWS's [Free Plan alert documentation](https://docs.aws.amazon.com/accounts/latest/reference/bcm-lite-free-tier-track.html),
credit-balance and expiration notices are automatic in this experience. The
`billing:GetBillingPreferences` API read remains denied by an Organizations SCP;
no SCP or IAM workaround was added because the setting is not configurable in
this experience. [AWS documentation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/migrate-granularaccess-whatis.html)
says accounts created on or after 2023-03-06 use granular billing IAM actions,
so the deployment policy does not add legacy `aws-portal` actions.
AWS cost, budget, credit, and expiration data may be delayed; none is a spending
cap. No forecast alert is configured.

For diagnostics, inspect the exact alarm's metric and dimensions in CloudWatch,
then follow the linked log group. Do not log tokens, cookies, request bodies,
SQL text/parameters, secret values, or raw sensitive errors. SPEC 07 consumes
the Lambda log-group ARNs; SPEC 08 refines the RDS connection reserve; SPEC 10
consumes the API log group and SNS topic handoff and owns public-runtime alarms
and structured access-log attachment.
