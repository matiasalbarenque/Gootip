# AGENTS.md — gootip-infra

Terraform infrastructure for the existing Gootip AWS Sign up for AWS (new)
project in `us-east-2`. SPEC 02.1 is the active contract for IAM, STS MFA,
account guards, bootstrap, and state; SPEC 01 is historical where it conflicts.

## Mandatory conventions

Read `.agents/project-conventions/SKILL.md` before creating/editing any `.tf`, `.tfvars`, or spec. It overrides defaults.

- Layout: flat files in root (`main.tf`, `providers.tf`, `variables.tf`, `outputs.tf`, plus `lambda.tf`, `api-gateway.tf`, `iam.tf`, `rds.tf`, `secrets.tf`, `network.tf`). Var files only in `environments/` (`dev.tfvars`, later `prod.tfvars`).
- HCL identifiers: lowercase `snake_case` only. Physical AWS names use lowercase hyphens (e.g. `gootip-auth-dev`). Every taggable resource gets `project`, `env`, `managed_by = "terraform"`.
- Style: `terraform fmt` clean; block order `terraform {}` → `provider` → `variable` → `data` → `resource` → `output`. AWS provider is pinned to `~> 6.0`, with region from `var.aws_region` and an account allowlist. S3 backends use `use_lockfile = true`; never commit local state. Variables need `type` + `description`; outputs only non-sensitive values.
- `bootstrap/` is an independent local-first Terraform root. Do not initialize, migrate, import, apply, or mutate AWS until SPEC 02.1's compatibility gate has passed.
- Do not manage or import AWS-managed Organizations, Identity Center, Account Access Manager, IAM Role Manager, project-access roles, service-linked roles, SCPs, RCPs, or roles under `/managed/`.
- English-only specs, comments, descriptions, tags. Exception: `specs/01-*` is grandfathered in Spanish.

## Secrets policy (hard rules)

Terraform creates secret containers/policies, never values. Forbidden in this repo: `secret_string`, `secret_binary`, `aws_secretsmanager_secret_version`, `data.aws_secretsmanager_secret_version`, `random_password`, `password =`.

- One empty `aws_secretsmanager_secret` per app/env (`gootip-auth-dev`); values via console/CI `put-secret-value` only.
- RDS: `manage_master_user_password = true`. IAM `GetSecretValue` scoped to exact ARNs (app secret + RDS `master_user_secret`), no wildcards. KMS AWS-managed, no extra endpoint. Secret ARNs as plain Lambda env vars are fine (references, not values).
- `environments/*.tfvars`: non-sensitive values only. Verify: `grep -R 'secret_string\|secret_binary\|secret_version\|random_password\|password\s*=' .` returns nothing and `plan` shows no real values.

## Fixed infra decisions (SPEC 02.2)

RDS is `db.t3.micro` in two private subnets. The reserved `application_client`
security group remains assigned to the future `gootip-auth` Lambda. The
`lambda_db_config` and `auth_migrations` functions use their independent client
security groups as authorized by SPEC 03, SPEC 04, and SPEC 07. RDS PostgreSQL
ingress (5432) may reference only `application_client`, `db_config` while its
deployment is enabled, `auth_migrations` while enabled, and the SPEC 05.2
tunnel-host security group while database-operator access is enabled. Secrets
Manager endpoint HTTPS ingress (443) may reference only `application_client` and
the enabled Lambda client security groups; the database tunnel does not require
endpoint access. Retaining a disabled `db_config` security group for teardown
does not retain its RDS or endpoint ingress. TLS uses the shared RDS CA layer.

`gootip-auth` and the HTTP API remain deferred until SPEC 10. Dev has no
`aws_nat_gateway`, Internet gateway, public subnet, or Logs interface endpoint.
The single Secrets Manager interface endpoint has private DNS in the explicitly
selected private subnet. Native Lambda logging does not require VPC access to
the Logs API. SPEC 02.1 IAM boundaries, exact PassRole allowlists, backend
controls, and the no-public-network contract remain authoritative.

## Verification cadence

### Local plan artifacts

- Save plans and related JSON/output files in `artifacts/plans/` relative to the
  Terraform root being used, including `bootstrap/artifacts/plans/` for bootstrap.
- `.envrc` sets `TF_CLI_ARGS_plan=-out=artifacts/plans/tfplan` as the default.
  Explicit `-out` arguments must use the same directory with a descriptive name.
- Create the directory before planning when direnv is not loaded. Review and
  apply the same saved filename; never apply a plan merely because it exists.
- Keep state, backend configuration, credential files, and deployed ZIP paths
  in their established locations. Temporary isolated test plans stay in their
  test directory.

### Required creation-API wildcard exception

When an AWS create API cannot authorize against a not-yet-existing ARN, a
`Resource: "*"` exception is allowed only for its single required action, with
an exact Region condition, all required request tags, an exact `aws:TagKeys`
allowlist, and `Null aws:TagKeys = false`. The action list must contain no
wildcard, and every later operation must use the exact created-resource ARN.

During development, follow the root `AGENTS.md` pragmatic-dev policy: run
`terraform fmt`, `terraform validate`, and the focused Terraform tests for the
root being changed. Do not repeat scanners, packaging, Autopilot, live IAM
inventory, or the full repository suite after every small correction when their
inputs are unchanged.

Run the complete sequence below once before final handoff or an environment-wide
deployment. A reviewed capability-first dev apply may use its focused tests and
exact saved-plan summary instead.

```bash
brew install hashicorp/tap/terraform tflint tfsec trivy  # once per machine
terraform fmt -check -recursive
terraform init -backend=false   # read-only PR check
terraform validate
tflint
tfsec .
terraform init                  # real backend
terraform plan -detailed-exitcode -out=artifacts/plans/tfplan -var-file=environments/dev.tfvars
```

## Spec workflow

- `/spec` (`.agents/spec/SKILL.md`): never writes code, only `specs/NN-slug.md` (state `Draft`). New specs must be English.
- `/spec-impl` (`.agents/spec-impl/SKILL.md`): only runs on specs whose status means `Approved`; creates/switches to branch `spec-NN-slug` (see `specs/.spec-config.yml` `AutoCreateBranch`). One plan step at a time, never auto-commit, out-of-scope stays out.
