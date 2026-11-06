# SPEC 04 — Categories

> **Status:** Implemented
> **Depends on:** SPEC 02, SPEC 03
> **Date:** 2026-10-22
> **Objective:** Provide a persistent flat category catalog with public reads and editor/admin creation and editing.

## Scope

**In:**

- Category entity, migration, Nest module, service, DTOs, and controllers.
- Public category list/detail and protected creation/update.
- Name search, deterministic ordering, and a shared numbered-pagination contract.

**Out of scope (for future specs):**

- Category deletion, deactivation, hierarchy, subcategories, images, slugs, and multiple categories per product.
- Product implementation, delivered by SPEC 05.

## Data model

```ts
type CategoryResponse = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};
```

- Store categories in `core.categories`, with UUID primary key and timezone-aware timestamps serialized as ISO 8601 UTC.
- Trim names; require 1–120 characters. Enforce uniqueness using a database unique index on `lower(name)` so concurrent requests cannot create case-only duplicates.
- Description is nullable, trimmed, and limited to 5,000 characters; an empty description becomes `null`.
- `PATCH` changes only supplied properties. Explicit `null` clears description and is invalid for name. Reject an empty update.
- Future products reference categories through a non-null foreign key; this spec introduces no product table.

## API and pagination contract

| Method | Route                 | Access       | Behavior                                                 |
| ------ | --------------------- | ------------ | -------------------------------------------------------- |
| GET    | `/api/categories`     | Public       | Paginated category list, including empty categories.     |
| GET    | `/api/categories/:id` | Public       | Category detail.                                         |
| POST   | `/api/categories`     | Editor/admin | Create from name and optional description; return `201`. |
| PATCH  | `/api/categories/:id` | Editor/admin | Update name or description; return `200`.                |

- List query: `page`, `limit`, and optional `search` with 1–120 trimmed characters. Search is case-insensitive literal substring matching on name; escape SQL wildcard characters supplied by the user.
- Default `page=1`, `limit=20`; page must be an integer from 1 to 10,000, and limit an integer from 1 to 100. Reject malformed, repeated, unknown, or out-of-range query parameters with `400`. Reject offsets outside JavaScript's safe integer range.
- Order by name ascending, then UUID ascending. Database collation defines alphabetical order.
- Response: `{ data, meta: { page, limit, total, totalPages } }`, where `total` counts matching records and `totalPages = Math.ceil(total / limit)`.
- No matches means an empty list and `totalPages=0`. A page beyond the last returns an empty list with the requested page and the matching total.
- Introduce small shared pagination DTO/response definitions under `src/helpers/pagination/`, reused by SPEC 05. Keep entity-specific filtering in its service; do not build a generic query framework.
- Invalid input or UUID returns `400`; missing category returns `404`; duplicate name returns `409`. Preserve Nest's standard exception response format.

## Implementation plan

1. Create `CategoriesModule`, the entity and reviewed migration for `core.categories`, including the unique name index. Register the entity and migration explicitly with SPEC 02's runtime and CLI configuration.
2. Add the common pagination DTO and metadata contract, create/update DTOs, and category service using an injected `Repository<Category>`. Use parameterized TypeORM queries for search, pagination, and count.
3. Add public read routes and protected write routes using SPEC 03 permissions. Map the expected name uniqueness violation to `409`; do not expose SQL or database internals.
4. Add real PostgreSQL integration tests for persistence, migration, uniqueness, list counts, and search. Add HTTP/Lambda tests for validation and permissions, then document routes and example responses.

## Acceptance criteria

- [x] Applying the migration to disposable PostgreSQL creates only the expected core category objects and migration history.
- [x] Creation and editing persist normalized names/descriptions and return the response contract.
- [x] Duplicate names differing only by case return `409`, including concurrent creates.
- [x] Unknown fields, invalid UUIDs, empty names/updates, and invalid pagination return `400`.
- [x] Missing category detail/update returns `404`.
- [x] Anonymous clients read categories; only editor/admin can create or edit them.
- [x] Search, counts, empty results, pages beyond the end, and deterministic ordering follow the contract.
- [x] SQL wildcard input is treated literally and all search values are parameterized.
- [x] No category deletion or deactivation endpoint is introduced.

## Decisions

- **Yes: flat categories and one required category per product.** This is the agreed initial shop organization.
- **Yes: pagination shared with products.** Introduce the small common contract at its first consumer rather than duplicate it later.
- **Yes: database-enforced case-insensitive name uniqueness.** Application-only prechecks cannot prevent races.
- **No: category deletion use case.** It is explicitly excluded, including deletion/reassignment workflows.

## What is **not** in this spec

No product logic, category deletion, hierarchy, deactivation, or AWS deployment is included.
