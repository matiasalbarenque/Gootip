# Gootip Auth

Authentication backend built with Hono, Better Auth, and PostgreSQL. It exposes
the `/api/auth/*` contract without NestJS, Express, or TypeORM.

## Requirements

- Node.js 24 or newer
- pnpm 12.14.0
- Docker Compose for the shared local PostgreSQL service

## Local setup

```bash
pnpm install
cp .env.template .env
../gootip-infra/scripts/local_postgres.sh bootstrap
../gootip-infra/scripts/local_postgres.sh migrate
pnpm auth:check
pnpm dev
```

Set `POSTGRES_DB_PASSWORD` in `.env` to the local `AUTH_RUNTIME_PASSWORD` from
`gootip-infra/local/postgres.env`. The API connects only as `auth_runtime`;
migrations run separately as `auth_migrator` through the infra script.

The server starts at `http://localhost:3000`. Better Auth is mounted at
`http://localhost:3000/api/auth`, and `GET /health` returns the service health.

`BETTER_AUTH_URL` must be the public application origin, such as
`http://localhost:3000`, without appending `/api/auth`.

## Authentication

Enabled features:

- Email and password registration and sign-in.
- Persistent cookie sessions.
- Bearer session tokens via `set-auth-token`.
- 15-minute JWTs for external services with an explicit `role` claim and user-ID `sub`.
- Better Auth Admin plugin: default `user`, catalog `editor`, and `admin` roles.
- PostgreSQL-backed JWKS using `RS256`.
- JWKS rotation and grace periods of 30 days.

Important endpoints:

| Method | Path                      | Purpose                          |
| ------ | ------------------------- | -------------------------------- |
| `POST` | `/api/auth/sign-up/email` | Register and create a session.   |
| `POST` | `/api/auth/sign-in/email` | Sign in and create a session.    |
| `POST` | `/api/auth/sign-out`      | Revoke the current session.      |
| `GET`  | `/api/auth/get-session`   | Read the current session.        |
| `GET`  | `/api/auth/token`         | Issue a short-lived service JWT. |
| `GET`  | `/api/auth/jwks`          | Return public signing keys.      |
| `GET`  | `/api/auth/ok`            | Better Auth health response.     |

The Bearer plugin expects the session token returned in `set-auth-token`. The
JWT returned by `/token` is intended for external services and is verified with
the keys from `/jwks`; it does not replace Better Auth's session.

### Catalog roles and local users

Public registration assigns `user`; a supplied role is rejected. The Admin plugin
stores roles server-side. Only `admin` has user/session administration permissions;
`editor` has no Better Auth administration permissions and is authorized for
catalog operations by Core. Administrative endpoints such as
`POST /api/auth/admin/create-user` and `POST /api/auth/admin/set-role` require an
authorized Better Auth session, not the external service JWT. Do not expose
trusted server-side `auth.api.createUser` through an unauthenticated custom route.
JWTs include the role snapshot at issuance; changing a role does not invalidate
already issued 15-minute tokens. No role-management UI is added.

Apply the reviewed `000003-auth-admin-roles.sql` through the existing local
migration command, then run from `gootip-auth`:

```bash
pnpm local:seed-users
```

This creates `user@gootip.local`, `editor@gootip.local`, and `admin@gootip.local`
through Better Auth's trusted server API, which hashes passwords. It verifies
sign-in and JWT subject/role, then revokes the verification sessions. Random
passwords are stored only in ignored `.env.local-users.json`, created with mode
`0600`; never commit or paste it into logs. Reruns reuse those credentials and
never reset passwords or change roles for existing users. A mismatched existing
fixture or a lost credential file causes failure instead of overwriting users.
The command accepts only local `gootip` on port 5433 as `auth_runtime`, rejects
AWS secret references/Lambda execution, and does not migrate automatically.
These fixtures do not establish AWS Gateway authorization evidence or create AWS
users. Any AWS activation must first apply the reviewed migration and separately
establish its authorized initial-admin procedure.

### Private AWS initial administrator

After Auth migration `000003` has been applied and validated, the authorized
operator can run `pnpm bootstrap:admin` against the private tunnel. Start
`../gootip-infra/scripts/db_access.sh tunnel` in one terminal with profile
`gootip-db-operator`; in another, use the MFA-protected
`gootip-bootstrap-admin` profile. Supply only the exact existing Auth secret
ARNs and non-secret connection settings through these environment variables:

```bash
export AWS_PROFILE=gootip-bootstrap-admin
export GOOTIP_AUTH_ADMIN_RDS_HOST='<endpoint from db_access.sh info>'
export GOOTIP_AUTH_ADMIN_RDS_CA_PATH='<verified CA path from db_access.sh info>'
export GOOTIP_AUTH_ADMIN_TUNNEL_PORT=15432
export GOOTIP_AUTH_ADMIN_DB_NAME=gootip
export GOOTIP_AUTH_ADMIN_APP_SECRET_ARN='<existing gootip-auth-dev secret ARN>'
export GOOTIP_AUTH_ADMIN_DB_SECRET_ARN='<existing gootip-dev-auth-runtime secret ARN>'
export BETTER_AUTH_URL="$GOOTIP_DEV_API_URL"
export JWT_AUDIENCE=gootip-auth-dev
export FRONTEND_URL=http://localhost:3000
pnpm bootstrap:admin
```

The command rejects other profiles, secret ARNs, RDS hosts, issuers, and
audiences. It reads only those `AWSCURRENT` values into process memory, uses
`auth_runtime` with RDS CA and hostname verification, and requires a 32-character
password entered twice through a hidden terminal prompt. It creates no user if
another admin exists or the requested email already belongs to a non-admin;
rerunning for the same sole admin reports `no_changes` and never resets its
password. It verifies sign-in and revokes the check session. Close the tunnel
manually with Ctrl-C; retain the unique password only in the operator's password
manager.

On 2026-10-31 the authorized operator ran this command against the private dev
tunnel after `000003` was applied and validated. It reported
`Initial administrator created; sign-in verified and session revoked.` The
operator entered the email, name, and password privately; no identity or secret
value is recorded here. A rerun for that same sole administrator is expected to
report `no_changes` and never resets its password.

### Signing-secret rotation

The installed Better Auth `1.7.7` supports versioned `secrets` for encrypted
values and JWT verification. The Auth Lambda reads `AWSCURRENT` and
`AWSPREVIOUS` from the existing app-secret container and passes the current key
first, followed by retained previous keys. Signing-secret JSON uses this shape:

```json
{
  "BETTER_AUTH_SECRET": "<current secret>",
  "BETTER_AUTH_SECRET_VERSION": 2,
  "BETTER_AUTH_PREVIOUS_SECRETS": [
    { "version": 1, "value": "<previous secret>" }
  ]
}
```

Start at version `1` (omitting the version defaults to `1` for the initial
secret). Each rotation must increase the current version and preserve every
still-needed previous `{version, value}` entry in the new secret value;
Secrets Manager's `AWSPREVIOUS` stage supplies only the immediate previous
secret payload; it does not preserve the full key history across repeated
rotations. Carry forward all still-needed keys in
`BETTER_AUTH_PREVIOUS_SECRETS` before publishing each new current value. Before
rotating, verify privately that the current version is a positive integer, the
new version will be greater, every retained key has a unique lower version and
non-empty value, and the list is current-first/descending with no conflicts
against `AWSPREVIOUS`. Never paste secret values into review notes, logs, shell
history, or test output. The runtime validates shape and version consistency,
but cannot establish that an operator retained every key required by old data.
The Lambda fails closed on malformed or duplicate entries and conflicting key
versions rather than replacing the active Auth generation. Identical overlap
between the explicit history and `AWSPREVIOUS` is merged. Old signing keys
must remain available for as long as persisted encrypted values or JWTs need
them.

Better Auth signs its session cookie with the current secret, not the versioned
key list. After a successful rotation, browsers holding old signed session
cookies must sign in again; the rotation does not delete the corresponding
database session rows. Keep prior keys in the versioned list for encrypted
values and JWT verification. A controlled rollback must restore a matching
secret value/version and must not rely on moving a Lambda version alone.
Publishing a rollback value must use a new, higher
`BETTER_AUTH_SECRET_VERSION` and retain the required key history; do not move
`AWSCURRENT` backward as a substitute for recovery. See the SPEC 09 runbook in
`gootip-infra/README.md` for database-pair recovery, connection budget, and
deployment evidence boundaries.

## Database schema

Better Auth uses PostgreSQL's `auth` schema. The shared local database is
provisioned by `gootip-infra`; the API connects as `auth_runtime`, and the
explicit migration runner connects as `auth_migrator`. In AWS the `auth` schema
is provisioned by administration (SPEC 03); the migration role only needs to
create objects inside `auth`.

```bash
../gootip-infra/scripts/local_postgres.sh migrate
pnpm auth:check
```

Migrations are an explicit deployment step and never run during startup.

Local PostgreSQL uses `POSTGRES_SSL_MODE=disable`. AWS uses
`POSTGRES_SSL_MODE=verify-full` with the RDS CA bundle mounted at the path in
`POSTGRES_CA_PATH`; certificate and hostname verification remain enabled.

## Auth migration generation

Schema changes are generated against a disposable local database at the
previous committed schema state, reviewed, and committed as ordered SQL. The
reviewed SQL ledger — not the CLI — is the source of truth for what runs in
AWS.

### Installed tooling (SPEC 04 Stage A evidence)

| Component             | Version | Notes                                                  |
| --------------------- | ------- | ------------------------------------------------------ |
| `better-auth` runtime | `1.7.7` | Exposes `better-auth/db/migration`.                    |
| `auth` CLI            | `1.7.7` | Exact match to the runtime; never `auth@latest`.       |
| Adapter               | Kysely  | `PostgresDialect` + `pg.Pool`, `schemaName: 'auth'`.   |
| PostgreSQL (local)    | `18`    | Shared `postgres:18-alpine` service in `gootip-infra`. |

For the Kysely adapter `auth generate` runs
`getMigrations(options, { throwOnUnsafe: false })` and then
`compileMigrations()`. It introspects the live database and emits only the
delta. `runMigrations()` executes statements one by one with no transaction,
which is why it is never used for AWS deployments.

### Reproducible experiment

Fixtures: an admin-owned `auth` schema, an `auth_migrator` login with
`CREATE` on `auth` only and no `CREATE` on `public`, an `auth_runtime` login
with admin-configured default DML privileges, and a `public.sentinel` table as
a cross-schema tripwire. The five auth tables were then populated with rows.

```bash
# Empty schema: initial SQL (official CLI, real configuration).
POSTGRES_DB_HOST=127.0.0.1 POSTGRES_DB_PORT=5544 \
  POSTGRES_DB_NAME=gootip_exp POSTGRES_DB_USER=auth_migrator \
  POSTGRES_DB_PASSWORD=... POSTGRES_SSL_MODE=disable \
  pnpm exec auth generate --config ./src/auth/auth.cli.ts --output out.sql -y

# Populated schema: re-run reports "Your schema is already up to date."
# Populated schema: additive user.additionalFields change produces only:
#   alter table "auth"."user" add column "nickname" text;
#   alter table "auth"."user" add column "referralCode" text;
#   create index "user_referralCode_idx" on "auth"."user" ("referralCode");
```

Observed:

- Initial generation creates `user`, `session`, `account`, `verification`, and
  `jwks`, three indexes, and `create schema if not exists "auth";`. Every
  statement targets `auth`; `public` is untouched. `jwks` is created by the
  active `jwt()` plugin, so plugin-provided tables are exercised.
- Re-running on the populated database is a no-op; it writes nothing.
- The additive change emits only `ADD COLUMN` and `CREATE INDEX` statements.
  Existing rows keep their values and the new columns stay `NULL`.
- Applying the reviewed SQL as `auth_migrator` succeeds, the objects are owned
  by `auth_migrator`, and `auth_runtime` receives the admin-configured DML
  grants.

### Unsafe-change diagnostics

Adding a required column without a default to a populated table is refused:

- `auth generate` prints
  `⚠ 1 change in this schema corrupts a populated database.` and prefixes the
  script with a `DO NOT RUN THIS SCRIPT` banner.
- `auth migrate` prints `The migration was refused, and nothing ran.`

A required migration must therefore be split into a reviewed nullable add, a
backfill, and a separate `NOT NULL` step.

### Limitations

- The CLI writes a timestamped `<ISO>.sql` filename by default. It does not
  create numbered migration files; ordering comes from the committed ledger.
- Generated SQL includes `create schema if not exists "auth";` whenever tables
  are created. That statement needs `CREATE` on the database, which the AWS
  migrator does not have. The reviewed initial migration drops it because
  administration provisions the `auth` schema first.
- Generation requires a live database and a local migration role. It is a
  developer operation, never a Lambda runtime operation.
- Unsafe-change detection covers required-column addition only. It is not a
  baseline-equivalence proof.

## Private AWS migration invocation

The auth migration runner is a separate private Lambda
(`gootip-dev-auth-migrations`) with its own execution role, security group,
managed log group, and ZIP (`migration-lambda.zip`). It is never invoked by the
auth API and never runs during startup.

### Artifact identity

```bash
pnpm build:migration-lambda
pnpm migration-lambda:zip
shasum -a 256 migrations/manifest.json
```

The `commit_sha` in the event must match the manifest's `commit_sha`.
`expected_manifest_sha256` is the SHA-256 of the exact `migrations/manifest.json`
bytes packaged in the ZIP; the handler compares it before any database access.
`expected_history_sha256` is the digest returned by a previous successful
invocation and is used to revalidate activation history.

### Aliases and operations

| Alias        | Allowed operations                 | Who may invoke                  |
| ------------ | ---------------------------------- | ------------------------------- |
| `deployment` | `validate`, `apply`                | Authorized deployment operator  |
| `baseline`   | `baseline_check`, `baseline_adopt` | Separate explicit authorization |

The handler derives the operation path from the invoked Lambda ARN, never from
the event. Unqualified, numeric-version, `$LATEST`, unknown-alias, and
wrong-alias invocations fail before Secrets Manager or database access. In dev,
the deployment role is granted `InvokeFunction` only on the `:deployment` alias;
invoking `:baseline` with that role is denied by IAM.

### Normal validation and application

```bash
aws lambda invoke \
  --function-name arn:aws:lambda:us-east-2:123456789012:function:gootip-dev-auth-migrations:deployment \
  --payload fileb://event.json \
  --cli-binary-format raw-in-base64-out \
  response.json
```

```json
{
  "operation": "validate",
  "run_id": "deploy-2026-10-19-1",
  "commit_sha": "<40-character lowercase commit>",
  "expected_manifest_sha256": "<manifest sha256>"
}
```

Run `validate` first. `pending_ids` lists reviewed SQL that would run and
`applied_ids` lists history already present. Then run `apply` with the same
correlation fields. A second `apply` returns `no_changes`; it does not duplicate
history or schema objects. After activation waits, run `validate` with the
digest from the applied result in `expected_history_sha256` to prove history did
not change.

Accept a result only when all of these hold:

- The invoke call has no `FunctionError`.
- `status` is `succeeded` or the expected `no_changes`.
- `manifest_sha256` equals the packaged manifest.
- `history_sha256` equals the expected digest for revalidation.
- `pending_ids` is empty for a completed apply.
- `error_code` is null.

HTTP 200 from Lambda is not migration success. A missing, malformed, or
unexpected response is a failure.

### SPEC 08 incremental migration evidence

On 2026-10-21, the reviewed v3 artifact contained migration
`000002-auth-rate-limit.sql`; the manifest SHA-256 was
`5794f1ab9089939b0a6e8998789a3123daacfc82cd7d9b1ab54dc239e0a8630c`, the ZIP
SHA-256 was `176bc7b4a8b22c6824487ee72fe54f9e1573a4ef2117a34de1aa9eeabf794548`,
and the Lambda `CodeSha256` was
`F2vHtKiyLGgkSH7nL+VPnhVzpO8hF6NN4aqe6r95RUg=`. Before apply, `validate`
reported `applied_ids: ["000001"]` and `pending_ids: ["000002"]`. `apply`
succeeded for `000002`; post-apply `validate` succeeded with both IDs applied,
no pending IDs, and history SHA-256
`b1039422517fae6f2a66a3262f41f47033e839f6ce7e62d1cbc2578682cc79e5`. The
`deployment` alias points to v3; `baseline` remains on v2.

On 2026-10-31, the reviewed v4 artifact contained migration
`000003-auth-admin-roles.sql`; the manifest SHA-256 was
`71d904de09d84ae8f99f48e49dea9a5d888ec8d4c7f3192a78ce19312718d158` and the local
`migration-lambda.zip` SHA-256 was
`9a37d5cc3acd99f5d36f13237691cf2437e0ecbb484ae088e1526cc740c85f3a` from commit
`91bb71fbb5312f8d4c3ea85d3bd460fdb601bbb5`. The `deployment` alias executed
version 4 for every invocation below. Pre-apply `validate` reported
`applied_ids: ["000001", "000002"]`, `pending_ids: ["000003"]`, and history
SHA-256 `b1039422517fae6f2a66a3262f41f47033e839f6ce7e62d1cbc2578682cc79e5`.
`apply` succeeded for `000003` only, with no `FunctionError` and no pending IDs.
Post-apply `validate` succeeded with all three IDs applied, no pending IDs, and
history SHA-256
`8e1500183e9e0c09bcc8cdd36232c1323b3dfcd70cada4c16062357c7bc5ab38`. The
deployed version `CodeSha256` was not read because `GootipTerraformDeploy` has no
`lambda:GetFunction` permission on that function; only the local ZIP digest is
recorded here.

### Baseline path

When the database already contains auth application objects without reliable
history, normal `apply` returns `baseline_approval_required` and changes
nothing. `baseline_check` compares the live structure with the reviewed initial
schema, and `baseline_adopt` records the approved history only after
revalidating checksum, fingerprint, and history digest under the lock. The
`baseline` alias is not reachable by the normal deployment role. Enabling an
operator invocation for it requires a separate reviewed authorization.

### Limits and concurrency

Configured dev limits: 512 MB memory, 600 s Lambda timeout, 10 s connect, 30 s
lock, 120 s statement, 300 s operation. Measured dev durations were under 0.5 s
per invocation plus Lambda init. The runner holds one dedicated connection and
an advisory lock keyed by database and schema. Do not run administrative
ownership/privilege reconciliation concurrently with `apply`. SPEC 11 must also
set workflow concurrency with `cancel-in-progress: false`; workflow concurrency
does not replace the database lock.

### Failure and recovery

- **Timeout or caller cancellation:** treat the result as unknown. Invoke
  `validate` through the `deployment` alias to reconcile committed history, then
  retry `apply` only if the packaged manifest is unchanged.
- **SQL failure:** that migration's transaction rolled back and later migrations
  did not run. Fix forward with a new reviewed migration; do not edit applied
  history.
- **Function error or malformed result:** do not assume rollback. Inspect the
  sanitized log report, then reconcile with `validate`.
- **Rollback:** there is no automatic schema rollback. Deploy application code
  compatible with the applied schema; destructive contract changes require a
  separately reviewed operation and backup evidence.
- **Restore:** use the private SPEC 02.2 snapshot/PITR procedure. Never add a
  public RDS endpoint to recover.
- **Backup evidence:** before destructive or unusually risky changes, verify a
  current recovery point through SPEC 02.2. Configured retention alone is not
  proof that a usable backup exists.

### Unsupported changes

The runner rejects transaction control, role switching, and nontransactional SQL
inside migration files. Out of scope: `CREATE INDEX CONCURRENTLY`, long
backfills, operations exceeding the 600 s Lambda limit, and destructive changes
that require a maintenance window.

### SPEC 11 handoff

SPEC 11 must invoke the exact published migration Lambda version, pass the
reviewed manifest digest and commit, verify `FunctionError`, status, digests,
and pending history, and block auth activation on failure or uncertainty. It
must not use `$LATEST`, an unqualified ARN, or the baseline alias. Migration
success must be revalidated after approval waits; changed history blocks
activation.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm build:lambda
pnpm lambda:zip
```

## AWS Lambda

`src/lambda.ts` uses the official `@hono/aws-lambda` adapter. At cold start it
optionally reads:

- `BETTER_AUTH_SECRET` from the JSON secret referenced by `SECRET_ARN`.
- The PostgreSQL runtime credential from the JSON secret referenced by
  `DB_RUNTIME_SECRET_ARN`: `username` must be `auth_runtime` and `password` is
  required. Both are applied to `POSTGRES_DB_USER` and `POSTGRES_DB_PASSWORD`
  before Better Auth is created.

The loader is fail-fast and never logs values: a missing secret, missing or
malformed JSON, a missing username or password, or a username other than
`auth_runtime` aborts initialization before Better Auth, the Hono app, or any
database connection exists. A `GetSecretValue` failure is replaced with a fixed
message that names only the environment variable (`SECRET_ARN` or
`DB_RUNTIME_SECRET_ARN`) and drops the cause, so the SDK error can never print
the secret ARN, the request payload, or a value. An existing
`BETTER_AUTH_SECRET` is preserved; the runtime secret is authoritative for the
database credential. The master secret is never part of the authentication
configuration.

The artifact contract is checked on the built ZIP:

```bash
pnpm build:lambda && pnpm lambda:zip
unzip -l lambda.zip                                                 # dist/lambda.mjs only
unzip -p lambda.zip dist/lambda.mjs | grep -c DB_MASTER_SECRET_ARN  # 0
unzip -p lambda.zip dist/lambda.mjs | grep -c DB_RUNTIME_SECRET_ARN # 1
```

The bundle is emitted as `dist/lambda.mjs`; the Lambda handler is
`dist/lambda.handler`. `pnpm lambda:zip` creates `lambda.zip` with that bundle.

## PostgreSQL integration checks

The auth integration suites use isolated databases and namespaced roles on the
shared local PostgreSQL server. Run the repository-wide serial integration
entry point instead of creating a test container:

```bash
../gootip-infra/scripts/local_postgres.sh integration
```

The runner serializes auth, core, and db-config integration tests and removes
only their exact test databases and roles. Unit tests remain available without
the shared server; the production credential loader is tested against its
fixed `auth_runtime` identity.
