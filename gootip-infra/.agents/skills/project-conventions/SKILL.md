---
name: project-conventions
description: Enforce Terraform conventions for gootip-infra. Use when creating or editing .tf/.tfvars files, resources, variables, outputs, IAM, network, RDS, Lambda, API Gateway, secrets, or specs. Ensures snake_case naming, flat-file layout, strict no-secrets policy, non-sensitive tfvars, and English-only specs and config text.
---

# project-conventions

Mandatory rules for all Terraform code and specs in this repo.

## 1. snake_case naming with flat-file layout

Flat files in repo root, one file per domain, plus `environments/` for var files.

Rules:
- Root files: `main.tf`, `providers.tf`, `variables.tf`, `outputs.tf`, plus one per domain: `lambda.tf`, `api-gateway.tf`, `iam.tf`, `rds.tf`, `secrets.tf`, `network.tf`
- Var files only under `environments/`: `environments/dev.tfvars` (later `prod.tfvars`)
- All HCL identifiers in lowercase snake_case: filenames, `resource` labels, `variable` / `output` / `locals` names, data source labels, module labels
- Never use camelCase, PascalCase, or kebab-case in HCL identifiers (hyphens are illegal in references and force `["..."]` access)
- AWS resource `name` / `Name` tag values use lowercase hyphens only for the physical name string (e.g. `"gootip-auth-dev"`), while the Terraform label stays snake_case
- Every taggable resource sets `tags` with at minimum `project`, `env`, `managed_by = "terraform"`
- One resource per block; no inline multi-resource hacks

Good:
```hcl
# lambda.tf
resource "aws_lambda_function" "gootip_auth" {
  function_name = "gootip-auth-dev"
  runtime       = "nodejs24.x"
  handler       = "dist/lambda.handler"
  tags = {
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}
```

Bad:
```hcl
# lambdaFunction.tf -> rename to lambda.tf
resource "aws_lambda_function" "gootipAuthDev" { ... } # -> gootip_auth
resource "aws_lambda_function" "gootip-auth-dev" { ... } # illegal reference style
```

## 2. Canonical HCL style, providers, and state

Formatting and provider/state setup are non-negotiable.

Rules:
- Code must be `terraform fmt` clean; block order per file: `terraform {}` -> `provider` -> `variable` -> `data` -> `resource` -> `output`
- AWS provider: `~> 6.0`, region from `var.aws_region` (fixed to `us-east-2` by SPEC 02.1 through a non-sensitive validated variable, never hardcoded per-resource)
- S3 native backend with locking (`use_lockfile = true`); never commit or use local `terraform.tfstate` in CI/prod
- `variables.tf`: every variable has explicit `type` + `description`; add `validation` where a wrong value breaks infra (e.g. runtime allowlist, memory range)
- `outputs.tf`: only non-sensitive values (`api_url`, endpoint DNS without credentials); mark anything remotely sensitive `sensitive = true` or omit it
- No provider version drift: pin `required_version` and provider constraints in `main.tf` / `providers.tf`

Good:
```hcl
variable "lambda_runtime" {
  description = "Lambda runtime for the app function."
  type        = string
  default     = "nodejs24.x"

  validation {
    condition     = var.lambda_runtime == "nodejs24.x"
    error_message = "Only nodejs24.x is supported."
  }
}

output "api_url" {
  description = "Public HTTP API endpoint."
  value       = aws_apigatewayv2_api.main.api_endpoint
}
```

Bad:
```hcl
variable "lambda_runtime" {} # missing type + description
output "db_password" { value = "secret" } # never output secrets
```

## 3. Strict secrets policy (SPEC 01 pattern)

Terraform creates secret containers and policies, never secret values.

Rules:
- Forbidden anywhere in `gootip-infra/`: `secret_string`, `secret_binary`, `aws_secretsmanager_secret_version` resource, `data.aws_secretsmanager_secret_version`, `random_password`, `password =`
- App secrets: single `aws_secretsmanager_secret` per app/env (e.g. `gootip-auth-dev`), created empty; values loaded out-of-band via console/CI (`put-secret-value`), never in `.tf`/tfvars/state
- RDS auth: `manage_master_user_password = true` only; Terraform never sees or stores the password
- KMS: AWS-managed key; no extra KMS endpoint or `kms:Decrypt` grants beyond defaults
- IAM: `secretsmanager:GetSecretValue` scoped to the exact ARNs (app secret + RDS `master_user_secret`), no wildcards
- Secret ARNs travel as plain Lambda env vars (they are references, not secrets); secret values are only resolved at runtime (e.g. loader in `lambda.ts` before framework init, fail-fast on missing key, never logged)
- Network: no `aws_nat_gateway`, Internet gateway, public subnet, or Logs endpoint in dev; one `secretsmanager` VPC Interface endpoint with `private_dns_enabled` in an explicitly selected private subnet, SG 443 ingress only from the reserved application-client SG

Good:
```hcl
resource "aws_secretsmanager_secret" "gootip_auth" {
  name = "gootip-auth-dev"
}

resource "aws_db_instance" "main" {
  instance_class              = "db.t3.micro"
  manage_master_user_password = true
}
```

Bad:
```hcl
resource "aws_secretsmanager_secret_version" "gootip_auth" { # forbidden
  secret_id     = aws_secretsmanager_secret.gootip_auth.id
  secret_string = "{\"BETTER_AUTH_SECRET\":\"...\"}"
}

resource "aws_db_instance" "main" {
  password = var.db_password # forbidden
}
```

## 4. environments/*.tfvars contains only non-sensitive values

`variables.tf` defines the shape; `environments/` supplies safe per-env values.

Rules:
- `variables.tf` must not declare sensitive `default` values; mark truly sensitive inputs `sensitive = true` and leave them unset (injected via env vars or secret store, never tfvars)
- `environments/dev.tfvars` (and future `prod.tfvars`) holds only non-sensitive values: `aws_region`, `project`, `env`, `lambda_memory`, `lambda_timeout`, `lambda_runtime = "nodejs24.x"`, `rds_instance_class`, `rds_db_name`, `frontend_url`, and secret ARNs (references, not values)
- Zero secrets in `.tf`, `.tfvars`, or state: no passwords, tokens, private keys, `BETTER_AUTH_SECRET`, `POSTGRES_DB_PASSWORD`
- Verification: `grep -R` for `secret_string|secret_binary|secret_version|random_password|password\s*=` in `gootip-infra/` must return nothing; `terraform plan` must show no real secret values

Good:
```hcl
# environments/dev.tfvars
aws_region          = "us-east-2"
project             = "gootip"
env                 = "dev"
lambda_runtime      = "nodejs24.x"
lambda_memory       = 512
lambda_timeout      = 30
rds_instance_class  = "db.t3.micro"
```

Bad:
```hcl
# environments/dev.tfvars
db_password          = "supersecret123" # forbidden: belongs in Secrets Manager
better_auth_secret   = "abc..."         # forbidden: belongs in Secrets Manager
```

## 5. English-only specs and config text

All specs, HCL comments, variable descriptions, tag values, error messages, and docs use English.

Rules:
- Specs in `specs/`: headings, scope, criteria, decisions all in English
- HCL comments (`#`), `description` fields, and `outputs` descriptions all in English
- Never mix Spanish/Portuguese into committed config text or keys
- Existing non-English text touched during an edit must be translated to English in the same change
- Exception: `specs/01-gootip-auth-lambda-terraform-dev.md` is grandfathered in Spanish; new specs must be English

Good:
```hcl
variable "frontend_url" {
  description = "Allowed CORS origin for the HTTP API."
  type        = string
}
```

Bad:
```hcl
variable "frontend_url" {
  description = "URL del frontend para CORS." # translate to English
  type        = string
}
```

## Verification checklist

Before finishing any task touching `*.tf` / `*.tfvars` / `specs/`:

- [ ] `./scripts/verify_fast.sh` passes after every edit (plan-free, no AWS credentials). It already runs `terraform fmt -check -recursive`, `terraform init -backend=false` for any root that is not initialized, both `terraform validate` invocations, and only the pure Python tests, so those commands are never re-run by hand.
- [ ] `./scripts/verify_full.sh` passes before review/merge (offline, no AWS credentials). It already includes the fast cycle plus `scripts/check_iam_policy_guardrails.py`, `bootstrap/scripts/compare_bootstrap_policy_split.py`, and the Terraform-materializing render test.

Run the remaining gates only when the change type calls for them:

- [ ] Terraform lint/security surface changed (`*.tf`): `tflint` passes and `tfsec .` (or `trivy config .`) passes (no open ports, no plaintext secrets, no risky defaults).
- [ ] Secrets, IAM, or `*.tfvars` touched: the `grep` in `gootip-infra/` returns zero hits for `secret_string`, `secret_binary`, `secret_version`, `random_password`, `password =`.
- [ ] Change affects real infrastructure: `terraform init` (real backend with S3 lockfile) passes and `terraform plan -detailed-exitcode -out=tfplan -var-file=environments/dev.tfvars` behaves as expected (0 = no changes, 2 = pending changes, 1 = error).
- [ ] Live-AWS gate (separate; not run by the offline cycles, and not assumed to share a profile): `TF_VAR_aws_account_id="<ACCOUNT_ID>" terraform -chdir=bootstrap test` from the bootstrap MFA session for the bootstrap role, and `python3 scripts/validate_policies.py --profile <PROFILE>` with a principal explicitly authorized for `access-analyzer:ValidatePolicy` (`gootip-bootstrap-admin` does not hold it standing).

Structural checks that still apply:

- [ ] Plan contains no `aws_nat_gateway`, Internet gateway, public subnet, or Logs VPC endpoint; exactly one `secretsmanager` VPC endpoint has private DNS
- [ ] Until SPEC 10, the plan contains no Lambda or API Gateway runtime resource; RDS is `db.t3.micro` in private subnets, 5432 only from the reserved application-client SG, and verified TLS through the shared RDS CA layer
- [ ] All new/renamed files snake_case flat layout; variables have `type` + `description`; tags `project`/`env`/`managed_by` present
- [ ] All specs/comments/descriptions English (except grandfathered SPEC 01)
