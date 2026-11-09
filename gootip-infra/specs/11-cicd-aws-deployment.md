# SPEC 11 — GitHub Actions CI and Authorized AWS Deployment

> **Status:** Approved
> **Depends on:** SPEC 02.1, SPEC 04, SPEC 06, SPEC 07.1, SPEC 09, SPEC 10, SPEC 10.1, SPEC 13, and Core SPEC 06
> **Date:** 2026-10-30
> **Baseline reviewed:** 2026-11-05
> **Objective:** Run reproducible monorepo CI and manually authorized, migration-gated AWS dev releases through GitHub Actions.

## Current baseline

- [SPEC 10](10-final-dev-application-deployment.md#completion-boundary-and-handoff-to-spec-101) deployed Auth and Core on the shared HTTP API. [SPEC 10.1](10.1-dev-api-operational-validation.md#explicitly-deferred-coverage) completed the bounded operational handoff. Reuse the route and JWT authorizer matrix, live migration and runtime evidence, normal traffic, limiter, individual credential transitions, and corrected SQL monitoring. The 20 req/s burst and other deferred exercises retain their recorded limits and owners. Routine release acceptance uses bounded smoke checks.
- SPEC 02.1 owns the existing account-qualified backend and bootstrap IAM boundaries. SPEC 06 already owns the dev monthly budget, credit notifications, operational alarms, and log retention. Preserve SPEC 07.1 runtime hardening and SPEC 09 credential refresh, signing recovery, and aggregate connection headroom, including deployment overlap.
- The SPEC 06 decision to leave the dev operational-alert SNS topic without customer-managed KMS encryption is accepted for alerts containing no secrets or personal data. AWS-0095 is excepted only on `aws_sns_topic.operational_alarms`; resolving it with KMS is not a prerequisite for SPEC 11. Revisit if the alert data scope changes.
- Both private migration executors already publish Lambda versions and have a `deployment` alias. Auth also has an operator-only `baseline` alias. The current [API Gateway integrations](../api-gateway.tf) still invoke the Auth and Core application functions without an alias. Adopting stable application aliases and qualified permissions is new work.
- The current build and ZIP commands already normalize Auth and Core archive timestamps. Auth packaging validates the committed SQL manifest and reports migration package sizes. Core packaging emits the TypeORM manifest and ZIP digests. The pipeline consumes these outputs.
- The latest full offline infrastructure check validates both roots and passes the focused guardrails. `GootipTerraformDeployApplicationPermissions` renders to 5,498 characters against the 5,500-character internal limit after shortening a descriptive `Sid`; the limit is unchanged and CI continues to enforce it.

## Scope

- Run credential-free GitHub Actions checks on pull requests and pushes to `main`. Reuse the repository's commands and disposable PostgreSQL test setup.
- Add manual, trusted AWS dev planning and releases with OIDC, private saved plans and versioned S3 artifacts, separate approval for each apply, and migration results verified before activation.
- Adopt stable Auth and Core aliases for the existing API. Keep unchanged services on their active release and retain a verified rollback target.
- Add short-lived private plan cleanup, bounded smoke checks, and deployment recovery instructions.
- Outside this release are staging/production, frontend hosting, first-time infrastructure or database bootstrap, automated credential rotation, destructive schema changes, and automated deletion of Lambda versions or release artifacts.

## Implementation boundaries

| Path                                                          | Responsibility                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                    | Credential-free checks with stable check names                                                                   |
| `.github/workflows/terraform-plan.yml`                        | Manual private plan and sanitized review summary                                                                 |
| `.github/workflows/deploy-dev.yml`                            | Serialized release, preparation approval, migrations, activation approval, smoke checks                          |
| `.github/workflows/deployment-cleanup.yml`                    | Remove private plan objects, including abandoned versions                                                        |
| `gootip-infra/bootstrap/cicd.tf`                              | Bootstrap-owned OIDC provider and scoped CI roles                                                                |
| `gootip-infra/artifacts.tf`                                   | Private storage for plans and exact release artifacts                                                            |
| `gootip-infra/lambda.tf`, `api-gateway.tf` and related inputs | Versioned release inputs, stable aliases, qualified invocation, phase invariants                                 |
| Existing package and infrastructure scripts                   | Build, package, validate, and test using current commands. Add helpers only for workflow behavior missing today. |
| `README.md`, `gootip-infra/README.md`                         | Local checks and dev plan, deploy, retention, and recovery instructions                                          |

### Toolchains and CI matrix

Start from the tool setup and saved-plan pattern exercised by the Bot Telegram workflow. Use the following baseline from the first Gootip workflow.

| Component                  | Initial value  | Configuration                                                                                                                       |
| -------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GitHub-hosted Linux runner | `ubuntu-26.04` | Set `runs-on` explicitly. Use `ubuntu-26.04-arm` for any Lambda packaging or verification that executes target-native dependencies. |
| Node.js                    | `24.22.1`      | Set `node-version-file: .nvmrc` for CI and release builds.                                                                          |
| pnpm                       | `12.14.0`      | Read the exact `packageManager` pin from the relevant project's `package.json`. Keep Auth, Core, and Front on the same version.     |
| Terraform CLI              | `1.17.1`       | Set `terraform_version: 1.17.1` and `terraform_wrapper: false`. Use the same CLI for validation, plan, and apply.                   |
| TFLint                     | `0.64.0`       | Match the local verification baseline.                                                                                              |
| Trivy                      | `0.76.0`       | Match the local configuration-scanner baseline.                                                                                     |

Reuse the reference workflow's setup Actions at these full commit SHAs.

| Action                      | Release  | Commit SHA                                 |
| --------------------------- | -------- | ------------------------------------------ |
| `actions/checkout`          | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `pnpm/action-setup`         | `v6.1.0` | `ea17c68df8912ef543352723c149a84f56e3d413` |
| `actions/setup-node`        | `v7.1.0` | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `hashicorp/setup-terraform` | `v4.0.1` | `dfe3c3f87815947d99a8997f908cb6525fc44e9e` |

Check out the CI event revision or the authorized release SHA with `persist-credentials: false`. Start with `permissions: contents: read` and grant OIDC permissions only to the jobs listed in the permission matrix. Keep additional Actions pinned to reviewed full commit SHAs.

Set up pnpm before Node so `actions/setup-node` can restore the pnpm store. For each Node project job, set `package_json_file` to that project's manifest and `cache-dependency-path` to its repo-relative `pnpm-lock.yaml` with `cache: pnpm`. Run `pnpm install --frozen-lockfile` explicitly from each project directory, including on a cache hit. A shared job can key its store cache on the separate lockfiles it uses and read the common pnpm pin from one of those projects. Check that all three manifests agree on the pnpm pin.

Initialize both Terraform roots with `terraform init -backend=false -input=false -lockfile=readonly` before the existing infrastructure verification scripts. Use their shared offline evaluator for fixture plans. Trusted cloud jobs initialize the canonical AWS backend described below with `-input=false -lockfile=readonly`. Each deployment apply consumes the exact reviewed saved plan by filename. Advance tool or provider pins through reviewed changes.

| Project        | Required credential-free checks                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth           | Frozen install, lint, format check, typecheck, existing tests, build, API and migration ZIPs                                                                              |
| Core           | Frozen install, lint, format check, typecheck, existing unit and integration tests, build, API and migration ZIPs                                                         |
| Frontend       | Frozen install, lint, format check, `pnpm exec tsc --noEmit`, and Next.js build. Its current package has no test script.                                                  |
| DB-config      | Existing Ruff, pytest, build, and ZIP checks with Python 3.13 and the committed `uv.lock`                                                                                 |
| Infrastructure | `gootip-infra/scripts/verify_full.sh`, TFLint, and pinned Trivy configuration scanning. The full script already runs the fast cycle and shares offline Terraform renders. |

Use the existing SPEC 13 Compose service on a disposable PostgreSQL 18 instance with ephemeral fixture credentials. Run `gootip-infra/scripts/local_postgres.sh bootstrap` and then `integration` in the same job. Run the database suites serially as designed and keep their existing fixture guards. CI runs the full project matrix initially so shared changes receive coverage without a path-filter dependency map. Deployment uses the last active release to identify changed service inputs.

### OIDC and permission matrix

Use `aud = sts.amazonaws.com` and exact repository-scoped subject conditions supported by GitHub and AWS. Do not rely on arbitrary OIDC claims that AWS IAM cannot evaluate. Workflow inputs cannot supply another role ARN, repository, account, state key, or environment.

| Principal                                         | Trust and allowed access                                                                                                                                                                                                | Exclusions                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CI planning role                                  | Trusted workflow on `main`; application-state read and scoped lock operations; provider reads required by this Terraform root; private plan write/read                                                                  | No apply permissions, secret-value reads, bootstrap-state access, Lambda invocation, or release publication                          |
| CI release-publishing role                        | Trusted `main` build job; writes to the dev release namespace and reads needed to verify its uploads                                                                                                                    | No Terraform apply, secret-value reads, administrative invocation, or unrelated bucket access                                        |
| CI deployment role                                | Subject bound to the `dev` Environment; reviewed apply jobs; application-state writes and locks; scoped resource-management, exact execution-role passing, and exact qualified Auth/Core deployment-executor invocation | No ordinary master-secret retrieval, direct database credentials, arbitrary role passing, or automatic `lambda_db_config` invocation |
| CI cleanup role                                   | Trusted maintenance workflow on `main`; scoped private-plan object versions only                                                                                                                                        | No apply, secret retrieval, alias modification, state deletion, or administrative invocation                                         |
| Human bootstrap operator (`GootipBootstrapAdmin`) | Existing SPEC 02.1 MFA-protected control-plane access                                                                                                                                                                   | Creates or updates OIDC and CI roles through the bootstrap root; never replaced or assumed by an ordinary workflow                   |

The four CI identities are distinct SPEC 11 OIDC roles, not aliases for the human `GootipTerraformDeploy` role. Their exact names and ARNs are bootstrap outputs and cannot be supplied by workflow inputs. No CI role can create or mutate the OIDC provider; create, update, tag, attach policies to, or change trust for any bootstrap, human, or CI role; or pass any bootstrap, human, or CI role. Exact application runtime-role passing remains subject to the SPEC 02.1 boundary and allowlist.

Roles do not store `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` in GitHub. Grant `id-token: write` only to jobs that actually assume a role. Default `GITHUB_TOKEN` permissions to read-only and expand them only for a documented job need. Disable checkout credential persistence where it is unnecessary.

The `dev` Environment uses `matiasalbarenque` as Required Reviewer, disables Prevent self-review, and allows only `main`. OIDC environment subjects do not themselves encode a branch; the Environment's branch restriction is part of the enforced control. Record settings and verify them through a real approval exercise. Protect workflow, IAM, and migration changes through repository review controls without assuming a second developer exists.

Plan code is reviewed code. Terraform providers, data sources, and build hooks are not automatically safe just because the command is called `plan`. Initial AWS workflows run only an explicitly selected full SHA reachable from authorized `main`, with trusted workflow definitions. Fork PR code is never checked out and executed in an AWS-credentialed job. Do not use `pull_request_target` to bypass this rule. Verify Required Reviewers on the actual repository before enabling applies.

### Backend and environment contract

Preserve the SPEC 02.1 backend contract: `gootip-terraform-state-<ACCOUNT_ID>` with application key `gootip/dev/terraform.tfstate` and bootstrap key `bootstrap/terraform.tfstate`. SPEC 02.1 owns versioning, SSE-S3 encryption, public-access blocking, TLS, separate bootstrap state, native S3 lockfiles, and account guards. Application teardown must not own or remove the state bucket.

Retain the SPEC 02.1 account and environment checks for both provider and backend. Scope state-object access separately from `.tflock` read/write/delete. The plan role's lock access is not permission to mutate application state. Never pass secret values to Terraform or fetch Secrets Manager values through Terraform data sources.

GitHub workflows consume the SPEC 02.1 canonical backend templates and generated account/key contract using OIDC-provided environment credentials, not local AWS profiles. Before `terraform init`, each workflow verifies its STS account and expected role, backend `allowed_account_ids`, canonical bucket/key, Region, and bucket owner. Workflow inputs cannot override the bucket, key, account, role ARN, or backend location, and CI backend configuration must not contain a `profile` setting.

Use non-sensitive dev configuration for region, account, role ARNs, secret references, and backend location. Adapt the current backend rendering for OIDC credentials while keeping its local MFA/profile entry point and canonical account, key, and lock checks.

### Release artifacts and manifest

Use the existing Auth/Core `build:lambda`, `lambda:zip`, `build:migration-lambda`, and `migration-lambda:zip` scripts. Keep the API and runner handlers and their ZIPs separate. Read Auth's committed SQL manifest and Core's packaged TypeORM manifest through their respective contracts. Reuse prior artifact or generation evidence while the inputs it covers are unchanged. Add only missing pipeline checks for ZIP entries, native compatibility, hashes, and size including layers. Keep the 250 MB uncompressed limit and use S3 for workflow releases at every ZIP size.

Record the reviewed SHA, workflow run, target account/region/environment, toolchain and lockfile identity, and per-service input fingerprint, versioned S3 object reference, ZIP hash, function version when published, and migration manifest digest. Capture the previous verified active release for rollback. Store content-addressed ZIPs under `releases/dev/<commit>/<service>/<sha256>/` in private, encrypted, TLS-only storage. Verify existing bytes before reusing an object. Keep the active artifact and alias for unchanged service inputs even when the repository SHA changes.

For workflow releases, pass the exact S3 object version and code hash to Terraform. Retain existing local ZIP inputs for the manual path. Account for every enabled artifact that Terraform reads during a real plan, including the DB-config ZIP and the RDS CA layer ZIP and checksum where enabled. Reuse their approved inputs and existing verification. Ordinary releases must preserve them. Compare existing input bytes and configuration against the active release before applying.

### Private plan record

Store binary plans, complete machine-readable plans, and private review material under a separate private plan namespace with access and retention distinct from ordinary release artifacts. Never upload them through public GitHub Actions artifacts or paste them into PR comments.

| Field                                                               | Required binding                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `plan_id`, `phase`, `created_at`, `expires_at`                      | Unique preparation/activation plan; maximum validity 24 hours        |
| `commit_sha`, `environment`, `aws_account_id`, `region`             | Exact authorized deployment identity                                 |
| `terraform_version`, `provider_lock_sha256`, `configuration_sha256` | Planning/applying configuration and tool identity                    |
| `release_manifest_sha256`, `artifact_sha256`                        | Exact verified release inputs                                        |
| `plan_sha256`, `object_key`, `object_version`                       | Exact private saved plan location and bytes                          |
| `summary_sha256`, `sensitive_changes`, `destructive_changes`        | Reviewed summary and flagged change categories                       |
| `approval_reference`                                                | Environment approval/run identity associated with applying this plan |

Reviewer instructions must provide authorized private access to the full plan. Public job summaries show only an allowlisted status, resource-action counts, plan identity/digest, and approval instructions. Do not print raw `terraform show`, full JSON, state, environment dumps, or unfiltered errors to public logs. Capture tool output privately and publish sanitized diagnostics.

Treat deletes and replacements as destructive. Also flag sensitive in-place changes, including IAM/trust expansion, public networking, backend protection, RDS upgrades, administrative code, or loss of backup controls. Require an explicit documented authorization tied to the plan digest; an ordinary approval is not implicit permission for an unexpected destructive change.

Apply downloads and verifies the exact saved plan and original inputs. An expired plan, changed artifact, checksum mismatch, changed commit/configuration, or stale state stops the job. Never recover by regenerating and applying a different plan without new review. Terraform's state locking and stale-plan rejection remain authoritative.

### Terraform ownership and activation protocol

Terraform owns Lambda code, configuration, versions, aliases, and API integrations. First adopt the currently serving Auth and Core code and configuration in a separately reviewed transition. Publish or identify a matching immutable version for each, verify code and configuration, then switch the existing integrations in place to their stable application aliases with qualified invocation permissions. Preserve the shared API origin, explicit routes, and JWT authorizer. Capture the adopted versions as the initial active release.

Use `prepare` and `activate` inputs to separate migration preparation from application activation. Preparation pins the active code, configuration, versions, and routes. It can publish a candidate runner when required. Each migration must leave the serving release compatible during the approval wait and if activation is interrupted. Ordinary release plans preserve runtime identities, private networking, database protection, and administrative code. Terraform owns alias changes, including rollback.

Use each existing runner's qualified invocation contract. Auth follows SPEC 04 and excludes the baseline alias. Core follows Core SPEC 06 and uses its exact `deployment` alias. Verify the qualifier points to the recorded candidate version and check the executed version and returned manifest/history fields. Use each service's own `validate` and `apply` payloads. Retain database advisory locks and serialize dev workflow runs across approval waits with `cancel-in-progress: false`. Coordinate with manual operators to avoid concurrent deployments, rotations, bootstrap, or migrations.

Required migrations must complete and have valid history before activation is planned. A Lambda `FunctionError`, manifest or version mismatch, invalid response, or unknown result blocks activation. Revalidate current history after activation approval and before applying. Reconcile an uncertain result with the same verified runner before retrying. Code rollback moves an alias to a compatible prior version through a reviewed plan. Database history, passwords, and signing state follow their own recovery procedures.

Record observed alias targets separately from smoke-test status. If activation succeeds but verification or record publication is interrupted, reconcile Terraform state, alias targets, and migration history before the next release. Use dedicated dev test credentials in the protected smoke job and keep credentials, tokens, and test data out of logs and artifacts.

## Implementation plan

### A. Credential-free CI

1. Add CI for pull requests and pushes to `main` using the pinned toolchain. Run existing checks and the shared disposable PostgreSQL integration path. Verify a fork PR, a cold-cache install, and that a failed required check fails the workflow.
2. Wire the existing Auth/Core artifact scripts into CI and release builds. Verify the four ZIPs, hashes, manifests, architecture where relevant, and Lambda size limits. Define the active-release record and compare affected service inputs against it.

### B. Authorized AWS setup

3. Resolve or reconcile the current offline IAM guardrail failures. Verify GitHub reviewer support and settings, then provision the narrowly scoped OIDC roles through the reviewed bootstrap root. Reuse existing backend and IAM boundaries and verify denied trust and privilege escalation paths.
4. Add private release and plan storage under the application root through the reviewed operator path. Verify TLS, public-access denial, encryption, versioning, and role-scoped object access. Keep the Terraform state bucket independent.
5. Add manual planning on reviewed `main` using the canonical backend and existing account guards. Verify a private saved plan, sanitized summary, sensitive and destructive change handling, and exact-plan verification before apply.

### C. Migration-gated release

6. Adopt the live Auth and Core releases into stable aliases through a separately reviewed Terraform transition. Verify the unchanged API origin, route and authorizer behavior, and adopted versions.
7. Add the serialized manual release workflow. Run checks and builds before cloud jobs, publish the exact artifacts for the reviewed SHA, and confirm that unchanged services keep their active inputs.
8. Generate the preparation plan and apply its exact file after the first `dev` approval. Prove preparation leaves both serving releases and routes intact and that migration prerequisites still hold. Stop on missing bootstrap prerequisites.
9. Validate or apply required migrations through the corresponding qualified runner and verify the recorded version, manifest, and history. Block activation on a failed or unresolved outcome.
10. Generate the activation plan and require a fresh `dev` approval. Revalidate the migration result and apply the saved plan. Verify the active aliases and run bounded smoke checks against the existing API. Cover JWKS, database-backed Auth, a public Core catalog read, an authorized protected Core operation using disposable data, and denial of an unauthorized write.

### D. Retention and recovery

11. Remove consumed plans promptly and sweep abandoned plan object versions within 24 hours with the plan-only cleanup role. Monitor overdue cleanup and retain sanitized reports for 30 days. Keep active, alias-referenced, and at least one previous stable release with its artifacts. Document operator-reviewed pruning of older releases and Lambda versions after checking references, state ownership, and S3 object versions.
12. Exercise the two independent approval gates once on a reviewed dev release. Test failure, cancellation, stale-plan, and rollback paths with offline or non-mutating fixtures where possible. Record bounded live evidence for the actual release and complete the recovery runbook. Reuse the existing dev budget and alerts. Check current credits, expiry, and the incremental storage, workflow, and migration cost before enabling routine use.

## Acceptance criteria

### CI

- [ ] PRs and `main` pushes run the pinned credential-free checks, including the shared PostgreSQL fixtures and both Terraform roots. Failures block the required check.
- [ ] Each Node project installs from its frozen lockfile even on a cache hit. Node comes from `.nvmrc` and pnpm pins agree across projects.
- [ ] The four release ZIPs pass layout, reproducibility, architecture, size, and digest checks. Migration manifests retain their service-specific validation.

### AWS and approval

- [ ] Offline IAM guardrails are clear before AWS workflow enablement. Bootstrap owns OIDC trust and roles. CI jobs cannot alter that trust, broaden PassRole, read AWS secret values, trigger administrative bootstrap or rotation, or execute untrusted PR code with AWS credentials.
- [ ] Trusted workflows consume the existing account, region, and state contract using OIDC. The plan role cannot apply. The cleanup role can remove private plans only.
- [ ] Dev deploys only by manual dispatch on trusted `main`. Each apply uses the same Terraform version and exact saved file reviewed for its phase. A real workflow exercise demonstrates two separate approvals.
- [ ] Review material remains private. Public summaries and failure output are sanitized. Mismatched, stale, expired, unexpected, or sensitive plans stop pending the required review.

### Release and operation

- [ ] Adoption preserves the existing API and routes traffic through Terraform-owned stable aliases. Preparation leaves the serving code and configuration intact.
- [ ] Qualified Auth/Core migrations use their own protocol and verified artifact/history identities. Failure or uncertainty prevents activation, including after the approval wait. Unchanged services retain their releases.
- [ ] The dev smoke checks pass against the recorded release and preserve existing authorization, runtime hardening, and aggregate connection headroom.
- [ ] Used and abandoned private plans are removed within the required retention window. Reports and rollback inputs are retained. Recovery covers failed migration, smoke failure, and cancellation without automatic SQL rollback.
- [ ] Incremental pipeline consumption fits the existing dev budget and account constraints.

## Decisions

- Use the complete project check matrix initially. Add path filtering only if measured CI cost or time warrants it. Keep service-level release comparison to avoid unnecessary deploys.
- Reuse the existing local scripts, package builders, migration executors, backend, and operational evidence. Make CI responsible for orchestration, artifact identity, and release checks.
- Use the current deployed API as the alias-adoption baseline. Preserve private plan review, one approval per apply, and independent migration verification.
- Automate private plan expiry. Keep release and Lambda-version pruning operator-reviewed until retention volume justifies dedicated automation. Preserve protected rollback inputs.

## References

- [AWS OIDC in GitHub Actions](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).
- [GitHub deployment environments and protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
- [Terraform saved plans](https://developer.hashicorp.com/terraform/cli/commands/plan).
- [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3).
- [AWS Lambda aliases](https://docs.aws.amazon.com/lambda/latest/dg/configuration-aliases.html).
- [AWS Lambda versions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html).
