import type { AddressInfo } from 'node:net';

import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createDatabaseOptions } from '../src/config/database/database.config.js';
import { handler } from '../src/lambda.js';
import { assertCoreTestDatabase } from './local-postgres.js';

assertCoreTestDatabase();

const fixturePrefix = 'spec04-it-';
const listPrefix = `${fixturePrefix}list-`;
const TEST_RUNTIME_USER = 'test_core_runtime';
const TEST_MIGRATOR_USER = 'test_core_migrator';
type TestLambdaResult = { statusCode: number; body?: string };
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

let app: Awaited<ReturnType<typeof createApp>>;
let baseUrl: string;

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
      time: '27/Oct/2026:00:00:00 +0000',
      timeEpoch: Date.now(),
      ...(options.role
        ? {
            authorizer: {
              jwt: { claims: { sub: 'spec04-test', role: options.role } },
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

const resultJson = (result: TestLambdaResult): any =>
  JSON.parse(result.body as string);

beforeAll(async () => {
  await migrationDataSource.initialize();
  await migrationDataSource.runMigrations();
  await migrationDataSource.query(
    `REVOKE INSERT, UPDATE, DELETE ON TABLE core.typeorm_migrations FROM ${TEST_RUNTIME_USER}`,
  );
  await migrationDataSource.query(
    `GRANT SELECT, INSERT, UPDATE ON TABLE core.categories TO ${TEST_RUNTIME_USER}`,
  );

  app = await createApp();
  await app.listen(0);
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (app) await app.close();
  if (migrationDataSource.isInitialized) {
    await migrationDataSource.query(
      'DELETE FROM core.categories WHERE name LIKE $1',
      [`${fixturePrefix}%`],
    );
    await migrationDataSource.destroy();
  }
});

describe('categories on disposable PostgreSQL and HTTP/Lambda', () => {
  it('applies only the category table, unique index, and migration record', async () => {
    const objects = await migrationDataSource.query(`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'core' AND table_name = 'categories'
      UNION ALL
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'core' AND tablename = 'categories'
      ORDER BY name
    `);
    expect(objects.map((row: { name: string }) => row.name)).toEqual([
      'PK_categories_id',
      'UQ_categories_name_lower',
      'categories',
    ]);
    const history = await migrationDataSource.query(
      'SELECT name FROM core.typeorm_migrations',
    );
    expect(history).toEqual([
      { name: 'CreateCategories1782086400000' },
      { name: 'CreateProducts1793059200000' },
      { name: 'RenameCatalogColumnsToSnakeCase1793318400000' },
    ]);
  });

  it('creates normalized data, maps case-insensitive duplicates, and patches supplied fields', async () => {
    const created = await lambdaRequest('POST', '/api/categories', {
      role: 'editor',
      body: { name: `  ${fixturePrefix}Home  `, description: '  items  ' },
    });
    expect(created.statusCode).toBe(201);
    expect(resultJson(created)).toMatchObject({
      name: `${fixturePrefix}Home`,
      description: 'items',
    });
    const createdCategory = resultJson(created);
    expect(createdCategory).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: `${fixturePrefix}Home`,
        description: 'items',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      }),
    );
    expect(new Date(createdCategory.createdAt).toISOString()).toBe(
      createdCategory.createdAt,
    );
    expect(new Date(createdCategory.updatedAt).toISOString()).toBe(
      createdCategory.updatedAt,
    );
    const id = createdCategory.id as string;

    const duplicates = await Promise.all([
      lambdaRequest('POST', '/api/categories', {
        role: 'admin',
        body: { name: `${fixturePrefix}race-home` },
      }),
      lambdaRequest('POST', '/api/categories', {
        role: 'admin',
        body: { name: `${fixturePrefix}RACE-HOME` },
      }),
    ]);
    expect(duplicates.map((result) => result.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(
      duplicates.find((result) => result.statusCode === 409)?.body,
    ).not.toMatch(/UQ_categories|lower\(|SQL/i);

    const updated = await lambdaRequest('PATCH', `/api/categories/${id}`, {
      role: 'admin',
      body: { name: `  ${fixturePrefix}Updated  `, description: null },
    });
    expect(updated.statusCode).toBe(200);
    expect(resultJson(updated)).toMatchObject({
      name: `${fixturePrefix}Updated`,
      description: null,
    });
  });

  it('returns correct counts, literal wildcard search, deterministic pages, and public detail', async () => {
    for (const name of [`${listPrefix}A_One`, `${listPrefix}B%Two`]) {
      const result = await lambdaRequest('POST', '/api/categories', {
        role: 'editor',
        body: { name },
      });
      expect(result.statusCode).toBe(201);
    }

    const list = await fetch(`${baseUrl}/api/categories?search=${listPrefix}`);
    expect(list.status).toBe(200);
    const payload = await list.json();
    expect(payload.meta).toMatchObject({ total: 2, totalPages: 1 });
    expect(
      payload.data.map((category: { name: string }) => category.name),
    ).toEqual([`${listPrefix}A_One`, `${listPrefix}B%Two`]);

    const literal = await fetch(`${baseUrl}/api/categories?search=%25`);
    expect(
      (await literal.json()).data.map((row: { name: string }) => row.name),
    ).toEqual([`${listPrefix}B%Two`]);
    const underscore = await fetch(`${baseUrl}/api/categories?search=%5FOne`);
    expect(
      (await underscore.json()).data.map((row: { name: string }) => row.name),
    ).toEqual([`${listPrefix}A_One`]);
    const noMatches = await fetch(
      `${baseUrl}/api/categories?search=no-such-spec04-category`,
    );
    expect(await noMatches.json()).toMatchObject({
      data: [],
      meta: { total: 0, totalPages: 0 },
    });
    const beyond = await fetch(
      `${baseUrl}/api/categories?page=8&limit=1&search=${listPrefix}`,
    );
    expect(await beyond.json()).toMatchObject({
      data: [],
      meta: { page: 8, limit: 1, total: 2, totalPages: 2 },
    });

    const detail = await fetch(
      `${baseUrl}/api/categories/${payload.data[0].id}`,
    );
    expect(detail.status).toBe(200);
  });

  it('rejects malformed input and permits writes only for editor/admin roles', async () => {
    expect((await fetch(`${baseUrl}/api/categories?page=0`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/categories?limit=101`)).status).toBe(
      400,
    );
    expect(
      (await fetch(`${baseUrl}/api/categories?page=9007199254740991&limit=100`))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/categories?page=1&page=2`)).status,
    ).toBe(400);
    expect((await fetch(`${baseUrl}/api/categories?unknown=1`)).status).toBe(
      400,
    );
    expect((await fetch(`${baseUrl}/api/categories/not-a-uuid`)).status).toBe(
      400,
    );
    expect(
      (
        await lambdaRequest('POST', '/api/categories', {
          role: 'editor',
          body: { name: '' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await lambdaRequest('POST', '/api/categories', {
          role: 'editor',
          body: { name: 'Valid but unknown field', extra: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await lambdaRequest(
          'PATCH',
          '/api/categories/00000000-0000-4000-8000-000000000000',
          {
            role: 'admin',
            body: {},
          },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await lambdaRequest(
          'GET',
          '/api/categories/00000000-0000-4000-8000-000000000000',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await lambdaRequest(
          'PATCH',
          '/api/categories/00000000-0000-4000-8000-000000000000',
          {
            role: 'admin',
            body: { name: 'Missing' },
          },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await lambdaRequest('POST', '/api/categories', {
          body: { name: 'blocked' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await lambdaRequest('POST', '/api/categories', {
          role: 'user',
          body: { name: 'blocked' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await lambdaRequest('POST', '/api/categories', {
          role: 'editor',
          body: { name: '', invalid: true },
        })
      ).statusCode,
    ).toBe(400);
  });
});
