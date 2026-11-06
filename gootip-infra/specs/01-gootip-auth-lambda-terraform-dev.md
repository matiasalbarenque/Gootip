# SPEC 01 — Gootip Auth Lambda + RDS with Terraform (dev)

> **Status:** Implemented
> **Depends on:** SPEC 02 in `gootip-auth` (Lambda handler + JWT + `auth` schema)
> **Date:** 2026-10-06
> **Objective:** Deploy `gootip-auth/src/lambda.ts` to Lambda `nodejs24.x` + HTTP API + RDS Postgres with Terraform in `us-east-1`, with no secrets in code or state and no NAT Gateway.

> **Architecture note:** SPEC 02.1 supersedes this implemented baseline for human AWS access, account/backend guards, backend naming and migration, and ownership and initialization of the `gootip-auth-dev` secret. The backend and application-secret ownership statements below are historical; active implementation must use SPEC 02.1, with the application root consuming the exact bootstrap-owned secret ARN.

## Scope

**In:**

- Sibling folder `gootip-infra/` with `main.tf`, `providers.tf`, `variables.tf`, `outputs.tf`, `lambda.tf`, `api-gateway.tf`, `iam.tf`, `rds.tf`, `secrets.tf`, `network.tf`, `environments/dev.tfvars`.
- Spec at `gootip-infra/specs/01-gootip-auth-lambda-terraform-dev.md` with `/spec` skill naming.
- Native S3 backend with locking (`use_lockfile = true`), no local state in CI/prod.
- New dev VPC (`network.tf`): public/private subnets, DNS enabled, Lambda→RDS 5432 SG, **no NAT Gateway**, with VPC Interface endpoints `secretsmanager` and `logs` (private DNS).
- RDS `db.t3.micro` Postgres in private subnets with `manage_master_user_password = true`; Terraform never sees or stores the password.
- Single JSON `gootip-auth-dev` secret in Secrets Manager with only `BETTER_AUTH_SECRET`: Terraform creates/manages the resource and its policies, never the value. The RDS-managed master secret is the single source of truth for the DB password; Terraform never duplicates it into `gootip-auth-dev`. KMS with AWS-managed key.
- Lambda `arm64` `nodejs24.x`, `handler = dist/lambda.handler` (CJS bundle per SPEC 03 in `gootip-auth`), ZIP built by CI (`pnpm build:lambda` + `pnpm lambda:zip` in `gootip-auth/`, the ZIP contains only `dist/lambda.js`), 512–1024 memory, 30s timeout, in VPC.
- Isolated secrets loader only in `gootip-auth/src/lambda.ts`: reads `gootip-auth-dev` + RDS managed secret via `secretsmanager:GetSecretValue` at runtime, before `NestFactory.create`. `main.ts` and the rest of `gootip-auth/` untouched.
- HTTP API payload 2.0, `$default` route → Lambda proxy, CORS from `FRONTEND_URL`, `api_url` output.
- `dev.tfvars` with only non-sensitive values; `variables.tf` with no sensitive defaults.

**Out of scope (for future specs):**

- RDS Proxy (design-only preparation, included in prod spec).
- Prod environment (`prod.tfvars`, Proxy, domains, WAF, extended logs, possible NAT).
- Automatic migrations from Lambda.
- Social OAuth, SMTP, 2FA, rate limiting, roles.
- `sam local` / `serverless offline`.
- `nest deploy` / Mau.

## Data model

```hcl
# variables.tf (non-sensitive): aws_region, project, env, lambda_memory,
# lambda_timeout, lambda_runtime = "nodejs24.x", rds_instance_class,
# rds_db_name, rds_db_user, jwt_audience, better_auth_url, frontend_url,
# typeorm_synchronize = false, app_secret_arn, db_master_secret_arn
# (ARNs, non-sensitive; empty = use the Terraform-managed resources)
# dev.tfvars: dev values, zero secrets
```

```json
// Secrets Manager gootip-auth-dev (resource managed by Terraform,
// value loaded outside Terraform via console/CI with put-secret-value):
// { "BETTER_AUTH_SECRET": "..." }
// POSTGRES_DB_PASSWORD is NOT stored here: at runtime the loader populates
// it from the RDS-managed master secret (manage_master_user_password).
```

```hcl
# secrets.tf: only aws_secretsmanager_secret (no secret_version).
# Forbidden: secret_string, secret_binary, data aws_secretsmanager_secret_version.
# rds.tf: manage_master_user_password = true.
# Forbidden: password = ..., random_password resource.
# iam.tf: secretsmanager:GetSecretValue scoped to the 2 exact ARNs
# (gootip-auth-dev + RDS master_user_secret). No wildcards.
# network.tf: aws_vpc_endpoint secretsmanager + logs, private_dns_enabled,
# SG 443 only from Lambda SG. No aws_nat_gateway.
```

Conventions:

- Compiled handler: `dist/lambda.handler` (CJS esbuild bundle `dist/lambda.js` per SPEC 03, `src/lambda.ts` exports `handler`).
- Global `/api` prefix preserved; `BETTER_AUTH_URL` is the exact public URL with `/api/auth`.
- The secret ARNs (`SECRET_ARN` for `gootip-auth-dev`, `DB_MASTER_SECRET_ARN` for the RDS managed master secret) travel as plain Lambda env vars: they are references, not sensitive.
- AWS/Secrets Manager logic lives only in the `lambda.ts` loader; it does not leak into the `gootip-auth/` domain.

## Implementation plan

1. Create `gootip-infra/` with empty `.tf` skeleton + `providers.tf` (`aws ~> 5.0`, `us-east-1` region) + S3 backend with lockfile. Manual: `terraform init` succeeds.
2. Add `variables.tf` + `environments/dev.tfvars` with only non-sensitive values (`lambda_runtime = "nodejs24.x"`, `typeorm_synchronize = false`). Manual: `terraform plan` asks for no secrets.
3. Add `network.tf`: new dev VPC with DNS (`enableDnsSupport`, `enableDnsHostnames`), public/private subnets across 2 AZs, SGs, `secretsmanager` and `logs` endpoints with private DNS. No NAT. Manual: plan has no `aws_nat_gateway` and has 2 `aws_vpc_endpoint` resources.
4. Add `rds.tf` (`db.t3.micro`, private subnets, SG allowing only 5432 from Lambda, `manage_master_user_password = true`). Manual: plan shows endpoint and `master_user_secret` without exposing the value.
5. Add `secrets.tf` (empty `gootip-auth-dev` resource + read policy for the Lambda role). Values via console/CI, never in `.tf`/tfvars. Manual: `plan` contains no real values.
6. Add `iam.tf` (Lambda role + `BasicExecution` + `VPCAccess` + `GetSecretValue` on the 2 exact ARNs). Manual: plan has no excessive `*`.
7. Add the loader in `gootip-auth/src/lambda.ts`: `loadSecretsToEnv()` with SDK v3 before `NestFactory.create`. It reads `SECRET_ARN` (`BETTER_AUTH_SECRET` → `process.env`) and `DB_MASTER_SECRET_ARN` (RDS `password` → `POSTGRES_DB_PASSWORD`), mapping each key only when `process.env` is undefined, without logging values; skips everything when `SECRET_ARN` is unset (local dev) and fail-fasts when a secret or a key is missing. Manual: `pnpm build` compiles the handler.
8. Add `lambda.tf` (`nodejs24.x` runtime, `handler = dist/lambda.handler`, VPC, non-sensitive env + `SECRET_ARN` + `DB_MASTER_SECRET_ARN`, timeout/memory, invoke permission). Single-file ZIP as CI artifact (`pnpm lambda:zip` produces `lambda.zip` with only `dist/lambda.js`, git-ignored). Manual: `plan` resolves the handler.
9. Add `api-gateway.tf` (HTTP API 2.0, `$default`, auto-deploy stage, CORS, `aws_lambda_permission`). Manual: `api_url` output.
10. Document CI flow: `pnpm --dir ../gootip-auth build:lambda` → `pnpm --dir ../gootip-auth lambda:zip` → `terraform plan/apply -var-file=environments/dev.tfvars` → load `BETTER_AUTH_SECRET` into `gootip-auth-dev` via console/CLI (the DB password stays only in the RDS-managed secret) → smoke test `GET <api_url>/api/auth/jwks` returns 200 and login has no CORS errors.
11. Add unit tests for the loader (mocked client: success, missing secret, missing key) and run `pnpm test`, `pnpm lint`, `pnpm format:check` in `gootip-auth/`.

## Acceptance criteria

- [ ] `terraform init + plan -var-file=environments/dev.tfvars` passes with no secrets in code.
- [ ] S3 backend with native locking active, no local `terraform.tfstate` in CI.
- [ ] `grep` in `gootip-infra/`: zero matches for `secret_string`, `secret_binary`, `secret_version`, `random_password` and `password =`.
- [ ] Plan contains no `aws_nat_gateway`; `secretsmanager` and `logs` endpoints exist with private DNS.
- [ ] Lambda uses `nodejs24.x` runtime with `dist/lambda.handler` and serves `GET /api/auth/jwks` via Gateway.
- [ ] RDS is `db.t3.micro` in a private VPC, reachable only from the Lambda SG over 5432, with RDS-managed password.
- [ ] `TYPEORM_SYNCHRONIZE=false` applied in dev.
- [ ] `BETTER_AUTH_SECRET` lives only in `gootip-auth-dev`, the DB password only in the RDS-managed secret; neither appears in `.tf`, tfvars, or state, and the DB password is never duplicated into `gootip-auth-dev`.
- [ ] `main.ts` and the `gootip-auth/` domain untouched; only `lambda.ts` adds the loader.
- [ ] `gootip-auth/` `pnpm test`, `pnpm lint` and `pnpm format:check` pass.

## Decisions

- **Yes:** Terraform + AWS Provider in `gootip-infra/`. Firm user decision.
- **Yes:** `us-east-1`. Requested region.
- **Yes:** `nodejs24.x`. Requested adjustment; runtime available in `us-east-1` and compatible with the `ES2023` build.
- **Yes:** New VPC + `db.t3.micro`. Simple and cheap for dev.
- **No:** RDS Proxy in dev. Cost; kept ready for prod.
- **Yes:** S3 backend with native lockfile. No DynamoDB, no local state.
- **Yes:** single JSON `gootip-auth-dev` secret with only `BETTER_AUTH_SECRET`. Simple, one secret per app/env.
- **Yes:** RDS-managed master secret as the single source of truth for the DB password. The loader populates `POSTGRES_DB_PASSWORD` from it at runtime; nothing ever copies it into `gootip-auth-dev`.
- **No:** secrets in tfvars or hardcoded. Explicit requirement.
- **Yes:** Terraform creates the secret resource and its policies but never `secret_version` or value data sources. No sensitive data enters state.
- **No:** `random_password` or `password =` in RDS. `manage_master_user_password = true` generates and guards the password outside Terraform.
- **Yes:** non-sensitive values in `variables.tf + dev.tfvars`. No SSM for now.
- **Yes:** KMS with AWS-managed key. Avoids an extra KMS endpoint and `kms:Decrypt` grants.
- **Yes:** VPC endpoints (`secretsmanager`, `logs`) instead of NAT in dev. Lower fixed cost; the only AWS calls Lambda needs at runtime.
- **Yes:** ZIP via CI (`pnpm build:lambda` + `pnpm lambda:zip`, single-file `dist/lambda.js` CJS bundle per SPEC 03). Reproducible, avoids a giant `archive_file`.
- **Yes:** HTTP API 2.0 `$default`. Recommended for `serverless-express` v4.
- **Yes:** secrets loader only in `gootip-auth/src/lambda.ts`, before module initialization. No AWS logic in the domain.
- **No:** `nest deploy`/Mau. Not the Terraform flow.

## Risks

| Risk                               | Mitigation                                                      |
| ---------------------------------- | --------------------------------------------------------------- |
| Direct ZIP >50MB                   | Upload via S3 (`aws_s3_object` + `s3_key` in Lambda)            |
| Nest + TypeORM cold start          | 512–1024MB, pool `max: 2`, Proxy in prod                        |
| Empty secret after first apply     | Documented bootstrap + fail-fast with clear error in the loader |
| Rotation requires new cold start   | Accepted in dev; documented, Proxy/rotation in prod spec        |
| `BETTER_AUTH_URL` != public URL    | `BETTER_AUTH_URL` = exact Gateway `/api/auth` URL               |
| nodejs24.x and native dependencies | `pnpm build + test` in CI validate compatibility before the zip |

## What is **not** in this spec

- RDS Proxy in dev.
- Prod environment.
- Automatic migrations.
- OAuth, SMTP, 2FA, rate limiting, roles.
- Local Lambda invoke.
- `nest deploy`.

Each of those, if it lands, goes in its own spec.
