# SPEC 08 — API Traffic Controls and Shared Authentication Rate Limiting

> **Status:** Implemented
> **Depends on:** SPEC 04, SPEC 05, SPEC 06, SPEC 07
> **Date:** 2026-10-20
> **Objective:** Bound API traffic and Lambda concurrency while enforcing atomic PostgreSQL-backed per-IP limits for sensitive authentication endpoints.

## Why this spec exists

The public HTTP API forwards all routes to Lambda without service-specific
throttling or concurrency limits. A small RDS instance must not inherit the
scaling capacity of the whole Lambda account. In-memory authentication counters
are not shared across Lambda environments.

The installed Better Auth 1.7.7 database rate-limit storage already performs
atomic insert, reset, and conditional increment operations through the Kysely
adapter. It keys limits by normalized client IP and authentication path. Its
custom-storage contract receives that already-derived key, so changing storage
does not add an account or email identity to the limit.

## Scope

**In:**

- Configurable HTTP API stage throttling, initially 10 requests/second and
  burst 20.
- Configurable Lambda reserved concurrency, initially 5, subject to the actual
  account quota.
- A configurable Better Auth `pg`/Kysely pool with an initial maximum of 2
  connections per Lambda execution environment.
- A measured RDS connection budget and a controlled load-test procedure.
- Explicit Better Auth 1.7.7 rate limiting with `storage: "database"`.
- Atomic per-IP and per-path admission across independent Lambda environments.
- Explicit limits for sign-in, sign-up, and configured password-recovery
  routes.
- Opportunistic expired-row cleanup using the installed Better Auth behavior,
  with measured table growth and latency during bounded dev testing.
- A trustworthy client-IP mapping from the API Gateway HTTP API v2 event
  context.
- A checked-in Better Auth migration artifact for the `rateLimit` table,
  separate from execution.
- Automated concurrency, expiration, path isolation, unavailable-storage, and
  forged-header tests.

**Out of scope:**

- Per-account or per-email counters. Better Auth 1.7.7 derives its rate-limit
  key before the storage call as IP plus path. Account limits require separate
  pre-authentication logic and an account-lockout abuse policy, which must be
  designed before a production deployment.
- A custom rate-limit storage implementation or generic future-backend
  abstraction. If the pinned built-in implementation fails the required
  integration tests, this spec must be amended before replacing it.
- Batched cleanup, a scheduled cleanup service, or a new maintenance Lambda.
- Redis, DynamoDB, WAF, RDS Proxy, or provisioned concurrency.
- Building the private migration executor from SPEC 04 or CI/CD.
- Migration execution at Lambda startup or through `lambda_db_config`.
- Implementing SMTP or enabling a missing password-recovery delivery flow.
- Duplicate CloudWatch alarms; SPEC 06 owns those resources.
- Requesting a Paid plan upgrade or silently removing an invalid concurrency
  limit.

## Data model

### Infrastructure and pool configuration

| Terraform input                         | Initial dev value | Contract                                         |
| --------------------------------------- | ----------------- | ------------------------------------------------ |
| `api_throttling_rate_limit`             | `10`              | Positive HTTP API stage request rate             |
| `api_throttling_burst_limit`            | `20`              | Positive HTTP API stage burst capacity           |
| `lambda_reserved_concurrent_executions` | `5`               | Positive cap that must fit the account quota     |
| `auth_pg_pool_max`                      | `2`               | Positive maximum for the sole Better Auth pool   |
| `auth_rate_limit_enabled`               | `true`            | Must remain enabled in AWS dev                   |
| `auth_rate_limit_rules`                 | Exact rules below | Positive window and maximum for each route group |

The Lambda environment receives these values as non-sensitive configuration.
`auth_rate_limit_storage` is not a variable: the approved implementation is the
installed Better Auth database storage.

On 2026-10-21, the regional Lambda concurrency quota was read as 400 concurrent
executions. The Lambda console reports 400 unreserved account executions; after
reserving 5 for SPEC 08, 395 remain, above Lambda's required 100 unreserved
executions. The account-settings API read was denied to the authorized
deployment role, but the console observation verifies the required capacity.

The initial rules use the installed Better Auth path format, after removal of
the `/api/auth` base path:

| Rule              | Paths                                           | Window     | Maximum |
| ----------------- | ----------------------------------------------- | ---------- | ------- |
| Sign-in           | `/sign-in/*`                                    | 10 seconds | 3       |
| Sign-up           | `/sign-up/*`                                    | 10 seconds | 3       |
| Password recovery | `/request-password-reset`, `/forget-password/*` | 60 seconds | 3       |

Only password-recovery routes already provided by the configured Better Auth
service receive a rule. This spec does not add email delivery or a missing
recovery flow.

Estimate steady application connections as reserved concurrency multiplied by
the pool maximum: `5 * 2 = 10`. SPEC 09 may temporarily add one candidate pool
per environment during credential refresh, for a maximum authentication overlap
of 20. The verified PostgreSQL values are `max_connections = 81`,
`superuser_reserved_connections = 3`, `reserved_connections = 2`, and three
current client connections (one active). This leaves 76 connections usable by
ordinary clients. The bounded worst-case budget is 20 auth connections during
overlap, 2 migration connections, and 2 administrative connections: 24 total.
Including the three observed connections gives 27, leaving 49 usable
connections. The three-connection observation is a point-in-time sample, not a
historical peak. The RDS alarm fires above 56, so 27 is 29 below its threshold
(or 30 below the first firing value, 57). This establishes the static capacity
budget, not a peak-load guarantee; SPEC 10 measures connections, CPU, and
latency during its capped load test. The CloudWatch metric queries were
permission-denied and are not an additional SPEC 08 acceptance requirement.

The existing `gootip-dev-rds-cpu` alarm was observed in `OK`, enabled, with an
80% CPU threshold over two five-minute periods. The RDS database-connections
alarm was `OK`, enabled, with a 56-connection threshold over one five-minute
period; `gootip-dev-auth-migrations-errors` was `OK`, enabled, with a threshold
of one error in one minute. All three publish to the operational SNS topic,
which has one confirmed email subscription and no pending subscriptions. The
monthly actual-cost budget is USD 10, with an actual-cost notification above
80%. Public auth Lambda/API errors, throttling, and other runtime alarms are
SPEC 10 scope and must be configured and verified before its load test; the
current migration alarm does not cover those future runtime resources.

CloudWatch metric reads for `DatabaseConnections` and `CPUUtilization` were
denied. The current client-connection count supplied from the private
PostgreSQL session is a point-in-time value, not a historical peak; SPEC 10 owns
runtime metric measurement during its capped test.

API Gateway throttling is a best-effort traffic control. It is not a per-user
rate limiter or an absolute spending cap.

### Counter storage contract

Better Auth owns one `auth.rateLimit` table with its installed 1.7.7 schema:

| Field         | Contract                                           |
| ------------- | -------------------------------------------------- |
| `id`          | Better Auth-generated row identifier               |
| `key`         | Unique normalized IP-plus-path key                 |
| `count`       | Requests admitted in the active window             |
| `lastRequest` | Millisecond timestamp used to calculate expiration |

The reviewed migration is generated from the same pinned Better Auth
configuration used at runtime. The migration manifest and checksum remain
owned by the SPEC 04 migration runner.

The built-in database storage handles concurrent creation, expired-window
reset, and increment-below-maximum through conditional database operations.
Integration tests must prove that independent clients cannot admit more than
the configured maximum. A custom storage implementation is not added merely to
duplicate this behavior.

Better Auth 1.7.7 opportunistically calls `deleteMany` for rows older than the
longest configured window when it resets an expired counter. That deletion is
not batched. This behavior is accepted for the bounded dev workload instead of
claiming strict cleanup batching. SPEC 10 records counter-row growth and
cleanup latency during its capped traffic test. Material growth or latency is
the trigger for a separate maintenance or custom-storage specification before
production.

Rate limiting is explicitly enabled in AWS dev. A PostgreSQL or storage error
must not switch to memory or unrestricted authentication. Sensitive routes
return a controlled sanitized service-unavailable response.

### Client identity contract

The Lambda adapter derives `x-gootip-client-ip` only from
`requestContext.http.sourceIp` on a valid HTTP API v2 event. It overwrites any
client-supplied value and removes forwarding headers before the request reaches
Better Auth. Better Auth is configured to read only `x-gootip-client-ip` for
rate-limit identity.

Normalize supported IPv4, IPv4-mapped IPv6, and IPv6 forms consistently with
the installed Better Auth implementation. A Lambda authentication request
without a valid API Gateway source IP fails closed. Tests cover IP isolation,
shared-IP behavior, path isolation, malformed source IPs, and forged
`X-Forwarded-For`, `X-Real-IP`, and `x-gootip-client-ip` headers.

### Files and external prerequisites

- Infrastructure: `api-gateway.tf`, `lambda.tf`, `variables.tf`,
  `environments/dev.tfvars`, and `README.md`.
- Application: `gootip-auth/src/app.ts`, `src/auth/auth.ts`, `src/lambda.ts`,
  `src/config/`, and relevant tests.
- Add the reviewed `rateLimit` migration to `gootip-auth/migrations/` and update
  its manifest.
- The existing SPEC 04 private migration executor applies the artifact as
  `auth_migrator` before live rate limiting is enabled.
- The SPEC 04 private executor published version 3 for this migration. The
  `deployment` alias points to v3 and the operator-only `baseline` alias remains
  on v2. The v3 `CodeSha256` matches the reviewed package.
- Deployed artifact correspondence: source revision
  `54746b4f0de883706628969be2390bd014beefdb`,
  `migrations/000002-auth-rate-limit.sql` SHA-256
  `83639dd0b1d4c74f951561907d156a7c14c50f748cecc50e8134f8ef6cbb9606`, manifest
  SHA-256 `5794f1ab9089939b0a6e8998789a3123daacfc82cd7d9b1ab54dc239e0a8630c`,
  ZIP SHA-256 `176bc7b4a8b22c6824487ee72fe54f9e1573a4ef2117a34de1aa9eeabf794548`,
  deployed ZIP `CodeSha256`
  `F2vHtKiyLGgkSH7nL+VPnhVzpO8hF6NN4aqe6r95RUg=`.
- Live SPEC 08 migration evidence (2026-10-21): pre-apply `validate`
  succeeded with `applied_ids: ["000001"]`, `pending_ids: ["000002"]`, and
  history digest `b011d07782dc784d72962e233f2e609fa89cdaeea117648451889f396d5a2e43`.
  `apply` succeeded with `applied_ids: ["000002"]`, `pending_ids: []`, and
  history digest `b1039422517fae6f2a66a3262f41f47033e839f6ce7e62d1cbc2578682cc79e5`.
  Final `validate` succeeded with `applied_ids: ["000001", "000002"]`,
  `pending_ids: []`, and the same final history digest.
- SPEC 10 owns the first public activation and bounded live traffic tests. This
  spec leaves the undeployed application artifact and Terraform configuration
  ready for that gate.
- SPEC 07 provides the development IAM/network baseline. SPEC 07.1 performs
  final least-privilege hardening after the complete application inventory
  exists and before SPEC 10 activation.

## Closure and handoff to SPEC 10

SPEC 08's dev traffic controls, shared PostgreSQL rate limiter, trusted-IP
boundary, and reviewed migration are implemented and verified. The application
Lambda and public API remain disabled; this closure does not activate them.

The existing SPEC 06 notifications were verified on 2026-10-21: RDS CPU,
DatabaseConnections, and migration Lambda error alarms were enabled and `OK`;
the operational SNS subscription was confirmed; and the USD 10 monthly actual-
cost budget notification is set above 80%. These current alarms do not cover the
future public auth runtime or HTTP API.

Before its bounded load test, SPEC 10 must create and verify alarms for public
authentication Lambda errors/throttles and API errors/throttles, connect them to
the approved notification path, and exercise/observe them during the controlled
test. Those future alarms are a SPEC 10 prerequisite, not an implementation
claim or an outstanding SPEC 08 feature. SPEC 10 also measures live connection
count, CPU, and latency as stated in its own test contract.

## Implementation plan

1. Record the installed Better Auth 1.7.7 rate-limit and Kysely adapter behavior.
   Read the current Lambda account concurrency quota and reconfirm the observed
   RDS effective connection limit without changing either service.
2. Add and validate the pool maximum, rate-limit enablement, and exact rule
   inputs. Configure Better Auth database storage and keep the application on
   its sole existing PostgreSQL pool.
3. Generate the `rateLimit` table migration with the pinned Better Auth tooling,
   review it, update the immutable manifest, and apply it only to an isolated
   test database. Verify that `auth_runtime` needs DML but not DDL.
4. Adapt API Gateway `requestContext.http.sourceIp` into the server-owned
   `x-gootip-client-ip` header. Strip or overwrite spoofable client headers and
   test malformed and forged events.
5. Test atomic admission, expiration, built-in cleanup behavior, IP/path
   isolation, controlled rejection, and storage failure with multiple
   independent PostgreSQL clients.
6. Add validated stage-throttling and reserved-concurrency Terraform inputs,
   the Lambda environment configuration, and the initial dev values. If the
   concurrency reservation does not fit the account quota, leave SPEC 10
   activation blocked rather than deploying an unbounded function.
7. Use the existing SPEC 04 executor to validate and apply the reviewed counter
   migration. Confirm the undeployed application fails closed when the required
   table is absent. Do not activate the public application.
8. Document a capped load-test contract with explicit duration, request count,
   counter-row observation, connection ceiling, and rollback thresholds. SPEC
   10 executes it after first activation.

## Acceptance criteria

- [x] Dev configuration sets stage rate 10, burst 20, reserved concurrency 5, and pool maximum 2 unless a reviewed capacity adjustment changes them.
- [x] Reserved concurrency 5 is valid for the actual AWS account quota.
- [x] The sole Better Auth PostgreSQL pool uses the validated configurable maximum.
- [x] The connection calculation covers steady auth pools, SPEC 09 replacement overlap, migration/administrative clients, and operational headroom.
- [x] Better Auth 1.7.7 is explicitly configured with enabled database rate limiting and the approved route rules.
- [x] The reviewed migration creates the installed Better Auth `auth.rateLimit` model and its unique key contract.
- [x] Concurrent requests across independent clients cannot exceed a rule's atomic admission maximum.
- [x] Expired counters reset correctly and the installed opportunistic cleanup behavior is verified without claiming batch bounds.
- [x] Different trusted IPs and authentication paths do not incorrectly share counters.
- [x] Forged forwarding and `x-gootip-client-ip` headers cannot replace API Gateway's trusted source IP.
- [x] Missing or malformed API Gateway source identity fails closed for authentication routes.
- [x] Exceeded limits return a controlled `429` response with retry information.
- [x] Storage failures return a controlled sanitized unavailable response and never fall back to memory or unrestricted access.
- [x] The migration artifact is explicit, reviewed, and tested without TypeORM or startup schema synchronization.
- [x] No migration runs in application startup or `lambda_db_config`.
- [x] The required migration is applied by the SPEC 04 private executor before deployed feature activation.
- [x] The controlled SPEC 10 load test has explicit request, duration, connection, counter-row, consumption, and rollback limits.
- [x] Existing SPEC 06 RDS CPU/connection, migration-error, SNS, and budget notifications were verified. SPEC 10 is explicitly responsible for creating and verifying public runtime/API error and throttling alarms before its load test.
- [x] SPEC 10 activation remains blocked if the migration, migration executor, or account quota is unavailable.
- [x] Documentation does not claim per-account protection or strictly batched cleanup.

### Separate repository verification debt

The broad `bootstrap/tests/iam.tftest.hcl` suite still has a pre-existing
plan-time `Unknown condition value` failure in
`bootstrap_rds_service_linked_role_exception_is_exact`. The focused test for
`lambda:GetFunctionConfiguration` passed, and offline Terraform validation and
IAM guardrails passed. This unrelated test debt is recorded separately and is
not evidence against the completed SPEC 08 controls.

## Decisions

- **Yes:** use Better Auth 1.7.7 built-in database storage. The installed
  implementation already provides atomic PostgreSQL admission through the
  existing Kysely adapter.
- **Yes:** use explicit per-IP and per-path rules for sensitive configured
  endpoints.
- **Yes:** accept the installed opportunistic, non-batched cleanup behavior for
  bounded dev traffic and measure it during SPEC 10.
- **Yes:** keep endpoint rules and capacity limits as Terraform-managed
  non-sensitive configuration.
- **Yes:** generate the migration here and apply it through the existing SPEC
  04 private executor. SPEC 11 later automates that invocation.
- **Yes:** retain the existing API Gateway HTTP API and on-demand Lambda model.
  Stage throttling and reserved concurrency fit the current integration;
  provisioned concurrency does not solve this requirement.
- **No:** custom rate-limit storage or a speculative multi-backend abstraction.
- **No:** claim per-account protection from a storage API that receives only an
  IP-plus-path key.
- **No:** treat API throttling, CORS, or instance-local memory as shared
  authentication protection.
- **No:** automatic quota changes, Paid plan upgrades, or unbounded load tests.

## AWS Free plan and cost constraints

Reserved concurrency is distinct from paid provisioned concurrency. It has no
additional reservation charge, but account quotas can prevent the requested
setting. Verify eligibility without upgrading the account.

Counters add PostgreSQL reads, writes, and storage. Better Auth's cleanup can
delete multiple expired rows in one operation, so the bounded dev load test
must observe query latency and row count. Load tests consume API, Lambda,
logging, and database capacity; set a duration and request cap before execution.
Cost and credit alerts are notifications, not synchronous spending enforcement.

## Risks

| Risk                                                               | Mitigation                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A future Better Auth change alters atomic storage behavior         | Keep version 1.7.7 pinned and retain independent-client integration tests.                                                                    |
| Built-in cleanup grows expensive as expired rows accumulate        | Bound dev ingress and tests, observe row count and latency in SPEC 10, and require a new design before production if material growth appears. |
| IP-only rules miss credential stuffing distributed across many IPs | Do not claim account protection; design account-aware controls with lockout-abuse recovery before production.                                 |
| Shared NAT IPs cause false positives                               | Keep short endpoint-specific windows and validate realistic shared-IP scenarios.                                                              |
| Low account quota prevents reserved concurrency                    | Check first; do not silently remove the cap or claim validation.                                                                              |
| The migration executor or required migration is unavailable        | Deliver tested artifacts but keep SPEC 10 activation blocked.                                                                                 |
| Cleanup or SPEC 09 refresh increases connection pressure           | Keep the pool at 2 initially and test lifecycle overlap under the measured connection budget.                                                 |

## References

- [Lambda reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html).
- [Better Auth rate limiting](https://www.better-auth.com/docs/concepts/rate-limit); implementation evidence is pinned to the installed 1.7.7 package.

## What is **not** in this spec

- Per-account or per-email counters, custom rate-limit storage, or a generic
  future-backend abstraction.
- Redis, DynamoDB, WAF, RDS Proxy, provisioned concurrency, or a scheduled
  cleanup service.
- A migration executor, CI/CD, SMTP, automatic startup migrations, an account
  plan upgrade, or an unlimited load test.
