# SPEC 05 — Products and pagination

> **Status:** Implemented
> **Depends on:** SPEC 04
> **Date:** 2026-10-22
> **Objective:** Provide a single-store physical product catalog with USD prices, manual discounts, stock, publication states, and paginated public and administrative queries.

## Scope

**In:**

- Product entity, migration, Nest module, service, DTOs, and public/admin controllers.
- Creation, editing, publication, archiving, stock editing, and ordered image URLs.
- USD base/final prices and a manually controlled percentage discount.
- Database-side search, category/price/availability filtering, ordering, and numbered pagination.

**Out of scope (for future specs or other projects):**

- Multiple stores, sellers, variants, brands, type-specific attributes, multiple categories, and physical product deletion.
- Cart, orders, checkout, payments, shipping, reservations, stock movement history, and automatic inventory deductions.
- Currency conversion, exchange rates, promotions engine, scheduled discounts, tax computation, and file uploads.
- Authentication implementation, role editing, AWS provisioning, and deployment.

## Data model

```ts
type ProductStatus = 'draft' | 'published' | 'archived';
type ProductResponse = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  categoryId: string;
  priceUsd: string;
  discountPercentage: string;
  finalPriceUsd: string;
  stock: number;
  images: string[];
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
};
```

- Store products in `core.products` with UUID primary key, timezone-aware timestamps, and a required foreign key to `core.categories`. Do not cascade category or product deletion.
- SKU: trim, normalize to uppercase, require 1–100 characters, and enforce uniqueness in PostgreSQL. Name: trim and require 1–200 characters. Description follows the nullable, trimmed, 5,000-character convention of SPEC 04.
- `priceUsd`: PostgreSQL `numeric(12,2)`, strictly positive, at most `9999999999.99`. Accept a plain decimal string with at most two decimal places and serialize with exactly two. Reject exponent notation, excess precision, and non-string values.
- `discountPercentage`: PostgreSQL `numeric(5,2)`, from `0` to `100` inclusive, default `0.00`. Accept a plain decimal string with at most two decimal places; serialize with exactly two. No start/end dates: an editor/admin changes or removes the discount manually.
- `stock`: PostgreSQL integer, from `0` to `2147483647`, default `0`. Zero means out of stock and does not hide a published product. Editing replaces the current quantity; no stock ledger or reservation is implied.
- `images`: PostgreSQL text array, default empty, preserving order. Accept at most 20 absolute HTTPS URLs, each at most 2,048 characters. The first URL is the main image. The API stores URLs without fetching their content.
- `status`: default `draft`, constrained to the three agreed values. Every product, including drafts, requires SKU, name, existing category, and positive base price. Images are optional in every state.
- `createdAt` and `updatedAt` are server-controlled ISO 8601 UTC values. Reject client-supplied IDs, timestamps, currency, or final prices.
- Database checks enforce price/discount/stock bounds and status; constraints and foreign keys protect concurrent writes as well as HTTP requests.

## Pricing and publication rules

- Core stores only USD. Other currency conversion belongs to the frontend.
- Return base price, discount, and computed final price. Never persist or accept `finalPriceUsd` from the client.
- Convert exact price strings to integer cents and percentages to integer hundredths of a percent. Calculate `priceCents * (10000 - discountBasisPoints) / 10000`, rounding once to the nearest cent, with half cents rounded upward. Use exact integer arithmetic, not binary floating-point money calculations.
- Use an equivalent PostgreSQL numeric expression for price filters and sorting: `round(price_usd * (100 - discount_percentage) / 100, 2)`. Test parity with response calculations.
- A discount of `0` preserves base price; `100` produces a free final price while base price remains positive.
- Creation always starts in `draft`. Reject `status` in creation DTOs. A protected patch can move between any of `draft`, `published`, and `archived` while preserving required fields.
- Archived products keep their data and SKU uniqueness; they can be edited and republished. Public reads return only `published`, including stock-zero products unless availability is filtered.
- Publish does not require an image or positive stock. This catalog has no checkout and makes no guarantee about later sale inventory.

## API and list queries

| Method | Route                     | Access       | Behavior                                            |
| ------ | ------------------------- | ------------ | --------------------------------------------------- |
| GET    | `/api/products`           | Public       | Published products only.                            |
| GET    | `/api/products/:id`       | Public       | Published detail; otherwise `404`.                  |
| GET    | `/api/admin/products`     | Editor/admin | All states, optionally filtered.                    |
| GET    | `/api/admin/products/:id` | Editor/admin | Detail in any state.                                |
| POST   | `/api/admin/products`     | Editor/admin | Create draft; return `201`.                         |
| PATCH  | `/api/admin/products/:id` | Editor/admin | Edit supplied fields or change state; return `200`. |

- Create requires `sku`, `name`, `categoryId`, and `priceUsd`. Optional fields use the defaults above.
- Patch permits mutable product fields; omitted fields remain unchanged. Only description accepts `null`; reject empty patches. Supplying images replaces the entire array, and `[]` clears it.
- Shared pagination uses SPEC 04's defaults, limits, errors, and `{ data, meta }` response. Pagination runs in SQL, never after loading the full catalog.
- `search`: trimmed string of 1–200 characters, matching a case-insensitive literal substring of name OR SKU. Escape user-supplied SQL wildcards and parameterize values.
- `categoryId`: valid UUID; a well-formed ID with no matching category produces an empty list.
- `minPrice` and `maxPrice`: non-negative USD decimal strings with at most two decimal places, bounded by the price column maximum. Filter the rounded final price inclusively. Reject `minPrice > maxPrice`.
- `inStock`: exact query strings `true` or `false`, meaning `stock > 0` or `stock = 0`; do not use JavaScript truthiness for parsing.
- `sortBy`: `createdAt`, `name`, or `price`; `sortOrder`: `asc` or `desc`. Default `createdAt`/`desc`; use UUID ascending as the tie-breaker. `price` means rounded final USD price.
- Admin lists additionally accept `status`. Public lists reject it rather than allowing visibility overrides.
- Combine filters with AND, except the name/SKU search pair. Filtered count ignores offset/limit but includes every active filter and public visibility restriction.
- Invalid fields, UUIDs, queries, or values return `400`. Missing product or a nonexistent category in a write returns `404`. Duplicate SKU returns `409`. Map expected database constraint errors without exposing SQL details.
- Reuse SPEC 04's pagination definitions and standard Nest exceptions. Return the same product response fields for public and admin records; only visibility differs.

## Implementation plan

1. Add the product entity and reviewed migration with required fields, constraints, unique normalized SKU, category foreign key, and indexes on `(created_at, id)` and `(category_id, created_at, id)`. Register it explicitly with the shared `DataSource`; do not add speculative search or computed-price indexes.
2. Add create/update and public/admin list DTOs with explicit decimal-string, boolean-query, enum, UUID, URL, and pagination validation. Add a small exact-price calculation helper and boundary/rounding tests.
3. Add a product service using an injected TypeORM repository. Implement normalized writes, category validation, state changes, exact response mapping, and expected constraint error translation. Use partial updates for supplied fields to avoid overwriting unrelated fields from a stale loaded entity; concurrent writes to the same field use last-write-wins behavior.
4. Add public and admin controllers with SPEC 03 permission metadata. Keep published-only predicates mandatory on public list/detail queries, independent of the caller's role.
5. Implement parameterized list queries and counts using TypeORM. Whitelist ordering expressions, reuse shared pagination, and compute final-price filters/order with PostgreSQL numeric arithmetic matching the response helper.
6. Add PostgreSQL integration tests, Lambda permission tests, and API examples covering discounts, state changes, filters, and pagination. Complete focused package verification and final Lambda artifact checks.

## Acceptance criteria

- [x] The migration creates the expected product table, constraints, indexes, and category relationship without modifying auth data.
- [x] Valid creation persists a draft with defaults; patch changes only supplied fields and supports image replacement/clearing.
- [x] SKU uniqueness remains enforced for archived products and concurrent case-equivalent creates.
- [x] Missing categories cannot be assigned, including through a race that reaches the foreign key constraint.
- [x] Invalid prices, numeric JSON money values, excess precision, discounts outside 0–100, negative/fractional stock, invalid URLs, and unknown fields return `400`.
- [x] Discounts `0`, `1`, fractional values, and `100` produce correct two-decimal final prices. `0.01` with `50.00` percent discount rounds to `0.01`.
- [x] Price filtering and ordering agree with the rounded `finalPriceUsd` returned to clients.
- [x] Publication accepts an empty image array and zero stock; drafts and archived products remain absent from public lists/detail.
- [x] Public detail for an unknown, draft, or archived product returns `404`, including for authenticated editors/admins.
- [x] Editor/admin can create, edit, archive, and republish; user, absent role, and anonymous requests cannot administer.
- [x] Combined search/category/price/availability filters return correct records and totals. Admin status filtering works, while public status parameters return `400`.
- [x] Pagination covers no results, out-of-range pages, maximum limit, invalid/repeated query parameters, tied sort values, and safe offset validation.
- [x] Type checking, lint, formatting, relevant tests, build, and Lambda artifact verification pass.

## Decisions

- **Yes: one store and simple physical products.** Each product has its own SKU, price, and stock; no variant model is introduced.
- **Yes: USD only and manual percentage discounts.** Currency conversion and automatic promotion timing belong elsewhere.
- **Yes: exact decimal persistence and strings at the API boundary.** Prevent binary floating-point money errors; final price is derived.
- **Yes: numbered pages with totals.** Use TypeORM database pagination as documented in [find options](https://typeorm.io/docs/working-with-entity-manager/find-options/), or its query builder when computed filtering requires it.
- **Yes: archive instead of physical product deletion.** Preserve product data without adding deletion workflows.
- **No: image storage, inventory ledger, reservations, tax rules, or generic extensibility frameworks.** They are not required for this catalog.

## Risks

| Risk                                                                                                       | Mitigation                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent catalog changes shift numbered pages or make count and rows reflect slightly different moments. | Guarantee deterministic ordering for unchanged data; document that separate requests and count/row queries are not a catalog snapshot. |
| Leading-wildcard searches and computed-price sorts become expensive at scale.                              | Keep queries parameterized and SQL-side; add specialized indexes only after measuring a real workload.                                 |
| Manual stock editing overwrites another edit to the same quantity.                                         | Document last-write-wins semantics; transactional order inventory is a future feature.                                                 |
| Frontend uses a different monetary formula.                                                                | Return the authoritative final USD price and document the exact rounding contract.                                                     |

## What is **not** in this spec

No checkout, payments, orders, stock reservations/history, variants, exchange rates, scheduled discounts, file uploads, role management, category deletion, or cloud deployment is included.
