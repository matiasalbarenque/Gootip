import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseOptions } from '../src/config/database/database.config.js';
import { ROLES } from '../src/helpers/app.js';
import { ProductStatuses } from '../src/helpers/products.js';
import { handler } from '../src/lambda.js';
import { assertCoreTestDatabase } from './local-postgres.js';

assertCoreTestDatabase();

type TestLambdaResult = { statusCode: number; body?: string };
type ProductResponse = {
  id: string;
  sku: string;
  name: string;
  categoryId: string;
  priceUsd: string;
  discountPercentage: string;
  finalPriceUsd: string;
  stock: number;
  status: string;
  images: string[];
  createdAt: string;
  updatedAt: string;
};

const fixturePrefix =
  `SPEC05-${crypto.randomUUID().slice(0, 8)}-`.toUpperCase();
const categoryName = `${fixturePrefix}category`;
const TEST_RUNTIME_USER = 'test_core_runtime';
const TEST_MIGRATOR_USER = 'test_core_migrator';
const runtimeEnv = process.env;
const migrationDataSource = new DataSource({
  ...createDatabaseOptions({
    ...runtimeEnv,
    POSTGRES_DB_USER: TEST_MIGRATOR_USER,
    POSTGRES_DB_PASSWORD:
      process.env.CORE_TEST_MIGRATOR_PASSWORD ?? 'unit-test-only-password',
  }),
  migrationsTableName: 'typeorm_migrations',
});

let categoryId: string;

const lambdaRequest = async (
  method: string,
  path: string,
  options: { role?: string; body?: unknown; query?: string } = {},
): Promise<TestLambdaResult> => {
  const event = {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: options.query ?? '',
    headers: { host: 'example.com', 'content-type': 'application/json' },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: crypto.randomUUID(),
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: '28/Oct/2026:00:00:00 +0000',
      timeEpoch: Date.now(),
      ...(options.role
        ? {
            authorizer: {
              jwt: { claims: { sub: 'spec05-test', role: options.role } },
            },
          }
        : {}),
    },
    isBase64Encoded: false,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  } as APIGatewayProxyEventV2;
  return (await handler(event, {} as Context)) as TestLambdaResult;
};

const resultJson = <T>(result: TestLambdaResult): T =>
  JSON.parse(result.body as string) as T;

const createProduct = async (
  overrides: Record<string, unknown> = {},
): Promise<{ result: TestLambdaResult; product?: ProductResponse }> => {
  const result = await lambdaRequest('POST', '/api/admin/products', {
    role: ROLES.EDITOR,
    body: {
      sku: `${fixturePrefix}${crypto.randomUUID().slice(0, 8)}`,
      name: 'Spec product',
      categoryId,
      priceUsd: '10.00',
      ...overrides,
    },
  });
  return {
    result,
    ...(result.statusCode === 201
      ? { product: resultJson<ProductResponse>(result) }
      : {}),
  };
};

const patchProduct = async (
  id: string,
  body: unknown,
  role: string = ROLES.EDITOR,
): Promise<TestLambdaResult> =>
  lambdaRequest('PATCH', `/api/admin/products/${id}`, { role, body });

beforeAll(async () => {
  await migrationDataSource.initialize();
  await migrationDataSource.runMigrations();
  await migrationDataSource.query(
    `REVOKE INSERT, UPDATE, DELETE ON TABLE core.typeorm_migrations FROM ${TEST_RUNTIME_USER}`,
  );
  await migrationDataSource.query(
    `GRANT SELECT, INSERT, UPDATE ON TABLE core.categories, core.products TO ${TEST_RUNTIME_USER}`,
  );
  const [category] = await migrationDataSource.query(
    'INSERT INTO core.categories (name) VALUES ($1) RETURNING id',
    [categoryName],
  );
  categoryId = category.id;
});

afterAll(async () => {
  if (migrationDataSource.isInitialized) {
    await migrationDataSource.query(
      'DELETE FROM core.products WHERE sku LIKE $1',
      [`${fixturePrefix}%`],
    );
    await migrationDataSource.query(
      'DELETE FROM core.categories WHERE id = $1',
      [categoryId],
    );
    await migrationDataSource.destroy();
  }
});

describe('products on disposable PostgreSQL and Lambda', () => {
  it('creates the migration constraints and indexes without touching auth data', async () => {
    const constraints = await migrationDataSource.query(`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = 'core.products'::regclass AND contype <> 'n'
      ORDER BY conname
    `);
    expect(constraints.map((row: { name: string }) => row.name)).toEqual([
      'CHK_products_discount_range',
      'CHK_products_price_positive',
      'CHK_products_sku_normalized',
      'CHK_products_status',
      'CHK_products_stock_nonnegative',
      'FK_products_category_id',
      'PK_products_id',
    ]);
    const indexes = await migrationDataSource.query(`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'core' AND tablename = 'products' ORDER BY indexname
    `);
    expect(indexes.map((row: { name: string }) => row.name)).toEqual([
      'IDX_products_category_created_at_id',
      'IDX_products_created_at_id',
      'PK_products_id',
      'UQ_products_sku_normalized',
    ]);
    const history = await migrationDataSource.query(
      'SELECT name FROM core.typeorm_migrations ORDER BY id',
    );
    expect(history).toContainEqual({ name: 'CreateProducts1793059200000' });
    const authTables = await migrationDataSource.query(`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'auth'
    `);
    expect(authTables[0].count).toBe(0);
  });

  it('creates draft defaults, patches only supplied fields, and supports image clearing', async () => {
    const { result, product } = await createProduct({
      sku: `${fixturePrefix}DEFAULT`,
    });
    expect(result.statusCode).toBe(201);
    expect(product).toMatchObject({
      sku: `${fixturePrefix}DEFAULT`,
      categoryId,
      priceUsd: '10.00',
      discountPercentage: '0.00',
      finalPriceUsd: '10.00',
      stock: 0,
      images: [],
      status: ProductStatuses.DRAFT,
    });
    expect(new Date(product!.createdAt).toISOString()).toBe(product!.createdAt);
    expect(new Date(product!.updatedAt).toISOString()).toBe(product!.updatedAt);

    const firstImages = await patchProduct(product!.id, {
      images: ['https://example.com/front.png'],
    });
    expect(firstImages.statusCode).toBe(200);
    expect(resultJson<ProductResponse>(firstImages).images).toEqual([
      'https://example.com/front.png',
    ]);

    const cleared = await patchProduct(product!.id, { images: [] });
    expect(resultJson<ProductResponse>(cleared).images).toEqual([]);
    expect(resultJson<ProductResponse>(cleared)).toMatchObject({
      sku: `${fixturePrefix}DEFAULT`,
      name: 'Spec product',
      status: ProductStatuses.DRAFT,
    });
  });

  it('enforces SKU uniqueness for archived products and concurrent normalized creates', async () => {
    const sku = `${fixturePrefix}ARCHIVE`;
    const archived = await createProduct({ sku });
    expect(archived.result.statusCode).toBe(201);
    await patchProduct(archived.product!.id, {
      status: ProductStatuses.ARCHIVED,
    });
    const archivedDuplicate = await createProduct({ sku: sku.toLowerCase() });
    expect(archivedDuplicate.result.statusCode).toBe(409);

    const raceSku = `${fixturePrefix}RACE`;
    const results = await Promise.all([
      createProduct({ sku: raceSku }),
      createProduct({ sku: raceSku.toLowerCase() }),
    ]);
    expect(results.map(({ result }) => result.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(
      results.find(({ result }) => result.statusCode === 409)?.result.body,
    ).not.toMatch(/UQ_products|SQL|products_sku/i);
  });

  it('returns 404 for missing categories and database foreign-key races', async () => {
    const missingCategory = await lambdaRequest('POST', '/api/admin/products', {
      role: ROLES.ADMIN,
      body: {
        sku: `${fixturePrefix}MISSING-CATEGORY`,
        name: 'Missing category',
        categoryId: '00000000-0000-4000-8000-000000000000',
        priceUsd: '1.00',
      },
    });
    expect(missingCategory.statusCode).toBe(404);

    await expect(
      migrationDataSource.query(
        `INSERT INTO core.products (sku, name, category_id, price_usd)
         VALUES ($1, 'FK race', '00000000-0000-4000-8000-000000000000', 1.00)`,
        [`${fixturePrefix}FK-RACE`.toUpperCase()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('rejects invalid money, stock, images, state, and unknown fields', async () => {
    const invalidBodies = [
      { priceUsd: 1 },
      { priceUsd: '1e2' },
      { priceUsd: '1.001' },
      { discountPercentage: '100.01' },
      { stock: -1 },
      { stock: 1.5 },
      { images: ['http://example.com/image.png'] },
      { status: ProductStatuses.PUBLISHED },
      { finalPriceUsd: '1.00' },
    ];
    for (const invalid of invalidBodies) {
      const { result } = await createProduct(invalid);
      expect(result.statusCode, JSON.stringify(invalid)).toBe(400);
    }
  });

  it('calculates discounts with exact rounding at boundaries', async () => {
    const cases = [
      { priceUsd: '10.00', discountPercentage: '0', final: '10.00' },
      { priceUsd: '10.00', discountPercentage: '1', final: '9.90' },
      { priceUsd: '10.00', discountPercentage: '12.34', final: '8.77' },
      { priceUsd: '0.01', discountPercentage: '50.00', final: '0.01' },
      { priceUsd: '10.00', discountPercentage: '100', final: '0.00' },
    ];
    for (const [
      index,
      { priceUsd, discountPercentage, final },
    ] of cases.entries()) {
      const { result, product } = await createProduct({
        sku: `${fixturePrefix}ROUND-${index}`,
        priceUsd,
        discountPercentage,
      });
      expect(result.statusCode).toBe(201);
      expect(product?.finalPriceUsd).toBe(final);
    }
  });

  it('keeps public reads published-only even for admins and includes stock-zero products', async () => {
    const draft = await createProduct({ sku: `${fixturePrefix}DRAFT` });
    const archived = await createProduct({ sku: `${fixturePrefix}ARCHIVED` });
    const published = await createProduct({ sku: `${fixturePrefix}PUBLISHED` });
    await patchProduct(archived.product!.id, {
      status: ProductStatuses.ARCHIVED,
    });
    await patchProduct(published.product!.id, {
      status: ProductStatuses.PUBLISHED,
      stock: 0,
    });

    for (const hidden of [draft.product!, archived.product!]) {
      const detail = await lambdaRequest('GET', `/api/products/${hidden.id}`, {
        role: ROLES.ADMIN,
      });
      expect(detail.statusCode).toBe(404);
    }
    expect(
      (
        await lambdaRequest(
          'GET',
          '/api/products/00000000-0000-4000-8000-000000000000',
          { role: ROLES.ADMIN },
        )
      ).statusCode,
    ).toBe(404);
    const republished = await patchProduct(
      archived.product!.id,
      { status: ProductStatuses.PUBLISHED },
      ROLES.ADMIN,
    );
    expect(republished.statusCode).toBe(200);
    expect(
      (await lambdaRequest('GET', `/api/products/${archived.product!.id}`))
        .statusCode,
    ).toBe(200);
    const visible = await lambdaRequest(
      'GET',
      `/api/products/${published.product!.id}`,
      { role: ROLES.ADMIN },
    );
    expect(visible.statusCode).toBe(200);
    expect(resultJson<ProductResponse>(visible).stock).toBe(0);

    const unavailableOnly = await lambdaRequest('GET', '/api/products', {
      query: `search=${fixturePrefix}PUBLISHED&inStock=true`,
    });
    expect(
      resultJson<{ data: ProductResponse[]; meta: { total: number } }>(
        unavailableOnly,
      ).meta.total,
    ).toBe(0);
    const visibleList = await lambdaRequest('GET', '/api/products', {
      query: `search=${fixturePrefix}PUBLISHED&inStock=false`,
    });
    expect(resultJson<{ data: ProductResponse[] }>(visibleList).data).toEqual([
      expect.objectContaining({ id: published.product!.id }),
    ]);
  });

  it('combines search, category, rounded price, availability, and admin status filters', async () => {
    const matched = await createProduct({
      sku: `${fixturePrefix}FILTER-A`,
      name: 'Literal % product',
      priceUsd: '10.00',
      discountPercentage: '50.00',
      stock: 2,
    });
    const otherPrice = await createProduct({
      sku: `${fixturePrefix}FILTER-B`,
      name: 'Literal _ product',
      priceUsd: '20.00',
      stock: 0,
    });
    const hidden = await createProduct({ sku: `${fixturePrefix}FILTER-C` });
    await patchProduct(matched.product!.id, {
      status: ProductStatuses.PUBLISHED,
    });
    await patchProduct(otherPrice.product!.id, {
      status: ProductStatuses.PUBLISHED,
    });
    await patchProduct(hidden.product!.id, {
      status: ProductStatuses.ARCHIVED,
    });

    const combined = await lambdaRequest('GET', '/api/products', {
      query: `search=${fixturePrefix}FILTER&categoryId=${categoryId}&minPrice=5&maxPrice=5&inStock=true`,
    });
    expect(
      resultJson<{ data: ProductResponse[]; meta: { total: number } }>(
        combined,
      ),
    ).toMatchObject({
      data: [
        expect.objectContaining({
          id: matched.product!.id,
          finalPriceUsd: '5.00',
        }),
      ],
      meta: { total: 1 },
    });

    const literalPercent = await lambdaRequest('GET', '/api/products', {
      query: `search=%25`,
    });
    expect(
      resultJson<{ data: ProductResponse[] }>(literalPercent).data,
    ).toContainEqual(expect.objectContaining({ id: matched.product!.id }));

    const adminArchived = await lambdaRequest('GET', '/api/admin/products', {
      role: ROLES.EDITOR,
      query: `search=${fixturePrefix}FILTER&status=${ProductStatuses.ARCHIVED}`,
    });
    expect(
      resultJson<{ data: ProductResponse[]; meta: { total: number } }>(
        adminArchived,
      ),
    ).toMatchObject({
      data: [expect.objectContaining({ id: hidden.product!.id })],
      meta: { total: 1 },
    });
    const priceOrder = await lambdaRequest('GET', '/api/products', {
      query: `search=${fixturePrefix}FILTER&sortBy=price&sortOrder=asc`,
    });
    const orderedProducts = resultJson<{ data: ProductResponse[] }>(
      priceOrder,
    ).data;
    expect(orderedProducts.map((row) => row.id)).toEqual([
      matched.product!.id,
      otherPrice.product!.id,
    ]);
    expect(orderedProducts.map((row) => row.finalPriceUsd)).toEqual([
      '5.00',
      '20.00',
    ]);

    const createdAtOrder = await lambdaRequest('GET', '/api/products', {
      query: `search=${fixturePrefix}FILTER&sortBy=createdAt&sortOrder=asc`,
    });
    const createdAtProducts = resultJson<{ data: ProductResponse[] }>(
      createdAtOrder,
    ).data;
    expect(createdAtProducts.map((row) => row.id)).toEqual(
      [...createdAtProducts]
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.id.localeCompare(right.id),
        )
        .map((row) => row.id),
    );

    const tiedA = await createProduct({
      sku: `${fixturePrefix}TIE-A`,
      priceUsd: '3.00',
    });
    const tiedB = await createProduct({
      sku: `${fixturePrefix}TIE-B`,
      priceUsd: '3.00',
    });
    const tiedOrder = await lambdaRequest('GET', '/api/admin/products', {
      role: ROLES.ADMIN,
      query: `search=${fixturePrefix}TIE&sortBy=price&sortOrder=asc`,
    });
    expect(
      resultJson<{ data: ProductResponse[] }>(tiedOrder).data.map(
        (row) => row.id,
      ),
    ).toEqual([tiedA.product!.id, tiedB.product!.id].sort());
    expect(
      (
        await lambdaRequest('GET', '/api/products', {
          query: `status=${ProductStatuses.DRAFT}`,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('enforces Lambda roles and pagination validation', async () => {
    const protectedPath = '/api/admin/products';
    expect((await lambdaRequest('GET', protectedPath)).statusCode).toBe(401);
    expect(
      (await lambdaRequest('GET', protectedPath, { role: ROLES.USER }))
        .statusCode,
    ).toBe(403);
    expect(
      (await lambdaRequest('GET', protectedPath, { role: ROLES.ADMIN }))
        .statusCode,
    ).toBe(200);

    const noResults = await lambdaRequest('GET', '/api/products', {
      query: `search=missing-${fixturePrefix}`,
    });
    expect(
      resultJson<{ data: ProductResponse[]; meta: object }>(noResults),
    ).toMatchObject({
      data: [],
      meta: { total: 0, totalPages: 0 },
    });
    const beyond = await lambdaRequest('GET', '/api/products', {
      query: `page=8&limit=1&search=${fixturePrefix}PUBLISHED`,
    });
    expect(
      resultJson<{ data: ProductResponse[]; meta: object }>(beyond),
    ).toMatchObject({
      data: [],
      meta: { page: 8, limit: 1, total: 1, totalPages: 1 },
    });
    const maxLimit = await lambdaRequest('GET', '/api/products', {
      query: 'limit=100',
    });
    expect(resultJson<{ meta: { limit: number } }>(maxLimit).meta.limit).toBe(
      100,
    );
    for (const query of [
      'page=0',
      'limit=101',
      'page=1&page=2',
      'unknown=value',
      'minPrice=2&maxPrice=1',
    ]) {
      expect(
        (await lambdaRequest('GET', '/api/products', { query })).statusCode,
      ).toBe(400);
    }
  });
});
