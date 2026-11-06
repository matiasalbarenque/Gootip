# SPEC 10 — Initial Dev Auth and Core API Deployment

> **Status:** Implemented
> **Depends on:** SPEC 01 (historical implementation reference), SPEC 02.1, SPEC 02.2, SPEC 03, SPEC 04, SPEC 05, SPEC 06, SPEC 07, SPEC 07.1, SPEC 08, SPEC 09, SPEC 12, SPEC 13, SPEC 14; gootip-core SPEC 01, SPEC 02, SPEC 03, SPEC 04, SPEC 05, SPEC 06, SPEC 07
> **Date:** 2026-10-30
> **Objective:** Deploy Auth and Core behind one development HTTP API with explicit public/protected routes, isolated runtime credentials, and verified security and capacity gates.

## Why this spec exists

SPEC 02.2 deliberately stops after the private network, protected RDS instance,
Secrets Manager endpoint, and shared CA layer. The intervening specifications
remove the application's master credential, create the reviewed schema, and
prepare the controls required before public traffic exists.

This specification retains the deferred portion of the former SPEC 14. It is
the first deployment of the Auth and Core APIs behind one HTTP API, reusing the
existing Terraform root and foundation resources. Core deployment is now owned
by this spec rather than a separate future deployment spec.

## Completion boundary and handoff to SPEC 10.1

SPEC 10 completes when both APIs are deployed, their route/JWT security and
private runtime controls pass basic live checks, backups/protection are verified,
and the deployment handoff is recorded. SPEC 10.1 depends on that completed
handoff and owns bounded traffic, throttling/connection-peak measurement, live
credential rotation, controlled failures and recovery exercises. SPEC 10 does
not depend on SPEC 10.1 for its own completion.

Security is a first-deployment gate: exact roles/secrets, verified TLS, authorizer
coverage, public data visibility and denied privileged/cross-service access must
pass here. Do not defer these checks to expose an unverified API. Failed basic
checks block completion and require the reviewed deployment recovery procedure.

Completion here makes the dev deployment available for SPEC 10.1; it does not
claim operational acceptance or readiness for SPEC 11 cloud automation. SPEC 11
requires both deployment and operational evidence. SPEC 02.1 source-user cutover
remains separately owned and disabled.

### Basic-check limits and private handoff

Keep the agreed **1,000-request** traffic/security allowance across the SPEC 10
basic checks and subsequent SPEC 10.1 traffic campaign. Reserve at most **140
application requests** here, including warm-up, sign-in, JWT/session requests,
route/security probes and retries, leaving the 860-request phase allowance.
This is a cap, not a target; reuse valid checks rather than filling the budget.
Limit in-flight requests to **5 per service**. Run no load generator or intentional
credential failure in this spec. If required basic checks cannot complete within
the allowance, stop for review rather than skip them or silently reset the cap.

Monitor client connections through verified-TLS read-only SQL every **2 seconds**.
Stop at **50 connections**, lost monitoring, **3 consecutive unexpected 5xx**,
forbidden access or sensitive-data exposure. Apply the post-warm-up p95 cutoff of
**2 seconds for 30 seconds** when enough observations exist; a small smoke sample
cannot establish operational latency acceptance. SPEC 10.1 performs that exercise.
Expected negative authorization checks are recorded separately from failures.

Write ignored local `artifacts/validation/spec10-handoff.json` with:

- Reviewed revision, artifact digests, API origin and exact service configuration
  bindings; full identifiers remain private.
- Successful per-route authentication/authorization, identity/TLS and relevant
  positive/negative IAM checks; baseline backups/protection and no-change plans.
- Initial-admin bootstrap outcome without credentials or personal data.
- Basic-check request count, recorded failures/cold starts, connection observations
  and remaining allowance `1000 - basic_check_requests`.
- SPEC 10.1's explicitly pending operational checklist and recovery ownership.

No new application table or AWS resource is introduced for this evidence. An
expired/rejected campaign cannot be resumed by zeroing its counters. A new
reviewed campaign must document its budget and evidence bindings explicitly.

## Prerequisite handoff (2026-10-30)

At drafting, this section recorded completed prerequisite work only; it did not
approve public activation or claim new live AWS evidence. The implementation and
acceptance evidence are recorded in the completed handoff below.

| Source                   | Reusable evidence                                                                                                                                     | Remaining owner / gate                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPEC 03, 04, 05          | Dev bootstrap, Auth migration execution, and restricted runtime credential implementation                                                             | This spec verifies current roles, secret references, exact migration manifest/history, and applicable deferred operational checks before activation.                                                       |
| SPEC 07.1                | Phases A/B implemented; scoped Logs/VPC policies, exact secret policies, endpoint/network controls, and removal of broad execution-policy attachments | This spec owns Auth and Core Phase C: runtime secret stages, verified TLS, native logs, connectivity, and positive/negative authorization.                                                                 |
| SPEC 08                  | Shared Auth rate limiter and traffic configuration implemented                                                                                        | SPEC 10 verifies baseline traffic controls and trusted source-IP handling; SPEC 10.1 owns bounded traffic, shared-counter/failure exercises and connection peaks.                                          |
| SPEC 09                  | Auth/Core refresh implementations and isolated local password-rotation tests; Auth signing-key compatibility tests                                    | SPEC 10 owns current RDS capacity and initial runtime validation; SPEC 10.1 owns live refresh/rotation and failure evidence. Local non-TLS containers do not prove AWS stage behavior or verified RDS TLS. |
| SPEC 12, 13              | PostgreSQL 18 upgrade and shared local PostgreSQL test setup implemented                                                                              | Reuse compatible local test evidence; reconfirm current RDS settings only at the live gate.                                                                                                                |
| SPEC 14; Core SPEC 06/07 | Administrative handoff with recorded evidence limitations; private Core migrations and catalog column update implemented                              | Count the deployed Core migration executor in shared capacity. SPEC 10 owns Core API creation, concurrency allocation and authorization; SPEC 10.1 owns live rotation.                                     |

SPEC 14's accepted historical evidence gaps must not be reconstructed by
rerunning bootstrap. Its unverified logging/procedure compatibility is not a
passed credential-safety check. Before any credential-changing operation here,
verify current effective RDS logging and the authorized secure procedure.
Admin secret/TLS/log runtime checks after SPEC 07.1's policy replacement remain
residual risk for its next necessary administrative execution, not an API
activation prerequisite. Do not invoke Admin as a policy probe.

## Scope

**In:**

- Reuse of the existing application Terraform root, canonical
  `gootip/dev/terraform.tfstate`, foundation resources, and historical SPEC 01
  resource identities.
- A full refresh-free and normal plan proving that the SPEC 02.2 foundation is
  stable and that only reviewed deferred resources and in-place hardening
  changes remain.
- Separate bootstrap-root authorization for any final deployment actions,
  runtime roles, boundaries, exact PassRole resources, and invocation grants
  not already approved by earlier specs.
- Verification that SPEC 03 administrative bootstrap and SPEC 04 auth
  migrations succeeded and still match their exact role, manifest, checksum,
  and history contracts.
- Verification that required bootstrap-owned secret containers have current
  versions without reading or exposing their values.
- Build and inspection of `gootip-auth/lambda.zip` and `gootip-core/lambda.zip`
  from the exact reviewed source revision. Verify Auth SPEC 04 and Core SPEC 06/07
  migration history against their respective artifacts.
- A no-traffic API preparation step when required to obtain the generated HTTP
  API origin before setting `BETTER_AUTH_URL`.
- Deployment of independent Auth/Core execution roles, Lambdas, scoped invocation
  permissions, integrations, explicit HTTP API routes, JWT authorizer, stage,
  CORS, access logging, throttling, alarms, and reserved concurrency.
- First activation using only the application signing secret and
  `auth_runtime` credential for Auth, and only `core_runtime` for Core. Neither
  API may access master, operator, migrator, or the other API's secrets.
- Basic live validation of private connectivity, verified TLS, exact runtime
  identities/permissions, IAM denials, endpoint policy, logs, alarm configuration,
  API/JWT behavior and the pre-activation connection budget.
- Verification of backup availability, deletion protection and deployment recovery
  instructions; no restore or induced-failure exercise is performed here.
- Sanitized initial-deployment evidence and request accounting handed to SPEC 10.1
  and the separately owned SPEC 02.1 source-user cutover gate.

**Out of scope (for future specs):**

- SPEC 10.1 traffic/burst tests, shared-limiter stress/storage-failure exercises,
  live password/signing rotation, freeze/stale/mismatch simulation, measured
  simultaneous refresh overlap, and optional private RDS restore exercises.

- Recreating, replacing, or migrating the bootstrap or application backend.
- Creating another VPC, RDS instance, CA layer, secret container, database
  role, or migration system.
- Reading, generating, rotating, or managing a secret value through Terraform.
- Automatic deployment, GitHub OIDC, release automation, or saved-plan storage;
  SPEC 11 owns those capabilities.
- Source-user cutover; SPEC 02.1 Phase B remains its owner.
- Custom role-management features, frontend hosting, staging, production, cross-account
  deployment, NAT, RDS Proxy, Multi-AZ, or a Paid plan upgrade.

## Data model and activation gates

### First-deployment phases

| Phase      | Allowed result                                                                                                                                     | Forbidden result                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `prepare`  | Stable foundation, optional API shell without routes, exact public origin, managed logs, reviewed runtime role/configuration                       | Public route, serving Lambda, master-secret reference, unapplied migration                    |
| `activate` | Reviewed service artifacts, isolated runtime credentials, integrations, explicit public/protected routes, JWT authorizer, throttling, CORS, alarms | Foundation replacement, secret value in Terraform, uninitialized schema, privileged DB access |

If the HTTP API origin is not known before creation, preparation may create
only the API shell needed to obtain it. It must expose no route or integration.
The exact HTTPS origin is then supplied as the validated `BETTER_AUTH_URL`
without `/api/auth` or a trailing slash. Activation requires a new saved plan
and separate approval.

### Shared HTTP API and endpoint contract

Reuse `aws_apigatewayv2_api.main` with the `$default` stage and payload format
2.0. Keep the existing `gootip-auth-dev` physical API name to avoid an unrelated
rename. Preserve full request paths; Core already uses the `/api` prefix.
Replace the deferred catch-all `$default` route with explicit routes:

| Method and path                                                  | Integration | Gateway authorization / application policy                                    |
| ---------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `ANY /api/auth`, `ANY /api/auth/{proxy+}`                        | Auth        | No Gateway JWT requirement; Better Auth owns authentication/session behavior. |
| `GET /api/health`                                                | Core        | Public.                                                                       |
| `GET /api/categories`, `GET /api/categories/{id}`                | Core        | Public.                                                                       |
| `GET /api/products`, `GET /api/products/{id}`                    | Core        | Public; exclude drafts/archived data even when a token is supplied.           |
| `POST /api/categories`, `PATCH /api/categories/{id}`             | Core        | JWT authorizer; Core requires `editor` or `admin`.                            |
| `GET /api/admin/products`, `POST /api/admin/products`            | Core        | JWT authorizer; Core requires `editor` or `admin`.                            |
| `GET /api/admin/products/{id}`, `PATCH /api/admin/products/{id}` | Core        | JWT authorizer; Core requires `editor` or `admin`.                            |

Review this matrix against controllers at implementation time. Unknown paths
and methods must not fall through to Auth or an unauthenticated Core proxy.
Use Gateway CORS with the reviewed frontend origin, methods and headers; verify
preflight works without a bearer token. Do not confuse the `$default` stage
with a catch-all route. No Lambda Function URL or other public Core entry point
may bypass the authorizer. Scope each Lambda invocation permission to this API's
intended route set.

### JWT issuer and catalog authorization gate

Use the Auth-issued RSA JWT, not its opaque session token. Configure the JWT
authorizer with the exact `BETTER_AUTH_URL` issuer, `JWT_AUDIENCE`, and
`$request.header.Authorization`. Prove issuer discovery and public JWKS retrieval
from API Gateway with the installed Better Auth version. The current app exposes
its JWT plugin under `/api/auth`; do not assume root OIDC discovery already
exists. If required, add only a compatible discovery endpoint publishing the
exact issuer and existing public JWKS URI, document its explicit unauthenticated
Auth route, and test it before enabling protected Core routes. Never substitute
unverified token decoding or a Lambda authorizer as an implicit workaround.

Core accepts identity only from payload-v2 `requestContext.authorizer.jwt.claims`.
Gateway validates signature, issuer, audience and time claims; Core checks `sub`
and the single `role` claim. Invalid/missing JWTs are denied by Gateway; valid
identities with `user`, missing, or unknown role receive Core `403`. Missing
trusted identity is denied by Core as well. Test expired, forged, wrong-issuer
and wrong-audience tokens, plus sequential/concurrent identity isolation.

Auth now implements Better Auth 1.7.7's Admin plugin and explicit JWT role
issuance. Public registration defaults to `user` and rejects a supplied role.
`editor` has no Auth user/session administration permissions; `admin` can assign
roles through the existing authenticated Admin plugin endpoints. Core alone
interprets `editor`/`admin` as catalog management permissions. JWT roles are an
issuance-time snapshot and can remain valid for the existing 15-minute lifetime
after a role change; immediate JWT revocation is not claimed.

The additive `000003-auth-admin-roles.sql` migration and its manifest are required
before deploying this Auth configuration. Local fixtures `user@gootip.local`,
`editor@gootip.local`, and `admin@gootip.local` are created through the guarded
`pnpm local:seed-users` command. Isolated PostgreSQL tests verify real JWT
subject/role claims, rejected signup role injection, and denied user/editor
role assignment. Local fixtures and their ignored password file are never
packaged or copied to AWS. They are not Gateway authorization evidence.

Before activation, review the Auth changes and execute the initial-admin
application bootstrap defined below through Better Auth.
Client-supplied roles, synthetic claims, and manually forged JWTs cannot satisfy
end-to-end deployment acceptance. No custom role-management UI/API is added.
Protected routes remain disabled until real issued editor/admin tokens pass
Gateway and Core live authorization tests.

### Initial administrator application bootstrap

Treat the first application administrator as an explicit deployment bootstrap
step after the database roles/schema bootstrap and Auth migration `000003`.
The existing Python `lambda_db_config` retains its PostgreSQL role/schema/grant
contract; do not rerun it to create a Better Auth user or add application-account
creation to Terraform or application startup.

Implement an operator-only `pnpm bootstrap:admin` command in `gootip-auth` using
the installed Better Auth 1.7.7 trusted server API `auth.api.createUser`, the same
creation path as the documented `create-admin` CLI. Reuse the existing Auth
configuration so hashing, hooks and the fixed `admin` role stay consistent.
No additional Lambda, public bootstrap endpoint or third-party dependency is
required. Keep the existing local fixture command restricted to localhost.

The operator supplies the real admin email/name, generates a unique random
32-character password in their password manager, and enters it twice through a
masked prompt. Abort on mismatched confirmation before any user write. Keep the
recoverable copy in that password manager. The bootstrap holds the password only
in process memory for Better Auth creation and the sign-in check; Better Auth
stores its password hash in the credential account, never the plaintext password.
Do not put passwords in command arguments, environment files, Terraform, Lambda
events, logs, response artifacts or the local-fixture password file. The command
reports success without printing the password. Do not copy the local admin or
create additional AWS user/editor fixtures as part of this bootstrap.

Run with the existing MFA-protected operator profiles and reviewed exact
secret references. Retrieve only the existing Auth signing/runtime credentials
into process memory where the configuration needs them; connect as `auth_runtime`
through the reviewed private tunnel with the RDS CA and certificate hostname
verification. The database-operator role remains responsible for opening the
tunnel, not application writes. Use a one-connection application pool. No master
or migrator credential, new secret container, or permanent bootstrap IAM grant
is required. If existing authority cannot read a required exact reference, stop
for the separately reviewed capability change rather than widening permissions.

Serialize this manual procedure. Check existing application administrators and
the requested email before creation. If the same admin already exists, report
`no_changes` without resetting the password. If another admin exists, or that
email belongs to a non-admin account, stop for explicit review instead of
creating a second initial admin or silently promoting a user. Password recovery
and subsequent authorized administrator creation require a separately authorized
Better Auth procedure, not a rerun that overwrites credentials. Email password
recovery is not configured in the current Auth implementation; do not claim an
automatic recovery path exists or add an email provider implicitly in this spec.

Verify role and password sign-in through Better Auth, revoke the verification
session, close the pool and tunnel, and record only sanitized success/no-change
or failure. Later public acceptance uses a real token issued for this AWS admin.
The operator may assign `editor` through authenticated Admin endpoints as needed;
that is distinct from the one-time creation of the first administrator.

### Core runtime deployment contract

Introduce Core API resources in the existing flat root: `lambda.tf`, `iam.tf`,
`network.tf`, `api-gateway.tf`, `observability.tf`, `variables.tf`, and `outputs.tf`.
Bind the function `gootip-core-dev`, role `gootip-core-dev-lambda`, client security
group `gootip-core-dev-client`, and log group `/aws/lambda/gootip-core-dev` to exact
account/Region ARNs in the reviewed plan. Preserve the Auth resource identities.
Use Node.js 24 ARM64, `dist/lambda.handler`, the shared CA layer, and private subnets.

Core receives only the existing `CORE_RUNTIME_SECRET_ARN` at AWSCURRENT and uses
`core_runtime`, `POSTGRES_SSL_MODE=verify-full`, and
`POSTGRES_CA_PATH=/opt/certs/rds-ca-bundle.pem`. It does not read Auth signing keys.
Apply SPEC 07.1's independent scoped Logs/VPC policies, boundary, exact PassRole
allowlist, conditional source-function EC2 Deny, and endpoint principal/secret pair.
Core egress is only 5432 to RDS and 443 to Secrets Manager; add only its dedicated
client SG to the matching ingress rules. Add no NAT, public subnet, Logs endpoint,
new secret container, or database role.

Create Core runtime error/throttle monitoring and extend API 5xx monitoring using
SPEC 06 retention and the existing notification topic. Logs must omit tokens,
claims, bodies, SQL and secret values. Review any topic-policy/boundary extension
with exact resource ARNs before activation.

### Authentication runtime contract

The deployed function receives only these secret references:

| Reference                                 | Purpose                          |
| ----------------------------------------- | -------------------------------- |
| Bootstrap-owned application secret ARN    | `BETTER_AUTH_SECRET`             |
| Bootstrap-owned `auth_runtime` secret ARN | PostgreSQL username and password |

`DB_MASTER_SECRET_ARN`, master username/password, migrator credentials, and
unrelated future credentials are absent from the function environment and effective IAM.
The database connection uses the RDS hostname, `sslmode=verify-full`, and
`/opt/certs/rds-ca-bundle.pem`.

### API hardening activation checklist

The disabled Auth role is not yet an active Secrets Manager endpoint principal.
The activation plan must add Auth's exact principal and two configured
secret ARNs plus Core's independent principal and its one runtime secret ARN,
preserving all enabled administrative and migration consumers.
Verify signing-secret reads at AWSCURRENT/AWSPREVIOUS, optional missing-previous
handling separately from access denial, and runtime reads at AWSCURRENT.
Deny unrelated secrets and secret writes through the effective identity,
boundary, and endpoint-policy intersection.

Verify the final scoped log-group policy and all six VPC execution actions
(including `ec2:DescribeSubnets`) under the configured Region and boundary.
Each conditional EC2 Deny must match its own unqualified source-function ARN and
not match absent source-function context. Reuse SPEC 07.1's documented-permission
method; a forced ENI create/delete cycle is not required. Verify actual Auth and Core
connectivity, TLS, and log delivery after deployment without restoring broad
AWS-managed execution policies.

### Shared capacity and refresh contract

Reconfirm `max_connections`, `superuser_reserved_connections`, and
`reserved_connections` through verified-TLS SQL before activation. Subtract both
reserved values to obtain usable client capacity; historical `81 - 3 - 2 = 76`
is not a current measurement. Retain Auth pool maximum 2 and reserved concurrency
5: 10 ordinary connections and up to 10 additional during two-generation
replacement are planning estimates, not a global cap across retained environments.

Update the SPEC 09 runbook inventory with both deployed migration executors,
unreserved Auth migration/admin invocations, operator/other sessions, retained
idle and deployment/version overlap, and explicit headroom. Core migrations
reserve concurrency 1 with pool maximum 1. Core API pool maximum remains 2.
The initial Core reserved concurrency is **5**, matching Auth, with independent
pool maximum **2** for each service. This supports the catalog's greater request
frequency in an e-commerce simulation without requiring larger pools. Auth can
also serve session and JWT requests after login; neither allocation is a measured
throughput guarantee. Do not enable provisioned concurrency. This reserves a
small execution allowance without keeping paid idle environments running; it
is an initial development setting to validate with bounded traffic.

| Runtime   | Reserved concurrency | Pool maximum      | Ordinary estimate | Two-generation estimate |
| --------- | -------------------- | ----------------- | ----------------- | ----------------------- |
| Auth      | 5                    | 2                 | 10                | 20                      |
| Core      | 5                    | 2                 | 10                | 20                      |
| Both APIs | 10 combined          | Independent pools | 20                | 40                      |

**Read-only RDS evidence, 2026-10-30:** SQL over the verified private TLS tunnel
reported `max_connections=81`, `superuser_reserved_connections=3`, and
`reserved_connections=2`: **76 usable client connections**. There was one client
connection at that observation (the counting session); it is not a peak-load
measurement. No application data, configuration or credential was changed.

Keep at least **20 usable connections as headroom**, consistent with the existing
alarm at 56. The admission budget for all ordinary clients, refresh/deployment
and retained idle overlap is therefore at most **56**, with the two active API
generations accounting for an estimated 40. The remaining 16 must cover both
migration executors, administration, operator/application-bootstrap sessions,
other clients and retained/deployment environments; it is not an automatic
allocation or proof that these consumers are bounded.

Use at most one manually initiated operation per migration executor, serialize
administrative/application bootstrap work, and allow at most two operator
connections in this initial dev procedure. Auth migration/admin concurrency
remains unreserved, so record these as operator-procedure limits, not enforced
Lambda caps. Inventory all consumers and resolve unknown overlap before
activation. Test actual peaks within this budget and stop/review if the measured
or planned total exceeds 56. Do not introduce a proxy, change reservations for
other functions, or raise the alarm as an implicit part of this decision.

Regional Lambda concurrency quota still requires a read before apply.
`lambda:GetAccountSettings` was denied for both existing deploy and bootstrap
profiles. No IAM change or quota increase was made to bypass that denial.
Verify that the ten proposed API units plus existing reservations fit the
account's reservable concurrency; if they do not, stop for a reviewed change.
Increase Core's initial value only after observed throttling/latency and a fresh
connection/overlap budget justify it; do not copy production scale into dev.
Reconcile this budget with the existing RDS alarm at 56; never raise it merely
to make a test pass or reuse SPEC 08's old Auth-only totals as aggregate proof.

Retain SPEC 09's validated refresh interval/retry/stale/drain settings
(300/30/900/5 seconds) and implementation evidence. The pre-activation connection
budget includes generation overlap even though destructive-failure simulation
and live password/signing rotations belong to SPEC 10.1. SPEC 10 verifies initial
secret loading, exact identities, verified TLS and normal application behavior.
Do not rotate credentials or induce mismatch/stale failures merely to close this
initial-deployment spec.

### Evidence boundary

Saved plans, plan JSON, account IDs, generated API IDs, complete secret ARNs,
request fixtures, state snapshots, and live authorization records are ignored
local evidence. Public logs and tracked files contain only sanitized summaries.

## Implementation plan

1. Verify current AWS account, MFA sessions, credits, quotas, backend, ownership
   and foundation stability. Verify quota availability for Auth 5/Core 5 and the
   current connection/overlap budget; record the complete route matrix.
2. Reuse valid SPEC 03–09/12–14 and Core SPEC 01–07 evidence. Verify both runtime
   secret references/current versions. Apply reviewed pending Auth/Core migrations
   through their existing private executors, then verify exact histories. Do not
   rerun the PostgreSQL administrative bootstrap.
3. Build and inspect both API ZIPs from the reviewed revision: hashes, handler
   layout, Node.js 24 ARM64, dependency closure and absence of local secret files.
4. Add the Core runtime configuration, exact identities, independent IAM/network
   controls, logs/alarms, integration and routes. Prepare the shared API JWT
   authorizer and discovery compatibility. Run focused offline checks and review
   refresh-free/normal saved plans for every create/update and cost/rollback.
5. Apply separately reviewed bootstrap capability/boundary and exact PassRole
   changes before dependent application changes. Mint a fresh deployment session
   and verify positive/negative authorization. Preserve existing consumers.
6. Apply a separately reviewed no-traffic API preparation plan if needed for the
   origin. Set the exact `BETTER_AUTH_URL`; expose no route or serving Lambda
   during this phase. Prepare exact endpoint-policy grants for both runtimes.
7. Revalidate both migration histories and current SQL capacity. Execute the
   initial-admin application bootstrap through the private operator command and
   verify its sanitized outcome before public activation. Save activation
   plans bound to service artifacts, secret references, origin, route/authorizer
   configuration, provider versions, state and the approved aggregate budget.
8. After explicit activation approval, activate Auth routes and verify its issuer,
   discovery/JWKS and real JWT issuance. Then activate Core public/protected routes
   with a separately reviewed saved plan and approval. Never expose protected
   routes before the authorizer and trusted-role contract work. Verify both
   functions' private configuration, CA layer, concurrency and integration.
9. Test every route's integration and authentication policy. Exercise public
   health/catalog, database-backed Auth, editor/admin catalog operations,
   user-role denial, bad-token denial, public visibility, TLS/runtime identity,
   DML success and DDL/cross-schema/history/privileged-secret denials for both APIs.
   Verify Gateway preflight and absence of alternate public Core access.
10. Verify backup availability, deletion protection, final-snapshot requirements
    and the deployment recovery runbook. Record the known compatible artifacts,
    route/security mapping and exact saved-plan rollback procedure. Do not run
    optional restores, credential rotations or controlled failures here.
11. Run final no-change plans and record `artifacts/validation/spec10-handoff.json`
    with basic-check outcomes, request consumption and all operational checks
    assigned to SPEC 10.1. Preserve source-user cutover restrictions and hand the
    completed initial deployment to the independently approved validation spec.

## Acceptance criteria

- [x] Existing foundation/resource identities are reused without duplication or replacement; every apply uses the canonical backend, us-east-2, an approved role and the exact reviewed saved plan.
- [x] Preparation exposes no route/integration/serving Lambda; activation has its separate reviewed plan and explicit approval.
- [x] Both API ZIPs match the reviewed source, hashes, Node.js 24 ARM64 and handler layout and contain no local environment or credential files.
- [x] Both exact migration histories match the reviewed artifacts before activation, including Auth migration 000003 and Core SPEC 06/07 migrations.
- [x] Initial admin creation uses Better Auth through the private operator command; reruns preserve credentials and reject an unexpected existing admin or non-admin identity.
- [x] The unique admin password is retained in the operator's password manager, entered/confirmed through a masked prompt and never persisted or printed by bootstrap; Better Auth stores its hash.
- [x] Bootstrap uses auth_runtime and required exact Auth references, verifies TLS/sign-in, revokes its verification session and adds no public bootstrap endpoint or master access.
- [x] Auth reads only its application signing/runtime secrets with correct stage handling; Core reads only core_runtime at AWSCURRENT; missing optional previous versions are distinguished from denial.
- [x] Both functions use intended private subnets, independent roles/client SGs, the CA layer, scoped logs/VPC policies and exact endpoint-policy secret pairs.
- [x] All six scoped VPC actions and source-function Deny conditions are verified without forcing an ENI lifecycle or invoking Admin as a probe.
- [x] Auth/Core concurrency is 5/5 with pool maximum 2 each; current SQL capacity, all consumer/overlap allowances, 20 connections of headroom and reservation quota are verified before activation.
- [x] The exact public origin, issuer discovery/JWKS and real issued JWTs work with Gateway before protected Core routes are activated.
- [x] The explicit route matrix, integrations, CORS/preflight, access logs and configured throttling are correct; unknown paths/methods cannot bypass authorization through a catch-all or Function URL.
- [x] Public health/catalog endpoints work anonymously and preserve published-only visibility; every management route allows real editor/admin JWTs and denies user/missing-role/invalid-token requests as specified.
- [x] Each verified-TLS database session uses its exact runtime identity, permits required DML and denies DDL, cross-schema, role and migration-history access.
- [x] Relevant effective IAM/endpoint checks deny privileged/cross-service secrets, secret writes, unrelated logs, IAM changes, administrative invocation and code-originated EC2 operations.
- [x] Trusted source-IP handling and enabled shared Auth limiter configuration pass focused baseline checks; stress, cross-environment atomicity and storage-failure exercises remain explicitly pending under SPEC 10.1.
- [x] Both APIs deliver native logs with no tested sensitive content; intended alarms/notification destination and unchanged RDS alarm threshold 56 are configured.
- [x] Backup availability, deletion protection, final-snapshot requirements and the deployment recovery procedure are verified without an induced failure or optional restore.
- [x] Basic checks obey the 140-request allowance, 5 in-flight requests per service, read-only SQL monitoring and stop conditions; their consumed/remaining budget is recorded for SPEC 10.1.
- [x] Final plans show no changes and the private handoff distinguishes passed initial-deployment checks, reused evidence, accepted limitations and every pending SPEC 10.1 operational check.
- [x] Terraform manages no secret values/versions; credential rotation remains unexecuted here, SPEC 11 cloud automation awaits both specs, and source-user cutover remains disabled.

**Completion evidence (2026-11-01):** The final no-change plans and sanitized live
evidence are recorded in `artifacts/validation/spec10-handoff.json`. Core's
database-backed GET returned 200 and its runtime log confirmed `core_runtime`,
`tls=true`, TLSv1.3. The retained user was assigned `editor`, obtained a fresh
JWT, received 200 on the protected catalog route, and both sessions signed out;
no credentials or JWT value were recorded. Both full Terraform roots report no
changes with the reviewed inputs, and the database tunnel is stopped.

The historical consumption of the original shared request allowance could not
be reconstructed; this accepted campaign limitation is recorded in the handoff.
The separately approved recovery campaign used 64/100 requests, with 36
remaining. SPEC 10.1 load, rotation, and failure exercises remain pending by
scope, not as SPEC 10 acceptance blockers. The optional `NOINHERIT` improvement
is also outside this spec.

## Decisions

- **Yes:** defer every public application resource until the security and database prerequisites are implemented.
- **Yes:** allow a no-traffic API shell when the generated origin is required before Lambda configuration. A public route remains forbidden until activation.
- **Yes:** require a second saved plan and approval for activation after origin and migration revalidation.
- **Yes:** one HTTP API serves both services through explicit routes, with separate Lambda integrations and JWT authorization on protected Core routes.
- **Yes:** initial dev concurrency is Auth 5/Core 5, with pool maximum 2 each, no provisioned concurrency, and a shared capacity/overlap gate before activation.
- **Yes:** first admin creation is a private operator-run Better Auth application-bootstrap step after migrations; PostgreSQL bootstrap keeps its existing contract.
- **Yes:** first deployment uses independent `auth_runtime` and `core_runtime` credentials; no privileged-credential application phase.
- **Yes:** resolve trusted role issuance and issuer discovery compatibility before protected Core activation; no synthetic identity bypass.
- **Yes:** separate completion into SPEC 10 deployment/basic security and SPEC 10.1 operational validation; keep one 1,000-request traffic/security campaign with at most 140 spent here.
- **Yes:** hand rotation, controlled failures and optional restore evidence to SPEC 10.1 without weakening activation security gates.
- **Yes:** keep manual MFA-protected deployment before CI/CD. SPEC 11 cloud automation waits for this path and SPEC 10.1 operational acceptance.
- **No:** duplicate foundation resources, use ad hoc console changes, manage secret values in Terraform, or bypass failed migrations/authorization tests.

## Risks

| Risk                                                      | Mitigation                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| API origin is unknown before configuration                | Create only a no-route API shell, then generate and approve a bound activation plan.                           |
| Foundation drift is hidden among deferred creates         | Run refresh-free and normal plans and reject any unexplained foundation change.                                |
| A stale migration result activates incompatible code      | Revalidate exact manifest and history immediately before activation.                                           |
| Public traffic reaches an uninitialized application       | Keep route/integration absent until secret, migration, IAM, and runtime gates pass.                            |
| Load or pool replacement exhausts RDS                     | Bound API/Lambda concurrency, pool size, test requests, and replacement overlap.                               |
| Deferred operational checks are mistaken for passed tests | Record the pending SPEC 10.1 checklist explicitly and block SPEC 11 cloud automation until both handoffs pass. |

## References

- [API Gateway HTTP API routes and precedence](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-routes.html).
- [Lambda reserved concurrency: downstream protection and no extra reservation charge](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html).
- [Better Auth initial-admin CLI and trusted createUser path](https://better-auth.com/docs/concepts/cli#create-admin).
- [API Gateway JWT authorizer validation and claims](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

## What is **not** in this spec

- Foundation recreation, backend migration, database administration, or migration-system design.
- Master-secret application access, Terraform-managed secret values, or source-user cutover.
- CI/OIDC automation, frontend hosting, custom role-management UI/API, staging, production, NAT, RDS Proxy, Multi-AZ, or a Paid plan upgrade.
