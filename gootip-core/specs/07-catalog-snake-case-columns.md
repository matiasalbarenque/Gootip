# SPEC 07 — Catalog snake_case columns

> **Status:** Implemented
> **Depends on:** Core [SPEC 05](05-products-and-pagination.md), [SPEC 06](06-private-typeorm-migrations.md); Infra [SPEC 13](../../gootip-infra/specs/13-shared-local-postgresql.md), [SPEC 14](../../gootip-infra/specs/14-core-administrative-bootstrap.md)
> **Date:** 2026-10-30
> **Objective:** Use snake_case columns in Core's catalog tables while preserving the camelCase API and rebuilding only the authorized local Core tables.

## Why this spec exists

The catalog currently inherits database column names from camelCase entity properties.
Use explicit database names for the seven affected columns in `core.categories` and `core.products`.
TypeScript properties, DTOs, query parameters, and JSON responses remain camelCase.

SPEC 06's recorded dev evidence confirms that both existing migrations have already run in AWS.
SPEC 14 also validates Core history against a fixed migration list.
Therefore, append a third migration and update the administrative compatibility guard rather than rewriting existing migrations.
The user's choice to discard local Core data applies only to the local rebuild, not to migration source history or AWS data.

## Scope

**In:**

- Explicit column-name mappings in both catalog entities.
- One reversible TypeORM migration that renames the seven columns.
- Updates to SQL expressions, migration registration, tests, and affected documentation.
- A narrow update to the database-config migration expectations and their tests.
- A documented, guarded one-time rebuild of the two local Core business tables and their TypeORM history.
- Local verification on SPEC 13's shared PostgreSQL server and disposable test databases.
- Local migration-artifact build and validation using SPEC 06's existing tooling.

**Out of scope:**

- AWS access, Terraform plans/applies, secret operations, Lambda publication, alias changes, or remote SQL execution.
- Core or administrative Lambda deployment and activation.
- Changes to Auth data, migrations, grants, roles, or credentials.
- Renaming TypeScript properties, API fields, DTOs, query parameters, tables, constraints, or indexes.
- Rewriting applied migrations, fake migration history, or introducing another migration engine.
- A global naming strategy, new dependencies, or unrelated entity/schema cleanup.
- Resetting the shared database, dropping the schema, or deleting Docker containers or volumes.

## Data model

No business fields or data types are added or removed.
Only physical PostgreSQL column names change.

| Table             | Existing database column / retained TypeScript property | New database column   |
| ----------------- | ------------------------------------------------------- | --------------------- |
| `core.categories` | `createdAt`                                             | `created_at`          |
| `core.categories` | `updatedAt`                                             | `updated_at`          |
| `core.products`   | `categoryId`                                            | `category_id`         |
| `core.products`   | `priceUsd`                                              | `price_usd`           |
| `core.products`   | `discountPercentage`                                    | `discount_percentage` |
| `core.products`   | `createdAt`                                             | `created_at`          |
| `core.products`   | `updatedAt`                                             | `updated_at`          |

Use `name` options on `@Column`, `@CreateDateColumn`, and `@UpdateDateColumn`.
For example, `categoryId` maps to database column `category_id`.
Keep existing column types, nullability, precision, defaults, and timestamp handling.
Single-word columns such as `id`, `name`, `sku`, and `stock` remain unchanged.
The `core.typeorm_migrations` structure remains unchanged.

## Migration and compatibility contracts

Add `src/config/database/migrations/1793318400000-RenameCatalogColumnsToSnakeCase.ts`.
Its class and explicit name are `RenameCatalogColumnsToSnakeCase1793318400000`.
The identifier sorts after the two existing migrations.

`up()` uses explicit `ALTER TABLE ... RENAME COLUMN` statements.
`down()` reverses those statements without dropping or recreating business tables.
Reject an unexpected starting schema through normal migration failure rather than silently skipping missing columns.
The migration preserves rows, IDs, relationships, constraints, indexes, defaults, owners, and grants.
It must run through the existing transaction and locking behavior of the migration executor.

Keep the original category and product migration source files byte-for-byte unchanged.
Append the new class to `src/config/database/migrations/index.ts`.
The generated manifest must contain all three migrations in order with their actual source digests.
Do not edit old manifests, published artifacts, or the dated SPEC 06 audit evidence.

Update `CORE_MIGRATION_EXPECTATIONS` in `gootip-db-config/src/gootip_db_config/config.py`.
Append the new migration with the cumulative application table set `categories` and `products`.
The administrative inventory must accept valid two-migration and three-migration prefixes.
Retain rejection of unknown, duplicate, reordered, or incompatible history and unexpected objects.
Do not weaken the fixed-role, ownership, or privilege checks.
This is a source-code compatibility change tested locally, not an administrative AWS operation.

The currently deployed AWS API/executor/bootstrap versions remain unchanged.
A future AWS rollout must deploy the compatible administrative code and coordinate the schema rename with the Core API version.
That rollout and its ordering are outside this spec.

## Queries and API compatibility

Audit every direct SQL reference to the renamed columns.
Update price/discount expressions, ordering expressions, and integration-test inserts.
Use TypeORM property paths where it resolves entity mappings; use the physical snake_case names in raw SQL.
Verify the final executed SQL against PostgreSQL rather than relying only on mocked query-builder assertions.

Clients still send and receive `categoryId`, `priceUsd`, `discountPercentage`, `createdAt`, and `updatedAt`.
Sorting continues to accept `sortBy=createdAt`.
Preserve decimal-string money handling, computed prices, filtering, pagination, and role-based visibility.
No frontend change is required by this contract.

## Authorized local rebuild

The user explicitly chose to discard existing local category/product data.
This authorization covers only the canonical SPEC 13 development database `gootip` on the shared local server at `127.0.0.1:5433`.
Test databases remain governed by SPEC 13's independent allowlists and role namespaces.

Document the one-time procedure in Core's README, using the canonical Compose service and existing local credential source.
Do not introduce a recurring reset, automatic startup reset, or general-purpose destructive command.
Never print credentials or copy them into tracked instructions.

Before destructive SQL:

- Stop local Core API processes so old entity mappings cannot query during the transition.
- Verify the canonical local Compose service, actual database, current identity, expected schema owner, and owned object inventory.
- Confirm the two original migrations and expected table/sequence dependencies are present.
- Record read-only baselines for Auth data/history, schema ownership, role credentials, and relevant grants/default privileges.
- Stop if an unexpected dependent object or database target is found.

Drop only `core.products`, then `core.categories`, and then `core.typeorm_migrations`, using the owning local Core migrator identity.
Use restrictive drops without `CASCADE`.
The history table's owned identity sequence may disappear with that table; do not remove unrelated sequences.
Preserve the `core` schema, schema owner, roles, passwords, and default privileges.
Do not drop the database or run a volume reset.

Replay all three registered migrations with the explicit local Core migration credential.
Use a Core-only procedure rather than the shared `migrate` or `bootstrap` commands, which also reconcile Auth and credentials.
Restore SPEC 13's local runtime policy on the recreated history: allow reads, deny writes.
Retain the stricter AWS-like history isolation inside the disposable migration-runner fixtures.
Verify runtime catalog DML and denial of runtime DDL after rebuilding.

The rebuild intentionally leaves empty catalog tables.
Do not import old catalog rows or add development seeds implicitly.
If replay fails after the authorized reset, report the failure and leave the local database available for correction.
Do not extend the reset to Auth, roles, or the shared volume to recover.
Compare the recorded protected-state baselines and restart Core only after the new schema and mappings are verified.

## File boundaries

Paths are relative to the named project.

| Project / paths                                                                                                | Responsibility                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Core: `src/modules/categories/category.entity.ts`, `src/modules/products/product.entity.ts`                    | Explicit physical column names, retained TypeScript property names                        |
| Core: `src/config/database/migrations/1793318400000-RenameCatalogColumnsToSnakeCase.ts`, `migrations/index.ts` | Append-only rename migration and registration                                             |
| Core: `src/modules/products/product.service.ts`                                                                | Compatible price, filtering, and ordering SQL                                             |
| Core: `test/products-list.service.spec.ts`, `products.integration.spec.ts`, `categories.integration.spec.ts`   | SQL expectations, unchanged HTTP behavior, updated history assertions                     |
| Core: `test/migration-integration.spec.ts`, `migration-artifact.spec.ts`, affected manifest/runner fixtures    | Three-migration registry, fresh/upgrade paths, transactional execution, artifact contents |
| Core: `README.md`                                                                                              | Database naming convention and guarded Core-only local rebuild instructions/evidence      |
| DB config: `src/gootip_db_config/config.py`, `tests/test_inventory.py`, affected `tests/integration/` fixtures | Accept the new valid history prefix without relaxing existing safeguards                  |

Reuse the canonical integration workflow and existing database guards.
Update other directly affected test assertions discovered while tracing these callers.
Do not change Terraform, SPEC 06's historical evidence, deployed artifacts, or SPEC 13's development privilege contract.

## Implementation plan

1. Add the third rename migration and registry entry together with both entity mappings, product SQL expressions, and directly affected test assertions as one coordinated change. Preserve existing migration source bytes so the registered schema and application mappings remain aligned.
2. Add focused disposable-database coverage for the populated original-to-renamed transition and its reverse. Verify retained data, camelCase HTTP input/output, and price/filter/sort behavior against the renamed schema.
3. Extend the administrative migration expectation list and test valid two-entry and three-entry histories, repeated reconciliation, and continued rejection of invalid histories and unrelated objects.
4. Update runner/artifact and catalog integration coverage for fresh replay and incremental rename. Reuse SPEC 13's serial test workflow, restore shared test fixtures, and validate the locally built migration ZIP and manifest.
5. Document and perform the authorized one-time Core-only local rebuild after verifying the local target and protected-state baselines. Replay all three migrations, restore the local history grant policy, verify the camelCase API and preserved Auth/role state, and record sanitized local evidence in the README.

## Acceptance criteria

- [x] All seven listed database columns use snake_case; their camelCase physical counterparts no longer exist.
- [x] Types, defaults, nullability, money precision, foreign keys, constraints, indexes, owners, and expected grants remain correct.
- [x] The first two migration source files are unchanged and the registry/manifest contain the third migration in order.
- [x] Applying the rename to populated disposable tables preserves IDs, values, timestamps, and category/product relationships.
- [x] Reverting only the rename restores the former column names and retains the same fixture data.
- [x] Fresh migration replay and upgrade from the two-entry history both succeed; a repeated apply reports no pending changes.
- [x] The existing runner retains batch rollback, locking, and AWS-like history isolation in its namespaced fixtures.
- [x] Product price filtering, discounted-price sorting, category filtering, and created-date sorting execute successfully against PostgreSQL.
- [x] API requests, responses, and query parameters retain their existing camelCase contract and validation behavior.
- [x] Administrative inventory accepts both two-entry and three-entry valid prefixes, including idempotent reconciliation after the rename, while rejecting incompatible histories.
- [x] Unit tests remain database-free; database tests run through the existing guarded serial integration workflow.
- [x] Local reset targets only the two catalog tables and TypeORM history in the canonical development database; unrelated dependencies cause a stop instead of cascading deletion.
- [x] The local development database has empty renamed catalog tables and a three-entry TypeORM history after replay.
- [x] Local runtime catalog DML works, DDL and history writes are denied, and the existing local history-read policy is preserved.
- [x] Preservation checks passed for Auth migration history, shared roles and credentials, schema ownership, and relevant grants/default privileges, excluding the explicitly rebuilt Core objects. **User-accepted exception:** Auth row-data equality was not demonstrated because the original dumps were unavailable and PostgreSQL 18 raw `pg_dump` hashes were non-deterministic; the user accepts this limitation.
- [x] Relevant Core format, lint, type, unit, integration, API build, and migration-artifact checks pass. (Formatting passed for changed files; the repository-wide check separately reports `gootip-core/audit/dev-core-migrations-20261030.json`.)
- [x] Focused database-config validation and reconciliation tests pass against the shared local PostgreSQL server.
- [x] No AWS resources, remote database objects, published Lambda versions, or deployed aliases were changed for SPEC 07. The AWS deployment statement in the prior response was incorrect; SPEC 07 did not deploy this migration.

## Decisions

- **Yes: PostgreSQL snake_case with camelCase TypeScript/API.** The user selected a database-only naming change.
- **Yes: discard existing local Core catalog data and reconstruct its history.** The user selected a local rebuild; Auth and shared infrastructure remain protected.
- **Yes: append a rename migration instead of editing the original migrations.** SPEC 06 has already executed those source identities in AWS dev.
- **Yes: test data preservation even though local development is reset.** The new migration must remain usable as an upgrade when AWS rollout is separately authorized.
- **Yes: explicit `name` mappings.** Two tables do not justify a new global naming strategy or dependency.
- **Yes: update the fixed administrative history expectations.** Otherwise a later bootstrap rejects a valid third migration.
- **Yes: prepare compatible source changes locally without AWS execution.** The user explicitly excluded AWS from this feature's implementation scope.
- **No: reuse the shared bootstrap/migrate command for the rebuild.** Those commands also touch Auth or credentials beyond the authorized reset.
- **No: rewrite SPEC 06's implementation evidence.** Its two-migration record describes a completed historical deployment.

## Risks

| Risk                                                                   | Mitigation                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Reset targets the shared database or Auth by mistake.                  | Pin the local Compose service and database, inventory exact Core objects, use restrictive drops, and compare protected-state baselines. |
| Old code queries camelCase columns after the rename.                   | Stop Core during the local transition and restart only with verified new mappings.                                                      |
| Quoted raw SQL bypasses TypeORM's property mapping.                    | Audit every SQL reference and exercise real PostgreSQL price/filter/order paths.                                                        |
| Administrative bootstrap rejects the new history entry.                | Extend the fixed list and test old/new valid prefixes without deploying it in this scope.                                               |
| Recreating history restores runtime write privileges through defaults. | Revoke local history writes before restarting Core and preserve stricter permissions in migration fixtures.                             |
| Local code moves ahead of the deployed AWS schema.                     | Leave AWS untouched and require a separately reviewed coordinated rollout before activating updated code there.                         |

## What is **not** in this spec

No AWS deployment or SQL execution, Auth reset, shared-role change, container/volume deletion, migration-history rewriting in AWS, API field rename, global naming strategy, new dependency, or unrelated schema cleanup is included.
