# SPEC 07 — Lambda IAM and Network Security Baseline

> **Status:** Implemented
> **Depends on:** SPEC 02.1, SPEC 02.2, SPEC 03, SPEC 04, SPEC 05, SPEC 06
> **Date:** 2026-10-20
> **Objective:** Establish the non-negotiable IAM and private-network baseline for each existing Lambda without freezing the final least-privilege matrix before application development is complete.

## Why this spec exists

Development still needs separate identities, private database access, exact secret boundaries, and protection from administrative privilege escalation. Final log, VPC-interface, endpoint-policy, and egress hardening depends on the complete set of application Lambdas and their observed behavior.

This specification keeps the controls that must exist throughout development. SPEC 07.1 owns final least-privilege hardening after `gootip-core`, its database contract, and every required migration executor exist.

SPEC 02.1 remains authoritative for the `gootip` source user, `GootipBootstrapAdmin`, `GootipTerraformDeploy`, the runtime permissions boundary, exact PassRole resources, account guards, and backend access. This specification only establishes runtime controls inside that ceiling.

## Scope

**In:**

- Independent execution roles and security groups for authentication, auth migrations, and `lambda_db_config`.
- Lambda-service-only execution-role trust and the bootstrap-owned runtime permissions boundary.
- Exact secret ARN allowlists derived from each function's effective configuration.
- No secret-value writes, IAM administration, arbitrary role passing, or cross-function administrative invocation from application code.
- Removal of every application reference and permission for the RDS master secret.
- Private RDS placement with no public ingress and PostgreSQL ingress only from approved client security groups.
- A private Secrets Manager interface endpoint with private DNS and HTTPS ingress only from approved client security groups.
- No NAT gateway, Internet gateway, public subnet, or Logs VPC endpoint.
- Managed Lambda logging and VPC permissions as temporary development baselines where final replacement policies are not yet available.
- Accurate comments that identify temporary broad permissions and point to SPEC 07.1.
- Focused positive and negative checks for the baseline authorization boundaries.

**Out of scope (for SPEC 07.1):**

- Final per-function CloudWatch Logs statements and removal of redundant basic execution policy attachments.
- Final replacement or consolidation of Lambda VPC interface permissions.
- Conditional EC2 denials using `lambda:SourceFunctionArn`.
- Final client security-group egress rules for PostgreSQL and Secrets Manager.
- The exact Secrets Manager endpoint principal, action, and resource policy.
- The complete administrative invocation revoke/re-enable runbook.
- The final permission matrix for `gootip-core` and its migration executor.
- Final IAM simulation, deployed negative checks, and wildcard inventory.

## Data model

### Baseline permission matrix

| Principal                     | Required secret reads                                               | Explicit exclusions                                                    |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Authentication execution role | Effective application secret and `auth_runtime` credential only     | RDS master, migrator, administrative, IAM, and secret-write access     |
| Administrative execution role | Exact secrets required by the reviewed `lambda_db_config` operation | Arbitrary AWS administration, role passing, and unconfigured secrets   |
| Auth migration execution role | `auth_migrator` credential only                                     | RDS master, runtime, application-signing, IAM, and secret-write access |

The exact administrative secret list comes from the enabled reviewed operation. An optional operator credential is present only while its separate runbook explicitly enables that operation.

Secret ARNs are non-sensitive references. Terraform never creates, reads, logs, or stores a secret value.

### Baseline network contract

- Every Lambda uses its own client security group.
- RDS has no public route or public ingress.
- RDS accepts PostgreSQL TCP `5432` only from approved client security groups.
- The Secrets Manager endpoint accepts HTTPS TCP `443` only from approved client security groups.
- Client egress may remain at the narrowest already-proven development rule until SPEC 07.1 derives the final destination-specific graph.
- The VPC has no public egress path, so a temporary broad client egress rule does not create Internet reachability.

### Files and ownership

Implementation may update `iam.tf`, `network.tf`, `lambda.tf`, `variables.tf`, `README.md`, focused tests, and related convention comments. SPEC 06 owns the managed log groups. SPEC 05 owns the effective authentication secret references. SPEC 02.1 owns deployment identities, boundaries, and PassRole allowlists.

## Implementation plan

1. Inventory the current authentication, administrative, and auth-migration roles, trust policies, security groups, secret references, managed-policy attachments, and invocation paths.
2. Preserve or create one execution role and one client security group per function. Attach the bootstrap-owned runtime boundary and retain trust only for `lambda.amazonaws.com`.
3. Reconcile each role's `secretsmanager:GetSecretValue` resources with its effective configuration. Remove master-secret access from application and migration roles and keep all secret-write actions absent.
4. Verify that application and migration roles have no IAM administration, arbitrary PassRole, or permission to invoke `lambda_db_config` or another privileged function.
5. Preserve private RDS and Secrets Manager endpoint ingress from approved client groups only. Confirm that no public networking, NAT, or Logs endpoint is introduced.
6. Mark temporary managed logging, VPC-interface permissions, and broad development egress accurately. Link each deferred control to SPEC 07.1 instead of claiming that no wildcard or broad rule exists.
7. Run focused Terraform validation and baseline authorization checks. Hand the exact role, secret, security-group, and managed-policy inventory to SPEC 07.1.

## Acceptance criteria

- [x] Authentication, administration, and auth migrations use independent execution roles and client security groups.
- [x] Every execution-role trust policy permits only the Lambda service.
- [x] Every runtime role uses the bootstrap-owned permissions boundary required by SPEC 02.1.
- [x] Authentication can read only its effective application and `auth_runtime` secrets.
- [x] Authentication cannot read the RDS master, migrator, operator, or unrelated future secrets.
- [x] Auth migrations can read only the `auth_migrator` secret.
- [x] Administrative secret reads match the exact currently enabled operation.
- [x] No runtime role can write secret values, administer IAM, or pass arbitrary roles.
- [x] Application and migration principals cannot invoke `lambda_db_config` or another privileged function.
- [x] RDS is private and accepts PostgreSQL only from explicitly approved client security groups.
- [x] The Secrets Manager endpoint has private DNS and accepts HTTPS only from explicitly approved client security groups.
- [x] The VPC has no NAT gateway, Internet gateway, public subnet, or Logs VPC endpoint.
- [x] Temporary managed policies and broad development rules are documented accurately and assigned to SPEC 07.1.
- [x] No change broadens or replaces the SPEC 02.1 human roles, runtime boundary, backend access, or PassRole allowlist.
- [x] Terraform formatting, validation, focused policy tests, and focused network tests pass.

## Decisions

- **Yes:** retain separate roles and security groups during development. Deferring that separation would create a larger and riskier final refactor.
- **Yes:** retain exact secret ARNs and the application master-secret prohibition from the first deployment.
- **Yes:** allow reviewed AWS-managed Lambda logging and VPC policies as an explicit temporary baseline.
- **Yes:** keep RDS and Secrets Manager private throughout development.
- **No:** finalize policies for `gootip-core` before its source, schema, runtime credential, and migration contract exist.
- **No:** claim that the development baseline is the final least-privilege state.
- **No:** introduce secret values, public networking, new KMS keys, or broader human/deployment IAM.

## AWS Free plan and cost constraints

This baseline uses existing IAM, VPC, RDS, Lambda, CloudWatch, and Secrets Manager resources. It introduces no NAT gateway, additional interface endpoint, Paid plan upgrade, or persistent administrative environment.

## Risks

| Risk                                                              | Mitigation                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Temporary managed policies are mistaken for final least privilege | Label each attachment and broad rule as a SPEC 07.1 deferral and keep 07.1 as a deployment dependency. |
| A new function reuses an existing role or client group            | Require a separate identity and security group as part of that function's own implementation spec.     |
| Administrative secret access remains enabled longer than needed   | Bind optional secrets to the separately reviewed operation and verify their absence when disabled.     |
| Future core planning invents privileges before code exists        | SPEC 07.1 cannot be approved until the actual core contract can be inventoried.                        |

## References

- [AWS Lambda execution role](https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html).
- [AWSLambdaVPCAccessExecutionRole](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSLambdaVPCAccessExecutionRole.html).

## What is **not** in this spec

- Final per-log-group policies, source-function EC2 denials, endpoint-policy hardening, or destination-specific client egress.
- Final `gootip-core` or core-migration IAM and network permissions.
- Core implementation, core deployment, CI/CD, new KMS keys, NAT, or secret-value management.
