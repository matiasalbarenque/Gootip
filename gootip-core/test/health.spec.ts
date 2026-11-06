import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createDatabaseOptions } from '../src/config/database/database.config.js';
import { assertCoreTestDatabase } from './local-postgres.js';

assertCoreTestDatabase();

let app: INestApplication;
let baseUrl: string;
let historyBeforeStartup: string | null;
const TEST_RUNTIME_USER = 'test_core_runtime';

beforeAll(async () => {
  const probe = new DataSource(createDatabaseOptions());
  await probe.initialize();
  try {
    const [row] = await probe.query(
      "SELECT to_regclass('core.typeorm_migrations') AS history",
    );
    historyBeforeStartup = row.history;
  } finally {
    await probe.destroy();
  }

  app = await createApp();
  await app.listen(0);

  const address = app.getHttpServer().address() as AddressInfo | null;
  if (address === null) {
    throw new Error('The test server did not expose an address.');
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

describe('local HTTP server', () => {
  it('answers GET /api/health with 200 and the health payload', async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  it('answers an unknown route with 404', async () => {
    const response = await fetch(`${baseUrl}/api/unknown`);

    expect(response.status).toBe(404);
  });

  it('does not create migration history on startup and releases its pool on close', async () => {
    const dataSource = app.get(DataSource);
    expect(
      await dataSource.query(
        `SELECT current_user AS username,
                has_schema_privilege(current_user, 'core', 'CREATE') AS can_create,
                to_regclass('core.typeorm_migrations') AS history`,
      ),
    ).toEqual([
      {
        username: TEST_RUNTIME_USER,
        can_create: false,
        history: historyBeforeStartup,
      },
    ]);

    await app.close();
    expect(dataSource.isInitialized).toBe(false);
  });
});
