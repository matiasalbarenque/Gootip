# SPEC 09 — Auth and Core Runtime Credential Refresh

> **Status:** Implemented
> **Depends on:** SPEC 05, SPEC 07, SPEC 08, SPEC 14; gootip-core SPEC 02 and SPEC 06
> **Date:** 2026-10-30
> **Objective:** Refresh Auth and Core database credentials safely in warm Lambda environments within one shared RDS connection budget.

## Deployment ownership amendment (2026-10-30)

SPEC 10's Draft scope includes both Auth and Core initial API deployment.
References below to a future Core deployment spec now bind to SPEC 10 for exact
runtime resources, concurrency, routes/JWT and initial live IAM/TLS/security
checks. SPEC 10.1, dependent on completed SPEC 10, owns traffic/connection-peak,
live refresh/rotation, controlled failures and recovery exercises for both APIs.
SPEC 11 cloud automation consumes both handoffs. This ownership update changes
no completed evidence, existing approval or activation authority. Historical
references assigning live rotation to SPEC 10 delegate that exercise to SPEC 10.1;
they do not make operational acceptance an initial-deployment completion gate.

## Why this spec exists

Auth loads `auth_runtime` credentials once and caches its Better Auth client
and `pg` pool. Core caches its Nest application and TypeORM DataSource, but its
API currently reads database credentials from environment configuration rather
than loading its runtime secret. Neither API implements warm credential refresh.
Updating environment variables alone does not update either existing client.

This revision extends the former Auth-only contract to both implemented APIs.
It defines how future Lambda consumers join the same capacity budget without
requiring a generic client framework or a new database service.

### Verified baseline — 2026-10-30

Read-only AWS inventory in the Gootip account, `us-east-2`, found exactly three
Lambdas: `lambda_db_config`, `gootip-dev-auth-migrations`, and
`gootip-dev-core-migrations`. Neither API is deployed yet. The three functions
use private networking and configure verified database TLS. Core migrations
reserve concurrency 1 and use pool maximum 1. Auth migrations and administration
have no function reserved-concurrency setting.

RDS `gootip-dev` is private, available, PostgreSQL 18.6 on `db.t3.micro`.
CloudWatch's last seven days recorded a maximum of three connections; the
connection alarm is `OK` with threshold 56. This light workload does not prove
capacity for two running APIs. The previous SQL observation was
`max_connections = 81`, with 3 superuser-reserved and 2 additional reserved
connections. The current parameter API returns a memory-derived expression;
81 must be reconfirmed by SQL before live activation.

Auth/Core runtime and migrator secrets each have an `AWSCURRENT` version.
The `gootip-auth-dev` signing-secret container has no versions. Metadata does
not report automatic rotation enabled for these secrets. No secret values were
read. These observations are dated evidence, not permanent readiness claims.

## Scope

**In:**

- Version-aware loading and refresh of `auth_runtime` and `core_runtime`.
- Core API runtime-secret loading before Nest/TypeORM initialization.
- Separate per-service coordination, candidate validation, client replacement,
  cleanup, and bounded failure behavior using each service's existing client.
- Auth-only signing-secret refresh and documented session/token consequences.
- One RDS budget covering both APIs and all existing database consumers.
- A capacity and credential contract required before adding future consumers.
- Local failure, rotation, freeze/resume, concurrency, and integration tests.
- Manual rotation/recovery runbooks and explicit deployment handoffs.

**Out of scope:**

- Scheduled rotation, password generation, or Terraform-managed secret values.
- Live password changes, administrative bootstrap, or migration execution as
  part of implementing this spec.
- Public API activation, new runtime IAM roles, CI/CD, or Core deployment.
- RDS Proxy, Redis, a new ORM, or a shared runtime framework for future services.
- Changing existing database identities, privileges, schemas, or ownership.
- Warm pool replacement in the migration/administrative executors: they load
  credentials per invocation and close connections in `finally` already.

## Data model and integration contracts

### Service identity and client ownership

| Consumer          | Credential reference                                                 | Allowed database identity        | Client lifecycle                                       |
| ----------------- | -------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| Auth API          | Existing `DB_RUNTIME_SECRET_ARN`; secret `gootip-dev-auth-runtime`   | `auth_runtime`                   | Better Auth client and its sole `pg` pool              |
| Core API          | `CORE_RUNTIME_SECRET_ARN`; existing secret `gootip-dev-core-runtime` | `core_runtime`                   | Nest application generation and its TypeORM DataSource |
| Auth migrations   | Existing migration secret reference                                  | `auth_migrator`                  | Load/connect/close per invocation                      |
| Core migrations   | Existing migration secret reference                                  | `core_migrator`                  | Load/connect/close per invocation                      |
| Administration    | Existing fixed operation's exact secret allowlist                    | Existing administrative identity | Load/connect/close per invocation                      |
| Database operator | Existing operator secret reference                                   | `gootip_dev_operator`            | Documented workstation sessions                        |

Auth additionally reads its existing application signing secret through
`SECRET_ARN`. Core does not need an Auth signing secret or a new application
secret for this feature. Full ARNs come from the existing bootstrap handoff,
never guessed suffixes, account IDs, or tracked secret payloads.

AWS API entry points require their runtime secret reference and reject a
missing reference, malformed payload, or username other than the exact runtime
identity. They cannot fall back to environment-supplied database credentials or
master/migrator/operator secrets. Local HTTP and migration CLI entry points
retain their existing environment-based configuration and isolation rules.
Terraform receives references and timing inputs only, never secret values.

### Refresh state and timing

Each service maintains one process-local coordinator per execution environment.
It is not a distributed lock across functions or environments. Separate service
implementations may follow the same contract without sharing a library.

| Field                       | Meaning                                                  |
| --------------------------- | -------------------------------------------------------- |
| `last_success_at`           | Time of the last fully validated required-secret refresh |
| `next_refresh_at`           | Earliest normal refresh time                             |
| `next_retry_at`             | Earliest retry after a failed refresh                    |
| `credential_version_id`     | Active database secret version identifier                |
| `signing_secret_version_id` | Active signing-secret version, Auth only                 |
| `in_flight`                 | Shared promise for the single refresh attempt            |
| `active_client`             | One complete service generation                          |
| `retiring_client`           | At most one old generation awaiting bounded closure      |

Client handles necessarily contain credentials in memory. State is never
serialized. Passwords, secret payloads, tokens, connection strings, and raw SDK
or SQL errors never enter logs, responses, metrics, artifacts, or Terraform.

Both APIs use these non-sensitive environment inputs, validated at startup:

| Input                                    | Initial value | Contract                                            |
| ---------------------------------------- | ------------- | --------------------------------------------------- |
| `DB_CREDENTIAL_REFRESH_INTERVAL_SECONDS` | 300           | Positive integer                                    |
| `DB_CREDENTIAL_REFRESH_RETRY_SECONDS`    | 30            | Positive integer, below refresh interval            |
| `DB_CREDENTIAL_MAX_STALE_SECONDS`        | 900           | Positive integer, greater than refresh interval     |
| `DB_CREDENTIAL_DRAIN_TIMEOUT_SECONDS`    | 5             | Positive integer, within the invocation time budget |

Secret retrieval, candidate connection validation, and SDK retries also have
explicit finite deadlines within the remaining invocation time. Timing tests
use an injected clock. Elapsed stale age includes time spent frozen; do not
rely on background timers or a process CPU-time clock to enforce it.

### Replacement and request safety

1. On first use, load `AWSCURRENT`, validate the fixed identity, and establish
   verified TLS before admitting database-backed requests.
2. At each invocation boundary, check refresh, retry, and stale deadlines.
   Join one in-flight attempt. Do not fetch on every request before it is due.
3. An unchanged validated version renews freshness without replacing the
   client. A changed version creates at most one candidate generation and
   validates a read-only database connection and expected identity.
4. Publish the fully initialized candidate atomically. Each admitted request
   keeps one generation for its entire lifetime, including its transaction.
5. Drain and close the old generation within the configured bound. Do not
   start another candidate while a retiring generation remains. If draining
   cannot complete safely, stop admitting database work and complete bounded
   cleanup; never move an in-flight transaction to another DataSource.
6. On retrieval/candidate failure, close the failed candidate and retain a
   usable old generation only until its maximum stale age. After that deadline,
   database-backed requests return a sanitized service-unavailable response.
   Initial-load failures likewise cannot serve database-backed requests.
7. A database authentication failure may trigger one refresh attempt subject
   to the shared cooldown. Do not replay a whole HTTP request, write, or
   transaction after an ambiguous outcome. Retry only connection establishment
   before application SQL has run. Do not confuse a Core JWT authorization
   failure with a PostgreSQL credential failure.

Cleanup must run within invocation ownership rather than assuming a timer
continues after Lambda freezes. After thaw, check freshness and unfinished
cleanup before admitting new database work. Repeated failures must not leave a
rejected initialization promise permanently cached and prevent later recovery.

Auth replaces the Better Auth client and its pool together. Core replaces the
whole Nest application generation through its existing `createApp` boundary;
its injected repositories and DataSource must belong to that same generation.
A bare reassignment of a DataSource variable cannot update injected repositories.
Preserve trusted gateway claims, validation, routes, and local shutdown behavior.
Close retired Core applications with `app.close()` and test pool disposal.

### Auth signing-secret behavior

Retrieve the current application-secret version through the existing exact
allowlist. Check the installed Better Auth version's supported behavior before
claiming multi-key compatibility. A supported changed signing secret creates a
complete Auth generation; session invalidation must be documented and tested.
If safe runtime replacement is unsupported, fail closed with a sanitized error
and document controlled redeployment/recovery. Do not silently keep an obsolete
signing secret indefinitely or add master access as a recovery path.

### Shared RDS capacity and future consumers

Extend SPEC 08's Auth-only arithmetic into a dated consumer table in the
runbook. For each API, record pool maximum, configured concurrency, ordinary
connection estimate, maximum candidate/retiring overlap, and activation status.
Keep Auth's initial pool maximum 2 and reserved concurrency 5 unless separately
reviewed. Core's pool defaults to 2, but its runtime concurrency is not yet
allocated; do not copy Auth's concurrency or claim Core deployment is ready.

Account separately for both migration executors, administration, operator
sessions, other clients, retained idle connections, deployment/version overlap,
and operational headroom. An advisory SQL lock serializes work, not the number
of waiting connections. Record the unreserved Auth migration/admin concurrency
as a planning limitation instead of treating a single observed invocation as a
hard cap. New reservations or database connection limits require their owning
reviewed infrastructure change.

Use the sum of per-consumer estimates plus overlap and headroom against the
SQL-verified usable connection capacity. Concurrency times pool maximum is a
planning estimate, not proof of a strict global ceiling over retained Lambda
environments. Measure connection peaks during the eventual bounded live test.
Do not reuse the old 24/27-connection totals as a two-API capacity conclusion.
Reconcile the existing alarm threshold 56 with the revised budget before
activation; never raise it merely to make a test pass.

Before any future Lambda is activated against this RDS instance, its owning
spec must provide: exact runtime identity/secret allowlist, client type and
lifecycle, pool maximum, concurrency allocation, refresh/cleanup behavior,
overlap allowance, and updated aggregate budget with focused evidence. Runtime
identities remain separate from migration/administrative identities. This is a
required handoff, not an automatic deployment mechanism or a new registry service.

### Manual rotation and recovery

The runbook must coordinate the authorized out-of-band PostgreSQL password
change with updating the matching Secrets Manager value. Changing the secret
alone does not change the database password. Keep the fixed single-user
identities; do not introduce alternate users or automatic rotation here.

Document the order, verification, mismatch window, and recovery for failures
between the database and secret updates. Never submit password-bearing SQL
through history, logged command text, or an unverified logging configuration.
Existing connections may remain open after password rotation; success on an old
connection does not validate a new credential. Confirm a fresh TLS connection
as the intended runtime identity. A single-user transition can reject new
connections temporarily; this spec does not promise zero downtime.

Recovery must restore a matching database/secret pair through the authorized
out-of-band procedure. Moving a version label or rolling back Lambda code alone
does not revert PostgreSQL's password. Applications never perform the
administrative credential update themselves.

### File boundaries and handoffs

Implementation may change Auth's `src/lambda.ts`, `src/auth/auth.ts`,
`src/config/`, `src/app.ts`, and focused tests; Core's `src/lambda.ts`,
`src/app.ts`, `src/config/database/`, and focused tests; and each API's README.
Small service-local helpers may live alongside those existing boundaries.
Infra changes are limited to non-sensitive refresh inputs/configuration,
capacity/runbook documentation, and focused checks in the existing flat layout.
No public activation, new runtime resource, IAM grant, or secret-value write is
implicitly authorized by this spec.

SPEC 07.1 owns final per-function IAM, endpoint policy, and network hardening,
including Core's exact runtime-secret allowlist once its runtime resources are
introduced. SPEC 10 owns Auth activation and live warm-rotation validation. Core
API activation and its equivalent live exercise require a separate deployment
spec; neither Core SPEC 06 migrations nor this spec authorizes that deployment.
Do not block local completion on absent public APIs or present local tests as
live rotation evidence. SPEC 03/04/05/14 deferred operational evidence retains
its existing owner and is not silently marked complete here.

## Implementation plan

1. Record the consumer inventory and aggregate connection-budget method.
   Define/validate the timing inputs and service-specific credential contracts.
   Reuse dated AWS evidence; defer current SQL capacity verification to the live
   activation gate when no authorized tunnel is available.
2. Add version-aware secret retrieval to Auth and Core API initialization.
   Validate exact usernames and sanitized failures before framework startup.
   Preserve local HTTP/CLI configuration and add focused loader tests.
3. Implement each API's single-flight refresh, cooldown, freshness checks, and
   initialization recovery. Test unchanged versions, invalid candidates,
   concurrent triggers, stale expiry, and freeze/resume without replacing pools.
4. Implement candidate validation, atomic activation, request ownership, and
   bounded cleanup for Auth's client/pool and Core's Nest/DataSource generation.
   Test that Core repositories use the new generation and old pools close.
5. Run isolated PostgreSQL integration tests for both services with actual
   password changes and overlapping requests. Verify identity isolation,
   mismatch recovery, no write replay, no connection leaks, and aggregate
   connection peaks including simultaneous refresh in independent coordinators.
6. Implement/test Auth-only signing-secret changes against the installed Better
   Auth version. Record session/token consequences and supported recovery,
   including simultaneous database/signing changes within the same pool budget.
7. Finish the manual rotation/recovery runbooks and sanitized telemetry. Record
   verification results and hand the revised budget, runtime references, and
   live rotation scenarios to SPEC 07.1, SPEC 10, and future Core deployment.

## Acceptance criteria

- [x] Both AWS API entry points load only their exact allowed runtime identity; Core loads its existing runtime secret before Nest/TypeORM startup.
- [x] Auth additionally reads only its existing application secret; neither API can use master, migrator, operator, or the other service's credentials.
- [x] Local HTTP and migration CLI entry points retain their established configuration and isolation behavior.
- [x] Timing/deadline inputs are finite, validated, and tested against remaining invocation time and elapsed freeze time.
- [x] Each service/environment permits one refresh attempt and no more than two client generations, including cleanup and failure paths.
- [x] Unchanged validated versions renew freshness without replacing clients or pools.
- [x] Changed credentials are checked through a fresh TLS connection and the expected runtime identity before activation. Local isolated PostgreSQL evidence verifies fresh-connection and identity behavior; AWS verified-TLS validation remains a deployment gate.
- [x] Each request/transaction stays with one generation; Core repositories and DataSource transition together.
- [x] Old and failed candidate pools close within the documented bound; stalled cleanup blocks further database admission and replacement.
- [x] Retrieval/candidate failures respect cooldown and maximum stale age, then fail closed with sanitized responses.
- [x] Initialization can recover after a transient failure instead of caching a rejected promise forever.
- [x] Database authentication errors trigger only bounded refresh; ambiguous writes/transactions and entire requests are never automatically replayed.
- [x] Integration tests cover both runtime users, real password changes, simultaneous independent refresh, freeze/resume, invalid data, stale expiry, unavailable Secrets Manager, cleanup, and post-recovery database operations. These ran against isolated local PostgreSQL; they are not AWS/TLS evidence.
- [x] Auth signing-secret/session behavior is explicitly tested; simultaneous secret changes stay within the same generation budget.
- [x] The capacity table covers both APIs, both migration executors, administration, operator sessions, retained/deployment overlap, and headroom without treating concurrency arithmetic as a hard connection cap.
- [x] Core's missing runtime concurrency allocation and current SQL capacity verification are explicit activation gates, not assumed values.
- [x] The future-consumer admission contract is documented and requires updating the aggregate budget before activation.
- [x] The manual procedure covers database/secret mismatch, fresh-connection verification, sanitized failures, and restoring a matching pair without claiming zero downtime.
- [x] Logs, responses, artifacts, and Terraform contain no credential values, tokens, connection strings, or raw SDK/SQL errors.
- [x] Focused format, lint, type, unit, and isolated integration checks pass for the changed packages; Terraform checks run only when their inputs change.
- [x] Handoffs explicitly assign Auth live rotation to SPEC 10 and Core live rotation to its future API deployment spec; neither live exercise is claimed complete here.

## Decisions

- **Yes:** cover both existing API implementations with one lifecycle contract and separate service-local clients and identities.
- **Yes:** replace the complete Core Nest generation so injected repositories cannot retain the retired DataSource.
- **Yes:** enforce freshness and cleanup at invocation boundaries; background timers are insufficient across Lambda freeze.
- **Yes:** retain a usable generation only for a finite stale window and bound all retries and overlap.
- **Yes:** require an aggregate RDS budget before activating each new consumer.
- **No:** add a generic framework, new ORM, proxy, or distributed refresh coordinator for hypothetical future services.
- **No:** change migration executors into persistent API-style pools; preserve their per-invocation credential lifecycle.
- **No:** automatic rotation, master fallback, implicit public deployment, or zero-downtime guarantees for single-user password changes.

## Risks

| Risk                                                   | Mitigation                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Both APIs refresh together and exhaust RDS connections | Aggregate overlap accounting, independent-coordinator tests, operational headroom, and a bounded live validation gate. |
| Core repositories keep a retired DataSource            | Replace the complete Nest generation and verify post-refresh HTTP/database operations.                                 |
| Lambda freezes before cleanup or freshness checks run  | Invocation-owned bounded cleanup and elapsed-time checks before database admission after resume.                       |
| Database and secret disagree during rotation           | Document the mismatch window, bounded connection retry, and out-of-band matching-pair recovery.                        |
| A retry duplicates a successful write                  | Never replay requests or ambiguous database operations automatically.                                                  |
| A failed initialization remains cached                 | Clear failed initialization state with cooldown and prove later recovery.                                              |
| Signing-secret changes invalidate sessions             | Test the installed Better Auth behavior and document the exact impact.                                                 |

## References

- [Lambda execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)
- [Secrets Manager rotation strategies and single-user transition behavior](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotation-strategy.html)

## What is **not** in this spec

- Live rotation, secret generation, scheduled rotation, Terraform-managed values, or master-secret fallback.
- Schema/role changes, migration execution, public activation, CI/CD, or Core API deployment.
- RDS Proxy, Redis, another ORM, or speculative infrastructure for future Lambdas.
- A guarantee of seamless signing-secret rotation or uninterrupted single-user password rotation.
