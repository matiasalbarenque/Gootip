# gootip-core

NestJS API that runs as a local HTTP server and as an AWS Lambda event handler.
The same application serves both targets; only the bootstrap entry point differs.

## Requirements

- Node.js 24 (`.nvmrc` at the repository root pins 24.22.1)
- `pnpm@12.14.0` (declared in `packageManager`)

## Install

```bash
pnpm install --frozen-lockfile
```

## Local server

```bash
pnpm dev
```

The server requires a reachable PostgreSQL database and these runtime settings:

```text
POSTGRES_DB_HOST=127.0.0.1
POSTGRES_DB_PORT=5433
POSTGRES_DB_NAME=gootip
POSTGRES_DB_USER=core_runtime
POSTGRES_DB_PASSWORD=<runtime password>
POSTGRES_SSL_MODE=disable
CORE_PG_POOL_MAX=2
```

`POSTGRES_SSL_MODE=verify-full` requires `POSTGRES_CA_PATH` to point to a CA
certificate; the driver verifies both the certificate and database hostname.
Other TLS modes are rejected. Keep migration credentials in the migration
command's environment only; never configure them in the API process.

The shared PostgreSQL service and the `core` schema are provisioned by
`gootip-infra/scripts/local_postgres.sh bootstrap`. Set the runtime password in
`.env` from `CORE_RUNTIME_PASSWORD` in `gootip-infra/local/postgres.env`. The
application does not create schemas or roles. Apply auth and core migrations
with the shared orchestration command:

```bash
../gootip-infra/scripts/local_postgres.sh migrate
```

For migration authoring, use the core migrator credentials only in the CLI
process:

```bash
export POSTGRES_DB_HOST=127.0.0.1 POSTGRES_DB_PORT=5433 POSTGRES_DB_NAME=gootip
export POSTGRES_DB_USER=core_migrator POSTGRES_DB_PASSWORD='<migration password>'
export POSTGRES_SSL_MODE=disable
pnpm migration:generate src/config/database/migrations/<name>
unset POSTGRES_DB_USER POSTGRES_DB_PASSWORD
```

Migrations live in `src/config/database/migrations/`; history is stored in
`core.typeorm_migrations`. Generation only writes a migration file; review it
and add its class to `src/config/database/migrations/index.ts` before testing or
building the runner. Applied migration sources are append-only: add a new
migration rather than editing one already applied. API startup never runs
migrations.

### One-time local catalog rebuild (SPEC 07)

This procedure is authorized only for the local `gootip` database on the
canonical `gootip-local` Compose `postgres` service at `127.0.0.1:5433`. It
discards local category/product rows and the local Core TypeORM history. It does
not reset Auth, roles, credentials, the `core` schema, or the Compose volume.
It is not a startup step or a reusable database-reset command.

Before proceeding, stop every local Core API process. From this directory, load
the existing untracked local credential source and inspect the canonical
service:

```bash
cd ../gootip-infra
set -a
source local/postgres.env
set +a
compose=(docker compose --env-file local/postgres.env -f compose.local.yaml)
"${compose[@]}" ps --all
```

Use the local admin identity for read-only preflight and confirm the actual
database is `gootip`, `auth` is owned by `auth_migrator`, `core` by
`core_migrator`, and every Core object is expected and owned by
`core_migrator`. Confirm the history contains exactly
`CreateCategories1782086400000` and `CreateProducts1793059200000`, the catalog
tables and `typeorm_migrations_id_seq` exist, and no external view or foreign
key depends on the three tables being rebuilt. If the service, database,
identity, owner, history, object inventory, or dependencies differ, stop without
changing anything.

Before the reset, record off-repository, sanitized baselines for: a data-only
dump fingerprint of schema `auth` (including its migration history), the full
Auth migration-history fingerprint, the `auth`/`core` schema owners, local role
credentials and role attributes, Auth object grants, schema grants, and default
privileges. Also record the current Core history read/write policy. For a
PostgreSQL 18 `pg_dump` fingerprint, exclude its per-dump `\restrict` and
`\unrestrict` control lines before hashing. Do not print or track credentials,
credential verifiers, or Auth rows. Compare these protected-state baselines
after the rebuild; the explicitly rebuilt Core tables and history are excluded
from object-level comparisons.

Only after all checks pass, issue these restrictive drops as the owning local
Core migrator. The owned identity sequence for the history table may be removed
with that table; do not drop any sequence separately. Do not use `CASCADE`,
drop the schema/database, run shared `migrate` or `bootstrap`, or reset/remove
the Compose volume.

```bash
"${compose[@]}" exec -T -e "PGPASSWORD=$CORE_MIGRATOR_PASSWORD" postgres psql \
  --host 127.0.0.1 --port 5432 --username core_migrator --dbname gootip \
  --set ON_ERROR_STOP=1 --command \
  'DROP TABLE core.products RESTRICT; DROP TABLE core.categories RESTRICT; DROP TABLE core.typeorm_migrations RESTRICT;'
```

Replay only Core's registered migrations with the explicit local Core migrator
credential. After replay, restore the local runtime history policy (read-only):

```bash
POSTGRES_DB_HOST=127.0.0.1 POSTGRES_DB_PORT="${LOCAL_POSTGRES_PORT:-5433}" \
POSTGRES_DB_NAME=gootip POSTGRES_DB_USER=core_migrator \
POSTGRES_DB_PASSWORD="$CORE_MIGRATOR_PASSWORD" POSTGRES_SSL_MODE=disable \
  corepack pnpm@12.14.0 --dir ../gootip-core migration:run

"${compose[@]}" exec -T -e "PGPASSWORD=$CORE_MIGRATOR_PASSWORD" postgres psql \
  --host 127.0.0.1 --port 5432 --username core_migrator --dbname gootip \
  --set ON_ERROR_STOP=1 --command \
  'REVOKE ALL PRIVILEGES ON TABLE core.typeorm_migrations FROM core_runtime; GRANT SELECT ON TABLE core.typeorm_migrations TO core_runtime; REVOKE ALL PRIVILEGES ON SEQUENCE core.typeorm_migrations_id_seq FROM core_runtime;'
```

Verify that the three-entry migration history is present, all seven renamed
columns exist and their camelCase physical counterparts do not, and both
catalog tables are empty. As `core_runtime`, verify catalog DML succeeds,
runtime DDL and Core history writes fail, and history reads succeed. Recheck the
protected-state baselines and record only sanitized results here. Restart Core
only after these checks pass. If migration replay fails after the authorized
reset, leave the database available for correction; do not extend the reset to
Auth, roles, or the shared volume.

#### SPEC 07 local rebuild evidence — 2026-10-30

- Preflight used the canonical `gootip-local-postgres-1` service, actual
  database `gootip`, and `gootip_local_admin` for read-only inspection. The
  `auth` and `core` schema owners were `auth_migrator` and `core_migrator`.
- Before the rebuild, Core history contained exactly the two original
  migrations. The only Core tables were `categories`, `products`, and
  `typeorm_migrations`; their indexes and owned history sequence were present,
  all objects belonged to `core_migrator`, and no external dependent view or
  foreign key was found. Both catalog tables had zero rows.
- Before/after SHA-256 fingerprints matched for Auth migration history, local
  role credentials and attributes, protected schema/object grants and default
  privileges, and schema ownership. Credential material and Auth rows were not
  recorded. The Auth data-only `pg_dump` fingerprint was not comparable:
  PostgreSQL 18 emits a per-dump `\restrict` token, and repeated dumps of the
  unchanged current Auth schema produced different raw hashes. No Auth
  migrations or writes were run; all rebuild SQL targeted Core. Do not treat
  that raw-hash comparison as proof of Auth row equality.
- The recreated history grants reads to `core_runtime` and denies insert/update/
  delete. Runtime catalog insert/update/delete succeeded inside a rolled-back
  transaction; runtime DDL and history insert/update were denied. The catalog
  tables remained empty with all three migrations recorded. A compiled local
  Lambda probe created and removed a category and product using camelCase
  request fields, received camelCase fields in the response, and exercised
  `sortBy=createdAt` against the rebuilt database. Core restarted and its
  `GET /api/products?sortBy=createdAt&sortOrder=asc` returned an empty page.

### Private migration Lambda (SPEC 06)

The AWS runner is a separate private Lambda. Its only supported AWS entry point
is the `deployment` alias; the ordinary TypeORM CLI is for the local databases
only, not an alternative path to the private RDS database. Do not enable or
invoke the AWS runner until the Infra README's administrative handoff is
verified and the reviewed Terraform plan has been applied.

Build the reviewed commit's artifact from a clean checkout. By default the
manifest records `git rev-parse HEAD`; set `MIGRATION_COMMIT_SHA` only when the
release process has independently established the exact lowercase 40-character
commit being packaged:

```bash
pnpm build:migration-lambda
pnpm migration-lambda:zip
```

Record the build's `commit_sha`, `manifest_sha256`, and `zip_sha256` with the
review. The ZIP contains the bundled handler and manifest; it contains no
credentials. The manifest's per-source hashes identify the packaged migration
files, but TypeORM history does not retain historical source hashes, so this is
not proof that an already-applied source file has not changed.

#### AWS dev catalog rename follow-up — 2026-10-30

After SPEC 07's local-only implementation, a separately authorized dev deployment
updated `lambda_db_config` to recognize the third migration and published Core
migration executor version `2` from commit
`9c5fd9b8878d0823c539b539f0a785fb5c94179a`. The reviewed saved Terraform plan
updated only the two Lambda code artifacts and the Core deployment alias.
No administrative bootstrap invocation or Core API deployment was performed.

Validation reported only `RenameCatalogColumnsToSnakeCase1793318400000` pending.
Apply succeeded, post-validation reported all three migrations applied, and a
repeat apply returned `no_changes`. Read-only verification through the existing
private tunnel confirmed the seven snake_case columns, the category foreign key
and affected index, unchanged ownership/grants, and runtime isolation.
Canonical row fingerprints matched for Auth data/history and Core catalog data;
the catalog tables were empty before and after. This AWS comparison does not
resolve the historical local Auth verification exception above.

Sanitized release, invocation, and before/after evidence is recorded in
[`audit/dev-core-snake-case-20261030.json`](audit/dev-core-snake-case-20261030.json).

#### Preflight and artifact identity

Use the authorized `gootip-terraform-deploy` profile in `us-east-2`. Confirm the
expected account and that no other release is updating the alias. Immediately
before each run, inspect the alias and its published code digest:

```bash
FUNCTION=gootip-dev-core-migrations
PROFILE=gootip-terraform-deploy
aws lambda get-alias --profile "$PROFILE" --region us-east-2 \
  --function-name "$FUNCTION" --name deployment \
  --query '{version:FunctionVersion,routing:RoutingConfig}' --output json

# Substitute the version returned above; routing must be absent or empty.
VERSION=<reviewed-published-version>
aws lambda get-function-configuration --profile "$PROFILE" --region us-east-2 \
  --function-name "$FUNCTION:$VERSION" --query CodeSha256 --output text
openssl dgst -sha256 -binary migration-lambda.zip | openssl base64 -A
```

The Lambda `CodeSha256` and locally computed base64 SHA-256 must match the
reviewed ZIP. Record the alias version and both digests. If the alias has
weighted routing, points to another version, or the digest differs, stop. Prevent
concurrent alias updates through the full migration sequence.

#### Validate, apply, and reconcile

Send only the documented request fields. Use a new `run_id` for every call, and
compare the returned payload—not only Lambda's transport status. An invocation
through the unqualified function, `$LATEST`, or a numbered version is rejected.

1. **Validate before approval to apply.** Use the manifest digest printed by the
   build and the same commit SHA recorded in the manifest. A coherent response
   has `status: "succeeded"`, `error_code: null`, a non-null
   `history_sha256`, and reports pending migrations without changing the
   database. Review the names and migration diff before proceeding.
2. **Apply with the validated history digest.** Set
   `expected_history_sha256` to the exact digest returned by that validation.
   Apply runs every pending migration in one transaction. Accept only
   `status: "succeeded"` or `"no_changes"`, `error_code: null`, an empty
   `pending_names`, and a non-null history digest.
3. **Validate after apply.** Run `validate` again with the same artifact
   identity. Compare its history digest with the successful apply response and
   require an empty `pending_names`.
4. **Repeat apply.** A second apply with the post-validation history digest must
   return `no_changes` and the same history digest.

Example invocation pattern (run separately for each request):

```bash
set -euo pipefail

COMMIT_SHA="$(jq -r .commit_sha dist/migrations/manifest.json)"
MANIFEST_SHA256="$(shasum -a 256 dist/migrations/manifest.json | awk '{print $1}')"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

invoke_migration() {
  local operation="$1" expected_history_sha256="${2-}"
  local run_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  jq -nc --arg operation "$operation" --arg run_id "$run_id" \
    --arg commit_sha "$COMMIT_SHA" \
    --arg expected_manifest_sha256 "$MANIFEST_SHA256" \
    --arg expected_history_sha256 "$expected_history_sha256" \
    '{operation:$operation,run_id:$run_id,commit_sha:$commit_sha,
      expected_manifest_sha256:$expected_manifest_sha256} +
      (if $expected_history_sha256 == "" then {} else
       {expected_history_sha256:$expected_history_sha256} end)' \
    > "$TMP_DIR/request.json"
  aws lambda invoke --profile "$PROFILE" --region us-east-2 \
    --function-name "$FUNCTION:deployment" --invocation-type RequestResponse \
    --cli-binary-format raw-in-base64-out \
    --payload "file://$TMP_DIR/request.json" "$TMP_DIR/result.json" \
    > "$TMP_DIR/invoke.json"
  jq -e '.StatusCode == 200 and .FunctionError == null' \
    "$TMP_DIR/invoke.json" >/dev/null
  jq . "$TMP_DIR/result.json"
}

# First call: inspect and review pending_names; capture history_sha256.
invoke_migration validate
jq -e '.operation == "validate" and .status == "succeeded" and
       .error_code == null and .history_sha256 != null' "$TMP_DIR/result.json"
VALIDATED_HISTORY_SHA256="$(jq -er '.history_sha256' "$TMP_DIR/result.json")"
invoke_migration apply "$VALIDATED_HISTORY_SHA256"
jq -e '(.status == "succeeded" or .status == "no_changes") and
       .error_code == null and .history_sha256 != null and
       (.pending_names | length) == 0' "$TMP_DIR/result.json"
APPLIED_HISTORY_SHA256="$(jq -er '.history_sha256' "$TMP_DIR/result.json")"
# Validate again and compare its digest with APPLIED_HISTORY_SHA256:
invoke_migration validate
jq -e --arg digest "$APPLIED_HISTORY_SHA256" \
  '.status == "succeeded" and .error_code == null and
   .history_sha256 == $digest and (.pending_names | length) == 0' \
  "$TMP_DIR/result.json"
POST_APPLY_HISTORY_SHA256="$(jq -er '.history_sha256' "$TMP_DIR/result.json")"
invoke_migration apply "$POST_APPLY_HISTORY_SHA256"
jq -e '.status == "no_changes" and .error_code == null and
       (.pending_names | length) == 0' "$TMP_DIR/result.json"
```

The operator must inspect the initial validation's pending names and authorize
apply only after reviewing the migration. For `validate`, the helper omits
`expected_history_sha256`; for `apply`, it supplies the immediately preceding
history digest. The example's post-apply checks compare the digest and require
the second apply to return `no_changes`. A transport-level `200` alone is not
success. The temporary request/response files contain only non-secret
correlation fields and sanitized results and are removed when the shell exits.

If invocation times out, returns no usable payload, has `status: "failed"`, or
has a null history digest, **do not retry apply**. Invoke `validate` against the
same alias version and unchanged artifact to reconcile committed history. If
state is incompatible, history is unknown, or prerequisites fail, stop for
separately reviewed remediation; never run `down()`, fake migrations, repair
history, or supply SQL through the event. Do not log secret values, connection
strings, SQL, or raw database errors.

Run unit and shared PostgreSQL integration tests:

```bash
pnpm test:unit
../gootip-infra/scripts/local_postgres.sh integration
```

The integration runner creates isolated test databases and namespaced roles,
runs all three packages serially, then removes only those test resources. It
never removes the shared `postgres_data` volume.

The server listens on `http://localhost:3001/api` by default. Override the port
with `PORT`:

```bash
PORT=3005 pnpm dev
```

Available routes:

| Method  | Path                                          | Response                               |
| ------- | --------------------------------------------- | -------------------------------------- |
| `GET`   | `/api/health`                                 | `200` `{"status":"ok"}`                |
| `GET`   | `/api/categories?page=1&limit=20&search=home` | Public paginated category list         |
| `GET`   | `/api/categories/:id`                         | Public category detail                 |
| `POST`  | `/api/categories`                             | Editor/admin category creation (`201`) |
| `PATCH` | `/api/categories/:id`                         | Editor/admin category update (`200`)   |
| `GET`   | `/api/products?page=1&limit=20`               | Public published-product list          |
| `GET`   | `/api/products/:id`                           | Public published-product detail        |
| `GET`   | `/api/admin/products?page=1&limit=20`         | Editor/admin product list              |
| `GET`   | `/api/admin/products/:id`                     | Editor/admin product detail            |
| `POST`  | `/api/admin/products`                         | Editor/admin product creation (`201`)  |
| `PATCH` | `/api/admin/products/:id`                     | Editor/admin product update (`200`)    |

Category list responses use `{ "data": [...], "meta": { "page": 1,
"limit": 20, "total": 1, "totalPages": 1 } }`. A category is represented as
`{ "id": "<uuid>", "name": "Home", "description": null,
"createdAt": "2026-10-27T12:00:00.000Z", "updatedAt":
"2026-10-27T12:00:00.000Z" }`. Search is a case-insensitive literal substring
match on name. `page` accepts integers from 1 to 10,000 and `limit` from 1 to 100.
Invalid/repeated/unknown query parameters and malformed UUIDs
return `400`; missing categories return `404`; duplicate names return `409`.

Create example:

```bash
curl -i -X POST http://localhost:3001/api/categories \
  -H 'content-type: application/json' \
  -d '{"name":"Home","description":"Home goods"}'
```

Products use USD decimal strings and return the calculated final price. Public
queries always include published products only; admin queries can filter by
`status`. List filters include `search`, `categoryId`, `minPrice`, `maxPrice`,
`inStock=true|false`, `sortBy=createdAt|name|price`, and
`sortOrder=asc|desc`. Pagination defaults to page 1 and limit 20 (maximum 100).

Create a draft with a manual discount, then publish it with a patch:

```bash
curl -i -X POST "$API_URL/api/admin/products" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"sku":"MUG-001","name":"Ceramic mug","categoryId":"<category-uuid>","priceUsd":"12.50","discountPercentage":"10.00","stock":8,"images":["https://cdn.example.com/mug.png"]}'

curl -i -X PATCH "$API_URL/api/admin/products/<product-uuid>" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"status":"published"}'
```

`$ACCESS_TOKEN` must be accepted by the API Gateway JWT authorizer with an
`editor` or `admin` role. Core does not trust bearer-token contents on its own;
direct local protected requests return `401`.

Example public query with combined filters and numbered pagination:

```bash
curl 'http://localhost:3001/api/products?search=mug&categoryId=<category-uuid>&minPrice=10.00&maxPrice=20.00&inStock=true&sortBy=price&sortOrder=asc&page=1&limit=20'
```

List responses use `{ "data": [...], "meta": { "page": 1, "limit": 20,
"total": 1, "totalPages": 1 } }`. A product includes base price,
`discountPercentage`, and computed `finalPriceUsd`, all with two decimal places.
The final price is rounded to the nearest cent with half cents rounded upward.

Unknown routes return `404`. Health performs no database query, but application
startup requires valid database configuration and connectivity. It is not a
readiness probe.

Protected routes require trusted API Gateway HTTP API v2 authorizer context.
Requests made directly to the local HTTP server have no such context and return
`401`; there is no local authentication bypass. Exercise authorized behavior
through synthetic Lambda events and focused guard tests.

Call `app.close()` when the owning process or test is shutting down; Nest's
TypeORM integration closes the application-scoped pool as part of that
lifecycle. The Lambda handler intentionally keeps its app and pool cached for
the lifetime of the execution environment.

```bash
curl -i http://localhost:3001/api/health
```

For a production-style local run, build and start the compiled output:

```bash
pnpm build
pnpm start
```

`pnpm build` writes the compiled application to `dist/build/`.

## Checks

Run these before handing off a change:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
```

- `typecheck`: TypeScript with no emit.
- `lint`: Oxlint over `src/`, `test/`, and `scripts/`.
- `format:check` / `format`: Oxfmt check and fix.
- `test:unit`: Vitest unit coverage that needs no PostgreSQL server.
- `../gootip-infra/scripts/local_postgres.sh integration`: shared PostgreSQL
  integration coverage (auth, core, and db-config).

Tests build the Lambda bundle and ZIP in `test/package-lambda.spec.ts`, then
remove both artifacts.

## Lambda packaging

```bash
pnpm build:lambda
pnpm lambda:zip
```

`build:lambda` compiles with `tsc` first so decorator metadata survives, then
bundles with esbuild into the self-contained ESM file `dist/lambda.mjs`
(`node24` target, `keepNames`, no sourcemap, minified). `lambda:zip` writes
`lambda.zip` with only `dist/lambda.mjs` and a normalized timestamp so repeated
builds produce the same archive.

Contract for future infrastructure:

| Setting      | Value                 |
| ------------ | --------------------- |
| Runtime      | `nodejs24.x`          |
| Architecture | `arm64`               |
| Handler      | `dist/lambda.handler` |
| Artifact     | `lambda.zip`          |

The private migration runner has its own independent artifact and commands:

```bash
pnpm build:migration-lambda
pnpm migration-lambda:zip
```

Its package is `migration-lambda.zip`, handler `dist/migrations/lambda.handler`,
and manifest `dist/migrations/manifest.json`. Build it only after the explicit
migration registry is updated and reviewed; the API Lambda ZIP is unaffected.

The Lambda handler initializes the Nest application once per execution
environment and reuses that promise across invocations. It is designed for an
API Gateway HTTP API payload v2 event; the API Gateway integration, JWT
authorizer, and Terraform resources are outside this package's current scope.

### Authorization deployment contract

API Gateway must apply a JWT authorizer to every protected route and validate
the token signature, issuer, audience, and time claims before invoking this
Lambda. The token issuer must provide a non-empty `sub` and, for catalog
administration, a `role` claim of `editor` or `admin`. Core trusts only these
claims from `requestContext.authorizer.jwt.claims`; it does not validate JWTs
or accept identity from request headers, body, or query parameters. Public
catalog routes remain public and must continue to enforce their normal
visibility rules.

The Lambda integration must not be exposed through an alternative public HTTP
entry point that bypasses API Gateway's JWT authorizer. Configure and verify
authorizer coverage and integration access in the deployment infrastructure;
they are not provisioned by this package.

## Structure

```text
src/
  app.module.ts              Nest module and controller registration
  app.ts                     createApp(): shared application factory
  config/database/           Runtime database configuration and migrations
  modules/categories/         Category API, service, entity, and DTOs
  server.ts                  Local HTTP entry point
  lambda.ts                  Lambda handler with cached initialization
  modules/health/health.controller.ts
scripts/
  build-lambda.mjs           tsc + esbuild bundle
  package-lambda.mjs         Reproducible lambda.zip
  test-unit.mjs              Unit tests without PostgreSQL-dependent suites
test/
  health.spec.ts             Local HTTP behavior
  categories.integration.spec.ts PostgreSQL migration, persistence, HTTP, and Lambda behavior
  lambda.spec.ts             Payload v2 and initialization reuse
  package-lambda.spec.ts     Bundle export and ZIP contents
```

## Conventions

- Kebab-case file and directory paths.
- Exact pinned dependency versions.
- `.js` suffixes on local ESM imports.
- English-only code, tests, and documentation.
- `dist/` and `lambda.zip` are generated and never committed.

## Out of scope (for now)

Terraform and AWS provisioning, JWT validation and issuance, role management,
database access, business routes, DTOs, Swagger, CORS, rate limiting, and
non-Express HTTP adapters.
