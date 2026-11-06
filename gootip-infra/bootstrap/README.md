# Gootip infrastructure bootstrap

This independent Terraform root owns the Gootip control plane. `backend.tf`
declares an active S3 backend; its account-specific bucket, key, Region, and
native lockfile settings are supplied by the ignored local backend config.
The S3 object `bootstrap/terraform.tfstate` is the current state of record.
`terraform.tfstate.backup` is historical evidence only; never restore, migrate,
import, or overwrite either state. Do not initialize or plan against the remote
backend until the SPEC 02.1 compatibility gate and current operational gates
are evidenced and the exact backend configuration is reviewed.

The only permitted project Region is `us-east-2`. Before any remote
initialization, the compatibility gate must inventory the legacy backend and
all discoverable state without writing state, acquiring a lock, or changing
configuration.

## Local plan artifacts

Store saved plans and related output in `artifacts/plans/` relative to this
bootstrap root, physically `gootip-infra/bootstrap/artifacts/plans/`.
The parent `.envrc` creates the directory and supplies that default plan path.
Without direnv, run `mkdir -p -m 700 artifacts/plans` before the plan commands
below and keep the explicit `-out=artifacts/plans/<name>.tfplan` argument.
Apply the same reviewed saved filename. Do not move or reset backend state as
part of plan-file housekeeping.

## Inputs

`environments/dev.tfvars` contains portable, non-sensitive defaults. Supply the
independently confirmed Account ID and exact AWS-managed Secrets Manager KMS
key ARN at runtime:

```bash
export TF_VAR_aws_account_id="<ACCOUNT_ID>"
export TF_VAR_secrets_manager_kms_key_arn="<SECRETS_MANAGER_KMS_KEY_ARN>"
```

Do not commit the Account ID, generated bucket name, role ARNs, secret ARNs, or
generated backend configuration. `application_secret_arn` and
`rds_master_secret_arn` remain `null` until their reviewed handoffs. The
Secrets Manager KMS key ARN is a non-sensitive reference resolved from
`alias/aws/secretsmanager`; Terraform never manages the AWS-owned key.

All phase controls fail closed:

| Input | Default | Required condition |
| --- | --- | --- |
| `eligibility_gate_passed` | `false` | Set only from current recorded Free Plan evidence |
| `account_resource_phase_enabled` | `false` | Requires the eligibility gate; keep it true after account resources exist |
| `role_secret_creation_enabled` | `false` | Set true only for the reviewed SPEC 03 container-creation apply; requires `account_resource_phase_enabled` and returns to false as soon as both role-secret containers exist |
| `split_policy_creation_enabled` | `false` | Set true only for reviewed split-policy transitions; requires `account_resource_phase_enabled` and returns to false in the cleanup apply |
| `diagnostics_inventory_enabled` | `false` | SPEC 02.3 scope. Set true only for the separately reviewed SPEC 02.3 apply that adds the read-only policy and role inventory to `GootipBootstrapDiagnosticsPermissions`; never set by SPEC 03.1 |
| `secrets_manager_kms_key_arn` | `null` | Exact AWS-managed Secrets Manager key ARN required while the foundation expansion is enabled |
| `cutover_prerequisites_verified` | `false` | Set only after role, state, administration, and authorization verification |
| `source_user_cutover_enabled` | `false` | Requires all preceding gates, the exact validated RDS master-secret ARN, and a fresh recovery-ready bootstrap session |
| `core_migrations_log_access_enabled` | `false` | Set true only in the separate Core SPEC 06 deployment phase; it allows the shared runtime boundary to write to the exact Core migration log group |

Never enable source-user cutover during initial IAM bootstrap.

The SPEC 14 exact-ARN handoff may add the two Core credential ARNs to the
application runtime boundary so the existing administrative Lambda can read
them. Keep `core_migrations_log_access_enabled = false` in that phase; it is a
separate boundary capability for the Core SPEC 06 runner and does not belong in
the administrative Lambda plan.

## Foundation eligibility and state preflight

Before any SPEC 02.2 foundation plan or apply, use a fresh
`GootipTerraformDeploy` MFA-backed session to record the current Free Plan
state, credits, expiration, Free Tier usage, applicable quotas, and estimated
foundation consumption in an ignored local operational record. The deployment
policy grants only `freetier:GetAccountPlanState` and
`freetier:GetFreeTierUsage` for this check. It never grants
`freetier:UpgradeAccountPlan`.

`foundation_policy_expansion_enabled` remains `false` by default. Set it only
for the separately reviewed SPEC 02.2 bootstrap plan after the saved foundation
plan and authorization inventory pass review. Its scope is limited to the
foundation network, protected RDS resources, and shared CA layer; it excludes
runtime IAM, Lambda/API deployment, PassRole, RDS replicas/restores, and every
secret-value operation.

The expansion also grants only `servicequotas:ListServiceQuotas`, which is
required to record current RDS and VPC quota evidence before the foundation
apply. This action has no resource-level IAM scope.

RDS-managed master-password creation requires the deployment caller to
describe the exact AWS-managed Secrets Manager KMS key and to create and tag
the generated `rds!db-*` secret. These grants are limited to the exact key ARN
and the account- and Region-scoped RDS DB secret ARN pattern. They do not grant
secret-value reads, writes, deletion, or rotation. The deployment policy keeps
its explicit Secrets Manager deny for every other secret: `CreateSecret` and
`TagResource` stay denied through `DenyNonRdsSecretsManagerCreateAndTag`, whose
`NotResource` names only the RDS-managed DB secret pattern.

## External RDS service-linked-role bootstrap

`GootipBootstrapAdmin` has a separately scoped, two-statement exception to
read and create only
`role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS`, with
`iam:AWSServiceName = rds.amazonaws.com` required for creation. This is a
one-time external administrative bootstrap so that RDS can provision its
AWS-managed dependency. Terraform does not declare, import, tag, modify, or
delete the service-linked role.

`foundation_policy_expansion_enabled` remains `false` by default. Set it only
for the separately reviewed SPEC 02.2 bootstrap plan after the saved foundation
plan and authorization inventory pass review. Its scope is limited to the
foundation network, protected RDS resources, and shared CA layer; it excludes
runtime IAM, Lambda/API deployment, PassRole, RDS replicas/restores, and every
secret-value operation.

The canonical application backend is the same protected state bucket as this
root, with key `gootip/dev/terraform.tfstate`, SSE-S3 encryption, S3 native
lockfiles, and the account-qualified backend configuration rendered locally.
Before first initialization, inspect the exact bucket/key with the deployment
role and record whether the key is absent, empty, populated, or inaccessible.
An absent application key for a new foundation is an initialization-pending
state, not permission to create a placeholder state object or change its key.
Run `terraform init -reconfigure -backend-config=environments/dev.s3.tfbackend`
only after those checks pass; do not migrate any state without approved source
and destination evidence.

The ignored local `terraform.tfstate` is empty. The ignored
`terraform.tfstate.backup` is a historical snapshot, not a candidate source for
the remote backend. Its lineage, serial, and addresses may be inspected
read-only, but it must never be restored, migrated, imported, or overwritten,
and must never be treated as application-root state.

## SPEC 03 role-secret transition

`role_secret_creation_enabled` attaches the inline `GootipRoleSecretCreation`
policy to `GootipBootstrapAdmin`. It grants `secretsmanager:CreateSecret` for
exactly `gootip-dev-auth-runtime` and `gootip-dev-auth-migrator`, constrained by
name and the required Gootip tags, and nothing else: the temporary grant reads
and writes no value. Set it true only for the reviewed container-creation apply
and return it to false as soon as both containers exist.

The first apply therefore cannot load either container's value, and that limit is
enforced by IAM rather than by procedure. `OperateExactApprovedSecretValues`
(the only statement that allows `GetSecretValue` and `PutSecretValue`) lists the
two role containers only when `auth_runtime_secret_arn` and
`auth_migrator_secret_arn` are both supplied, so while the temporary
`CreateSecret` grant is active no policy grants manual value access to what that
apply creates. The gate keys on the reviewed ARNs and not on
`role_secret_creation_enabled` on purpose: it must be closed while the flag is
true and open once the flag returns to false. A `precondition` on
`bootstrap_application_secret_permissions` fails the plan if the flag is still
true when either ARN is supplied, so container creation and value loading can
never coexist.

The exact generated ARNs then enter `auth_runtime_secret_arn` and
`auth_migrator_secret_arn` in the reviewed second apply, which also removes the
temporary `CreateSecret`. The later reviewed `db_operator_secret_arn` handoff
extends manual value operations (`DescribeSecret`, `GetSecretValue`,
`PutSecretValue`) to the fourth approved container; the exact RDS master-secret
denial is unchanged.

The manual-value `NotResource` exception then follows the same gate: it names
the application secret only while the containers are being created, and the four
approved containers once all reviewed ARNs are supplied, so phase 1 denies
`GetSecretValue` and `PutSecretValue` on the new containers explicitly rather
than only by the absence of an allow. The exact RDS master-secret denial is
unchanged.

One limit follows from the AWS provider, not from a choice here.
`DenyEveryOtherSecret` denies the manual value actions only; it does not deny
`DescribeSecret`. Terraform calls `DescribeSecret` and `GetResourcePolicy`
immediately after creating a container and on every refresh, so an explicit deny
covering a container under creation would fail the creating apply and every later
plan. Container metadata stays available through
`ManageExactApprovedSecretContainers` in both phases, and every other secret keeps
no allow for `DescribeSecret` at all.

`ManageExactApprovedSecretContainers` addresses the two role containers by their
reviewed name patterns while both exact ARNs are unapproved, and by those exact
ARNs afterwards. The patterns are required, not cosmetic: naming the container
resources would make the policy depend on the containers it authorizes, so the
policy update could not be ordered before the container-creation apply and the
provider's immediate `DescribeSecret`/`GetResourcePolicy` read-back after
`CreateSecret` would be denied. Both containers also declare an explicit
`depends_on` on the temporary grant, so the reviewed order is always: grant
first, containers second, exact-ARN policy update in the next reviewed apply.

IAM authorization propagation can still lag a fresh policy version or a fresh
inline-policy attachment. The reviewed procedure therefore publishes a grant as
its own step and lets it propagate before the step that depends on it:

```bash
# Step 1: publish the permission change and let IAM propagate it.
terraform plan -out=artifacts/plans/step1.tfplan -target=aws_iam_policy.bootstrap_permissions
terraform apply artifacts/plans/step1.tfplan

# Step 2: create the resources from a fresh plan.
terraform plan -out=artifacts/plans/step2.tfplan
terraform apply artifacts/plans/step2.tfplan
```

If a container or policy exists in AWS but the apply failed before recording it
in state, do not re-run the plan blind: `terraform import` the existing resource
address, then converge with a fresh apply. Never set
`role_secret_creation_enabled=true` to repair phase 2.

### Operator verification of the applied policy

The permissions policy names the application container's ARN, which is unknown
until the apply runs, so it cannot be asserted from a `plan`-only test. After
each reviewed apply, read the applied policy and check the shape:

```bash
# Phase 1 (flag true, both ARNs still unset): the manual-value statement and the
# deny exception must name only the application secret, and the temporary grant
# must exist.
aws iam get-policy-version \
  --policy-arn "arn:aws:iam::<ACCOUNT_ID>:policy/gootip/bootstrap/GootipBootstrapAdminPermissions" \
  --version-id "$(aws iam get-policy \
    --policy-arn "arn:aws:iam::<ACCOUNT_ID>:policy/gootip/bootstrap/GootipBootstrapAdminPermissions" \
    --query 'Policy.DefaultVersionId' --output text)" \
  --query 'PolicyVersion.Document' --output json |
  jq -e '
    def count(x): if (x | type) == "string" then 1 else (x | length) end;
    ([.Statement[] | select(.Sid == "OperateExactApprovedSecretValues")][0] | count(.Resource) == 1)
    and ([.Statement[] | select(.Sid == "DenyEveryOtherSecret")][0] | count(.NotResource) == 1)'
aws iam get-role-policy --role-name GootipBootstrapAdmin \
  --policy-name GootipRoleSecretCreation >/dev/null

# Phase 2 (flag false, all reviewed ARNs supplied): no CreateSecret, and both the
# manual-value statement and the deny exception cover exactly the four complete
# ARNs with no wildcard.
aws iam get-role-policy --role-name GootipBootstrapAdmin \
  --policy-name GootipRoleSecretCreation >/dev/null 2>&1 && exit 1 || true
aws iam get-policy-version \
  --policy-arn "arn:aws:iam::<ACCOUNT_ID>:policy/gootip/bootstrap/GootipBootstrapAdminPermissions" \
  --version-id "$(aws iam get-policy \
    --policy-arn "arn:aws:iam::<ACCOUNT_ID>:policy/gootip/bootstrap/GootipBootstrapAdminPermissions" \
    --query 'Policy.DefaultVersionId' --output text)" \
  --query 'PolicyVersion.Document' --output json |
  jq -e '
    def exact4(x):
      ((x | type) == "array") and (x | length) == 4
      and all(x[]; contains("*") | not);
    ([.Statement[] | select(.Sid == "OperateExactApprovedSecretValues")][0] | exact4(.Resource))
    and ([.Statement[] | select(.Sid == "DenyEveryOtherSecret")][0] | exact4(.NotResource))'
```

Loading the values, deploying and invoking `lambda_db_config`, and the
revocation and recovery steps are documented in
`../gootip-db-config/README.md`.

## Static verification

The repo-root offline cycles run every static check with no AWS credentials and
cover this root:

```bash
# from the repository root (gootip-infra/)
./scripts/verify_fast.sh   # fmt + both terraform validate + pure tests
./scripts/verify_full.sh   # offline: seven renders, two init runs, shared plans
```

For a single root, the individual commands mirror them:

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

## Live-AWS gate (separate, mandatory before relevant IAM plans or applies)

The offline cycles never call AWS. These two commands do; they are not run by
`scripts/verify_full.sh`, and they are not assumed to use the same profile:

```bash
# From the bootstrap MFA session that corresponds to the bootstrap role.
terraform -chdir=bootstrap test

# A principal explicitly authorized for access-analyzer:ValidatePolicy.
python3 scripts/validate_policies.py --profile <PROFILE>
```

The policy assertions use the non-committed account ID from the environment, so
run `terraform test` with `TF_VAR_aws_account_id="<ACCOUNT_ID>"`.
`gootip-bootstrap-admin` does not hold `access-analyzer:ValidatePolicy` in the
standing configuration, so it is not the profile for `validate_policies.py`.

The first IAM-only plan and import are later implementation steps. Before any
plan, independently compare `TF_VAR_aws_account_id` with the authenticated AWS
Console and the selected profile's signed STS identity.

## Human-role MFA age and session durations (SPEC 02.4)

All three human roles — `GootipBootstrapAdmin`, `GootipTerraformDeploy`, and
`GootipDatabaseOperator` — share
`data.aws_iam_policy_document.human_role_trust`, which requires present MFA with
`aws:MultiFactorAuthAge ≤ 10800`. The bootstrap and deployment roles keep
`max_session_duration = 3600`; the database-operator role also keeps `3600`.
SPEC 02.4 raises only the shared MFA-age ceiling,
because AWS caps every role session assumed through the `gootip-mfa`
`GetSessionToken` credentials (role chaining) at one hour, so a longer
`max_session_duration` would permit nothing the chosen flow can use. The matching
local role profiles request `duration_seconds = 3600` (setup, renewal, and the
hook are documented in `../README.md`). The `gootip-db-operator` profile and
private tunnel workflow are documented in `../README.md` under "Private dev
database access (SPEC 05.2)".

The change is an in-place update with no replacements:

```text
update aws_iam_role.bootstrap_admin   trust MFA age 3600 -> 10800 (max_session_duration stays 3600)
update aws_iam_role.terraform_deploy  trust MFA age 3600 -> 10800 (max_session_duration stays 3600)
```

`tests/iam.tftest.hcl` (`run "human_roles_require_recent_mfa"`) asserts both
one-hour maximum session durations, the MFA-present condition, the 10,800-second
age ceiling, and the exact source-user principal. Verify with the live gate and
confirm no drift:

```bash
terraform -chdir=bootstrap test                                    # plan-only; needs TF_VAR_aws_account_id
terraform -chdir=bootstrap plan -detailed-exitcode \
  -var-file=environments/dev.tfvars                                # expect exit 0 (no changes)
```

**Limits of validation.** A plan-only `terraform test` proves the rendered
configuration, not an effective token duration, and a cached assumed-role
credential can mask an expired or broken source session. AWS also caps a
role-chaining session at one hour regardless of the role maximum, so an assumed
role never outlives its source session. Confirm the real behavior only with a
fresh `AssumeRole` from a freshly minted `gootip-mfa` source session, and
re-check once the source session is older than one hour and younger than three
hours.

**Rollback to the one-hour contract:** set `values = ["3600"]` in `iam.tf`
(the role maximums already stay at 3,600), regenerate a reviewed plan, apply the
symmetric update, and restore `duration_seconds = 3600` in both local role
profiles. Neither direction destroys a resource.

## SPEC 03.1 managed-policy split

SPEC 03 measured `GootipTerraformDeployPermissions` at 6,046 of the 6,144
non-whitespace characters and an apply failed with `LimitExceeded: PolicySize:
6144`. SPEC 03.1 splits the two near-limit policies by capability domain without
changing any grant. The managed-policy set per role after the split:

| Role                      | Policies                                                                                                                                                                                                                              | Attachments |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `GootipTerraformDeploy`   | `GootipTerraformDeployPermissions` (core, including foundation reads), `GootipTerraformDeployNetworkPermissions`, `GootipTerraformDeployDatabasePermissions`, `GootipTerraformDeployAdministrativePassRole`, `GootipTerraformDeployDbConfigPermissions`, `GootipTerraformDeployAuthMigrationsPermissions`, `GootipTerraformDeployCoreMigrationsPermissions`, `GootipTerraformDeployObservabilityPermissions`, `GootipTerraformDeployApplicationPermissions`, `GootipTerraformDeployApiGatewayPermissions` | 10 |
| `GootipBootstrapAdmin`    | `GootipBootstrapAdminPermissions` (core), `GootipBootstrapPolicyAdminPermissions`, `GootipBootstrapStatePermissions`, `GootipBootstrapDiagnosticsPermissions`                                                                          | 4           |

The network/database deployment capabilities and the admin capability are gated by
`foundation_policy_expansion_enabled`. The retained policies keep their existing
physical names, so no retained policy is destroyed and recreated.

To stay within the ten-managed-policy attachment limit after SPEC 10 adds its
two API capabilities, the four exact foundation-read statements are consolidated
back into `GootipTerraformDeployPermissions`. Their actions, resources, and
conditions are unchanged. The former foundation-read policy has one attachment,
to `GootipTerraformDeploy`; no other role consumes it.

### SPEC 06 observability deployment capability

`GootipTerraformDeployObservabilityPermissions` is a permanent, separately
attached capability for the exact SPEC 06 log groups, operational SNS topic and
subscription, three named CloudWatch alarms, and the named monthly actual-cost
budget. It is separate from the
near-quota core policy and is not gated after creation. It grants no IAM
PassRole, secret, application runtime, or unrelated Logs/SNS/CloudWatch access.

The three Core API alarms are added to the exact alarm ARN list of
`GootipTerraformDeployObservabilityPermissions`. The Core API Lambda log-group
permissions are included in the existing
`GootipTerraformDeployApplicationPermissions` capability. Reusing these existing
attachments keeps the deployment role within AWS's ten-policy attachment limit;
both policies remain below IAM's 6,144-character quota. Core log-group creation
is regional and requires the exact `gootip-core-dev` name and standard request
tags.

The only literal `Resource = "*"` exception is `logs:CreateLogGroup`; it is
restricted to `us-east-2`, the three reserved log-group Name values, and exact
request tags (`project`, `env`, and `managed_by`) with a required TagKeys list.
The subscription ARN pattern covers only the AWS-generated subscription ID
under the exact Gootip SNS topic. Other operations name exact resource ARNs.

The deployment role currently has seven attached customer-managed policies;
this capability makes eight, below AWS's ten-policy role limit. The Terraform
policy guardrails and bootstrap tests enforce the exact resource scope, tag
conditions, wildcard exceptions, forbidden-action exclusions, and attachment
limit. Prepare and review a saved bootstrap plan before applying this one-time
permanent capability.

### Three-apply transition

A managed policy cannot create itself, and the admin role holds no permanent
`iam:CreatePolicy`. The split therefore ships as three reviewed applies driven by
`split_policy_creation_enabled` (default `false`):

| Apply                 | Flag  | Command shape                                                                                                                                  | Mutations                                                                                          |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A — grant             | true  | `terraform plan -out=artifacts/plans/03.1-a.tfplan -var=split_policy_creation_enabled=true -target=aws_iam_policy.bootstrap_permissions`                       | new `GootipBootstrapAdminPermissions` version that adds `CreateExactSplitPolicies`, retains `ManageExactHumanRolesAndPolicies`, and withdraws `ManageExactSplitPolicyTags` and `CreateExactAdministrativePassRolePolicy` |
| B — create and attach | true  | `terraform plan -out=artifacts/plans/03.1-b.tfplan -var=split_policy_creation_enabled=true` (review that only the four new policies and their attachments change) | the four new policies and their role attachments                                                   |
| C — withdraw          | false | `terraform plan -out=artifacts/plans/03.1-c.tfplan` (default flag, no `-target`)                                                                                      | new `GootipBootstrapAdminPermissions` version removing exactly `CreateExactSplitPolicies` and `ManageExactHumanRolesAndPolicies` |

Apply A must land before B, and C must land last: the final default
configuration renders no `CreateExactSplitPolicies` or retirement grants, so
the split adds no permanent policy-creation/deletion authorization.
`CreateExactSplitPolicies` remains scoped to its exact policy ARNs. For the
SPEC 10 foundation-read retirement, the temporary grant additionally permits
read/refresh of only the foundation-read and observability policies, and
`iam:DeletePolicy` only for the exact foundation-read ARN. Verify its attachment
count is zero before deletion. `iam:ListPolicyVersions` is separately limited to
the exact foundation-read ARN. The pre-existing SPEC 03
`CreateExactAdministrativePassRolePolicy` exception is unchanged and out of
scope here.

After the reviewed policy-creation/retirement plan succeeds, prepare a separate
refreshed cleanup plan with `split_policy_creation_enabled=false` and no
`-target`. It must remove `CreateExactSplitPolicies`,
`ReadExactFoundationRetirementTargets`, and
`DeleteExactRetiredFoundationReadPolicy`, and
`ListVersionsExactRetiredFoundationReadPolicy` from
`GootipBootstrapAdminPermissions`, with no other changes. Generate that saved
plan only after the completion apply; any plan rendered before it is stale.

**Render the plans one step at a time.** A saved plan describes the state it was
rendered against, so only the A plan is reviewable now:

```bash
# A - against the current state (present for approval)
terraform plan -out=artifacts/plans/bootstrap-split-policy-step-a-grant.tfplan \
  -var=split_policy_creation_enabled=true -target=aws_iam_policy.bootstrap_permissions

# B - only after A is applied
terraform plan -out=artifacts/plans/bootstrap-split-policy-step-b.tfplan \
  -var=split_policy_creation_enabled=true

# C - only after B is applied and the capability is verified effective
aws iam list-attached-role-policies --role-name GootipBootstrapAdmin
terraform plan -out=artifacts/plans/bootstrap-split-policy-step-c.tfplan   # default flag, no -target
```

A correct C shows **exactly one** resource change,
`aws_iam_policy.bootstrap_permissions`, removing the temporary creation and
retirement grants; apply A has already withdrawn the other lifecycle SIDs.
Anything else means the state drifted and the apply must stop.
Plans B and C rendered before their preceding apply are stale and must not be
applied.

While the flag is true the Core also merges **one** lifecycle statement,
`ManageExactHumanRolesAndPolicies` (from the shared document
`bootstrap_role_policy_lifecycle`), so apply A only *adds* the grant instead of
dropping `iam:AttachRolePolicy` and `iam:CreatePolicyVersion` before the
capability exists. B can then create the four policies, attach them, and update
`GootipTerraformDeployPermissions`; C withdraws the grant and the retained
statement together.

Retaining all three lifecycle statements as well overflowed the 6,144-character
AWS quota (the pre-split core rendered at 6,192 and the first apply A failed with
`LimitExceeded: Cannot exceed quota for PolicySize: 6144`), so A withdraws
`ManageExactSplitPolicyTags` and `CreateExactAdministrativePassRolePolicy`. B does
not need them: the grant covers policy tagging on the four new ARNs, and the SPEC
03 PassRole policy already exists.

The transition core is the only render allowed into the 4,500–5,499 warning band;
every standing configuration stays below 4,500. `BOOTSTRAP_TRANSITION` in
`scripts/iam_policy_evaluator.py` renders it (5,256 characters with the checker's
fixture ARNs, 5,269 against the live account), and `check_transition_core` in
`scripts/check_iam_policy_guardrails.py` fails the build if it reaches 5,500,
exceeds 6,144, or does not carry exactly `CreateExactSplitPolicies` and
`ManageExactHumanRolesAndPolicies`.

`BOOTSTRAP_ROLE_SECRET_MAXIMUM` renders the SPEC 03 role-secret ARN handoff, where
both exact role-secret ARNs replace the reviewed name patterns, and
`check_role_secret_maximum` gates every policy in it against the same 5,500 and
6,144 ceilings. The largest is 3,409 characters, so the handoff stays healthy and
the split cannot be undone by it. Both gates run locally with no AWS apply.

### The SPEC 02.3 diagnostics authorization is separate

The three read-only SPEC 02.3 statements that extend
`GootipBootstrapDiagnosticsPermissions` (Access Analyzer `ValidatePolicy`, the
managed-policy inventory, and the role-attachment inventory) are **not** part of
SPEC 03.1. They sit behind `diagnostics_inventory_enabled` (default `false`),
which no SPEC 03.1 apply sets, so:

- the diagnostics policy renders exactly as it already exists in AWS — one
  `LookupFoundationCloudTrailEventsInRegion` statement — and plan B has no
  diagnostics delta;
- `run "bootstrap_diagnostics_inventory_is_deferred"` asserts that on a SPEC
  03.1 render, while `run "bootstrap_diagnostics_inventory_is_read_only"` still
  asserts the statements themselves with the flag on;
- `scripts/check_iam_policy_guardrails.py` reviews them from its own
  `bootstrap-diagnostics` render, so their wildcard review is preserved without
  being folded into the SPEC 03.1 bootstrap renders.

After SPEC 03.1 has converged, SPEC 02.3 validation runs as an explicit pair
rather than a standing grant. **D1** is its own saved plan with
`diagnostics_inventory_enabled = true`, adding exactly the three statements
above (the diagnostics policy moves from one statement to four); validation then
runs from a fresh MFA-backed `GootipBootstrapAdmin` session; **D2** is a second
saved plan with the default `false`, withdrawing exactly those three statements.
D1 and D2 each need their own review and explicit approval, neither plan is
regenerated between review and apply, and after D2 both the normal and
`-refresh=false` plans must report no changes.

Verify the split without touching AWS before planning (the repo-root
`./scripts/verify_full.sh` wraps exactly this and the fast cycle):

```bash
python3 scripts/check_iam_policy_guardrails.py               # sizes, attachments, wildcard review
python3 bootstrap/scripts/compare_bootstrap_policy_split.py  # role-union equivalence
python3 -m unittest discover -s scripts/tests                # checker unit tests
```

The remote half runs only inside a D1 window. It renders every configuration
first, calls `ValidatePolicy` only — never `ListAnalyzers` — follows every
finding page to exhaustion, and exits non-zero on `ERROR` or
`SECURITY_WARNING`:

```bash
python3 scripts/validate_policies.py --profile <PROFILE>
```

`<PROFILE>` must explicitly hold `access-analyzer:ValidatePolicy` in `us-east-2`;
`gootip-bootstrap-admin` does not hold it in the standing configuration.
`check_iam_policy_guardrails.py` and the comparator render each policy through
the shared isolated evaluator with stubbed credentials. The full driver renders
seven unique configurations (six bootstrap and one application) using two
isolated roots and two `terraform init` runs, then shares those plans with both
checks and the application-policy assertions. The cycle is offline, makes no
AWS calls, and needs no AWS credentials. The materializer cleanup test is mocked
and does not run Terraform. The evaluator reuses the provider cache in
`TF_PLUGIN_CACHE_DIR` (default `~/.terraform.d/plugin-cache`); plans themselves
are not cached between cycles.

## Runtime permissions

The deployment role receives exactly one application-runtime permission during
SPEC 03: `PassExactAdministrativeFunctionRole`, which allows `iam:PassRole` for
the administrative `gootip-db-config-<env>-lambda` execution role and only when
it is passed to `lambda.amazonaws.com`, because the reviewed deployment of
`lambda_db_config` needs it. It lives in its own attached policy,
`GootipTerraformDeployAdministrativePassRole`, because
`GootipTerraformDeployPermissions` is already close to the 6144-character
customer managed policy limit and must not absorb new grants; an inline policy is
not an accepted overflow mechanism. Every other runtime permission stays deferred
to the later reviewed runtime deployment specification. The source-user boundary
policy is created during the IAM-only phase but is attached through the imported
IAM user only during the separately gated cutover step.

### SPEC 08 application-client egress description repair

The application root manages the dev `application_client` security group's
egress inline. A description-only diff in that inline set caused the AWS
provider's revoke step to fail because EC2 did not recognize the revoke request;
the existing egress rule itself remained present. Do not remove or recreate the
rule, edit Terraform state, or bypass the inline configuration with
`ignore_changes`.

`GootipTerraformDeployAuthMigrationsPermissions` grants only
`ec2:UpdateSecurityGroupRuleDescriptionsEgress` for the exact
`sg-0123456789abcdef0` ARN. The allow also requires `ec2:Region = us-east-2` and
the existing `project=gootip`, `env=dev`, and `managed_by=terraform` resource
tags. The EC2 Service Authorization Reference supports security-group resource
scoping and these conditions; no `Resource: "*"` exception is needed.

After the separately reviewed bootstrap policy update has been applied, use the
rule-ID-specific description API. Its dry run must return `DryRunOperation`
before the non-dry-run call is made:

```bash
aws ec2 update-security-group-rule-descriptions-egress \
  --group-id "$TF_VAR_deployment_application_client_security_group_id" \
  --security-group-rule-descriptions \
  '[{"SecurityGroupRuleId":"sgr-03ba471e50a7662cc","Description":"Temporary development egress; SPEC 07.1 owns destination-specific rules."}]' \
  --dry-run --region us-east-2 --profile gootip-terraform-deploy
```

Then rerun the command without `--dry-run`. Verify the same rule ID, protocol,
port representation, and `0.0.0.0/0` destination remain, with only the
description updated. The application-root Terraform state already records the
desired description from its failed apply; once EC2 has the matching text, make
a fresh plan and confirm the security group no longer changes before reviewing
any saved plan for the migration executor.

#### SPEC 08 repair evidence (2026-10-21)

- `audit/spec08-application-client-egress-description-20261021.tfplan` changed
  only `aws_iam_policy.deployment_auth_migrations_permissions` in place; the
  plan was applied through `GootipBootstrapAdmin`.
- The `GootipTerraformDeploy` dry run returned `DryRunOperation`; the
  rule-ID-specific description update returned `Return: true`.
- EC2 still reports rule `sgr-03ba471e50a7662cc` in group
  `sg-0123456789abcdef0` as egress, protocol `-1`, all ports, IPv4 destination
  `0.0.0.0/0`, with only the description changed.
- The focused
  `tests/application_client_egress_description.tftest.hcl` passed. The broader
  `tests/iam.tftest.hcl` run still fails in the pre-existing
  `bootstrap_rds_service_linked_role_exception_is_exact` run because its plan
  assertion receives an unknown condition value; that test was not modified.
- The refreshed executor plan is
  `../artifacts/plans/spec08-migration-runner-post-egress-fix.tfplan`; it contains only an
  in-place executor code/publication update and the `deployment` alias move.
  `baseline` remains on version 2. This executor plan has not been applied.

Creating that one policy requires `iam:CreatePolicy`, which the bootstrap admin
now holds permanently but scoped to exactly the
`GootipTerraformDeployAdministrativePassRole` ARN
(`CreateExactAdministrativePassRolePolicy`, together with `iam:ListPolicyTags`,
`iam:TagPolicy`, and `iam:UntagPolicy` for its tag lifecycle). No other customer
managed policy can be created, and no policy can be deleted. This is a
deliberate, reviewed exception to the earlier "no permanent customer managed
policy creation" invariant, which is why the corresponding assertion in
`tests/iam.tftest.hcl` now pins the exception to that exact ARN instead of
forbidding the action outright.

### Recovering an interrupted `lambda_db_config` creation

If Terraform reports a provider timeout while creating `lambda_db_config`, do
not blindly reapply the saved create plan. Check the function's State,
LastUpdateStatus, and CodeSha256 in the `us-east-2` Lambda console first. The
deployment policy includes `lambda:GetFunctionConfiguration` only for the exact
unqualified `lambda_db_config` ARN so Terraform can inspect/import an already
created function; this is read-only and does not authorize invocation.

If the function exists, import it at
`aws_lambda_function.gootip_db_config[0]` using the existing non-sensitive
configuration references, then make a fresh plan and review code hash,
environment references, role boundary, VPC, and security-group dependencies.
Never replay the stale create plan or manually edit state. If the code hash
differs from the reviewed local ZIP, stop before applying a new plan.

Recovery evidence (2026-10-21): `lambda_db_config` was confirmed Active with a
Successful last update and the approved local ZIP hash, imported at the exact
address above, and aligned in place by a saved plan. The temporary
`GootipBootstrapAdmin` invoke permission was enabled only for the bootstrap
reconciliation, then removed with a separate saved plan. The function remains
deployed; this recovery did not remove it or invoke it again.
