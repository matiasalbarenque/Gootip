import {
  DataSource,
  MigrationExecutor,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseOptions } from '../src/config/database/database.config.js';
import { RenameCatalogColumnsToSnakeCase1793318400000 } from '../src/config/database/migrations/1793318400000-RenameCatalogColumnsToSnakeCase.js';
import { migrations } from '../src/config/database/migrations/index.js';
import { preflightMigrationState } from '../src/migration-runner/preflight.js';
import {
  acquireMigrationLock,
  executeMigrations,
  releaseMigrationLock,
} from '../src/migration-runner/runner.js';
import { assertCoreTestDatabase } from './local-postgres.js';

assertCoreTestDatabase();

const migrationDataSource = new DataSource({
  ...createDatabaseOptions({
    ...process.env,
    POSTGRES_DB_USER: 'test_core_migrator',
    POSTGRES_DB_PASSWORD: process.env.CORE_TEST_MIGRATOR_PASSWORD,
    CORE_PG_POOL_MAX: '1',
  }),
  migrationsTableName: 'typeorm_migrations',
  migrationsTransactionMode: 'all',
});
const contenderDataSource = new DataSource({
  ...migrationDataSource.options,
});
const runtimeDataSource = new DataSource({
  ...createDatabaseOptions({ CORE_PG_POOL_MAX: '1', ...process.env }),
  synchronize: false,
  migrationsRun: false,
});
const manifest = {
  format_version: 1 as const,
  commit_sha: 'a'.repeat(40),
  migrations: migrations.map((migration) => {
    const instance = new migration();
    return {
      name: instance.name as string,
      timestamp: Number(instance.name?.match(/(\d+)$/)?.[1]),
      source_sha256: 'b'.repeat(64),
    };
  }),
};
class CreateRollbackProbe implements MigrationInterface {
  name = 'CreateRollbackProbe1800000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE core.rollback_probe (id integer)');
  }

  async down(): Promise<void> {}
}
class FailAfterRollbackProbe implements MigrationInterface {
  name = 'FailAfterRollbackProbe1800000000001';

  async up(): Promise<void> {
    throw new Error('intentional integration failure');
  }

  async down(): Promise<void> {}
}
const failedBatchManifest = {
  ...manifest,
  migrations: [CreateRollbackProbe, FailAfterRollbackProbe].map((migration) => {
    const instance = new migration();
    return {
      name: instance.name,
      timestamp: Number(instance.name.match(/(\d+)$/)?.[1]),
      source_sha256: 'c'.repeat(64),
    };
  }),
};
const failedBatchDataSource = new DataSource({
  ...migrationDataSource.options,
  migrations: [CreateRollbackProbe, FailAfterRollbackProbe],
});

beforeAll(async () => {
  await migrationDataSource.initialize();
  await contenderDataSource.initialize();
  await failedBatchDataSource.initialize();
  await runtimeDataSource.initialize();
  await migrationDataSource.query(
    'CREATE TABLE core.typeorm_migrations ' +
      '(id SERIAL NOT NULL PRIMARY KEY, timestamp bigint NOT NULL, name character varying NOT NULL)',
  );
  await migrationDataSource.query(
    'REVOKE ALL PRIVILEGES ON TABLE core.typeorm_migrations FROM test_core_runtime',
  );
  await migrationDataSource.query(
    'REVOKE ALL PRIVILEGES ON SEQUENCE core.typeorm_migrations_id_seq FROM test_core_runtime',
  );
});

afterAll(async () => {
  if (migrationDataSource.isInitialized) {
    const [history] = await migrationDataSource.query(
      `SELECT to_regclass('core.typeorm_migrations') AS relation`,
    );
    if (history.relation) {
      await migrationDataSource.query(
        'GRANT SELECT ON TABLE core.typeorm_migrations TO test_core_runtime',
      );
    }
    await migrationDataSource.destroy();
  }
  if (runtimeDataSource.isInitialized) await runtimeDataSource.destroy();
  if (failedBatchDataSource.isInitialized)
    await failedBatchDataSource.destroy();
  if (contenderDataSource.isInitialized) await contenderDataSource.destroy();
});

const preflight = async () => {
  const runner = migrationDataSource.createQueryRunner();
  await runner.connect();
  try {
    return await preflightMigrationState(runner, manifest, {
      database: 'gootip_test_core',
      migrator: 'test_core_migrator',
      tls: false,
    });
  } finally {
    await runner.release();
  }
};

describe('migration preflight on the shared disposable Core database', () => {
  it('locks, runs the batch transactionally, and enforces history isolation', async () => {
    expect(await preflight()).toEqual([]);
    const [freshHistory] = await migrationDataSource.query(
      `SELECT to_regclass('core.typeorm_migrations') AS relation`,
    );
    expect(freshHistory.relation).toBe('core.typeorm_migrations');
    expect(
      await migrationDataSource.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'core' AND table_name = 'typeorm_migrations'
         ORDER BY ordinal_position`,
      ),
    ).toEqual([
      { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'timestamp', data_type: 'bigint', is_nullable: 'NO' },
      {
        column_name: 'name',
        data_type: 'character varying',
        is_nullable: 'NO',
      },
    ]);

    const heldRunner = migrationDataSource.createQueryRunner();
    await heldRunner.connect();
    await acquireMigrationLock(heldRunner);
    const executor = new MigrationExecutor(migrationDataSource, heldRunner);
    expect(
      (executor as unknown as { queryRunner: QueryRunner }).queryRunner,
    ).toBe(heldRunner);
    executor.transaction = 'all';
    executor.fake = false;
    try {
      await expect(
        executeMigrations(
          contenderDataSource,
          manifest,
          {
            database: 'gootip_test_core',
            migrator: 'test_core_migrator',
            tls: false,
          },
          { lockWaitMs: 150 },
        ),
      ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    } finally {
      await releaseMigrationLock(heldRunner);
      await heldRunner.release();
    }

    await migrationDataSource.query(
      'CREATE TABLE core.untracked_probe (id integer)',
    );
    try {
      await expect(preflight()).rejects.toThrow(
        'Existing Core objects have no compatible migration history',
      );
    } finally {
      await migrationDataSource.query('DROP TABLE core.untracked_probe');
    }

    await expect(
      executeMigrations(failedBatchDataSource, failedBatchManifest, {
        database: 'gootip_test_core',
        migrator: 'test_core_migrator',
        tls: false,
      }),
    ).rejects.toThrow('intentional integration failure');
    const [rolledBackTable] = await migrationDataSource.query(
      `SELECT to_regclass('core.rollback_probe') AS relation`,
    );
    expect(rolledBackTable.relation).toBeNull();
    const [emptyHistory] = await migrationDataSource.query(
      'SELECT count(*)::int AS count FROM core.typeorm_migrations',
    );
    expect(emptyHistory.count).toBe(0);

    await expect(
      executeMigrations(
        migrationDataSource,
        manifest,
        {
          database: 'gootip_test_core',
          migrator: 'test_core_migrator',
          tls: false,
        },
        { expectedHistorySha256: 'f'.repeat(64) },
      ),
    ).rejects.toMatchObject({ code: 'HISTORY_MISMATCH' });
    const [unchangedHistory] = await migrationDataSource.query(
      'SELECT count(*)::int AS count FROM core.typeorm_migrations',
    );
    expect(unchangedHistory.count).toBe(0);

    const applied = await executeMigrations(migrationDataSource, manifest, {
      database: 'gootip_test_core',
      migrator: 'test_core_migrator',
      tls: false,
    });
    expect(applied.appliedNames).toEqual(
      manifest.migrations.map(({ name }) => name),
    );
    expect(
      await executeMigrations(migrationDataSource, manifest, {
        database: 'gootip_test_core',
        migrator: 'test_core_migrator',
        tls: false,
      }),
    ).toMatchObject({ appliedNames: [] });
    const history = await preflight();
    expect(history.map(({ name }) => name)).toEqual(
      manifest.migrations.map(({ name }) => name),
    );
    const initialHistory = await migrationDataSource.query(
      'SELECT id, timestamp, name FROM core.typeorm_migrations ORDER BY id',
    );
    const corruptions = [
      [
        `UPDATE core.typeorm_migrations SET name = 'Unknown1782086400000' WHERE name = $1`,
        [initialHistory[0].name],
      ],
      [
        'UPDATE core.typeorm_migrations SET name = $1 WHERE name = $2',
        [initialHistory[0].name, initialHistory[1].name],
      ],
      [
        'UPDATE core.typeorm_migrations SET timestamp = $1 WHERE name = $2',
        [initialHistory[1].timestamp, initialHistory[0].name],
      ],
    ] as const;
    for (const [sql, parameters] of corruptions) {
      await migrationDataSource.query(sql, [...parameters]);
      const corruptedHistory = await migrationDataSource.query(
        'SELECT id, timestamp, name FROM core.typeorm_migrations ORDER BY id',
      );
      expect(
        corruptedHistory,
        `history mutation did not apply: ${sql}`,
      ).not.toEqual(initialHistory);
      const preflightError = await preflight().then(
        () => null,
        (error: unknown) => error,
      );
      expect(
        preflightError,
        `preflight accepted corrupt history: ${sql}`,
      ).toBeInstanceOf(Error);
      expect(preflightError).toMatchObject({
        message: 'Incompatible migration history',
      });
      await migrationDataSource.query(
        'TRUNCATE core.typeorm_migrations RESTART IDENTITY',
      );
      for (const row of initialHistory) {
        await migrationDataSource.query(
          'INSERT INTO core.typeorm_migrations (timestamp, name) VALUES ($1, $2)',
          [row.timestamp, row.name],
        );
      }
    }

    await migrationDataSource.query(
      'REVOKE ALL PRIVILEGES ON TABLE core.typeorm_migrations FROM test_core_runtime',
    );
    await expect(
      runtimeDataSource.query('SELECT name FROM core.typeorm_migrations'),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });
    await expect(
      runtimeDataSource.query(
        'UPDATE core.typeorm_migrations SET name = name WHERE false',
      ),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });

    const marker = `migration-access-${crypto.randomUUID()}`;
    await runtimeDataSource.query(
      'INSERT INTO core.categories (name) VALUES ($1)',
      [marker],
    );
    await runtimeDataSource.query(
      'DELETE FROM core.categories WHERE name = $1',
      [marker],
    );
  });

  it('preserves populated catalog rows through the rename and its reversal', async () => {
    const runner = migrationDataSource.createQueryRunner();
    const migration = new RenameCatalogColumnsToSnakeCase1793318400000();
    const categoryId = crypto.randomUUID();
    const productId = crypto.randomUUID();
    const sku = `SPEC07-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
    const createdAt = '2026-10-30T12:34:56.000Z';
    const updatedAt = '2026-10-30T12:35:56.000Z';

    await runner.connect();
    await runner.startTransaction();
    try {
      await migration.down(runner);
      await runner.query(
        'INSERT INTO core.categories (id, name, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4)',
        [categoryId, `${sku}-category`, createdAt, updatedAt],
      );
      await runner.query(
        `INSERT INTO core.products (
           id, sku, name, "categoryId", "priceUsd", "discountPercentage", "createdAt", "updatedAt"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          productId,
          sku,
          `${sku}-product`,
          categoryId,
          '19.95',
          '12.50',
          createdAt,
          updatedAt,
        ],
      );

      await migration.up(runner);
      const [renamed] = await runner.query(
        `SELECT p.id, p.category_id, p.price_usd::text, p.discount_percentage::text,
                p.created_at, p.updated_at, c.id AS related_category_id,
                c.created_at AS category_created_at, c.updated_at AS category_updated_at
         FROM core.products p JOIN core.categories c ON c.id = p.category_id
         WHERE p.id = $1`,
        [productId],
      );
      expect(renamed).toEqual({
        id: productId,
        category_id: categoryId,
        price_usd: '19.95',
        discount_percentage: '12.50',
        created_at: new Date(createdAt),
        updated_at: new Date(updatedAt),
        related_category_id: categoryId,
        category_created_at: new Date(createdAt),
        category_updated_at: new Date(updatedAt),
      });

      await migration.down(runner);
      const [reverted] = await runner.query(
        `SELECT p.id, p."categoryId", p."priceUsd"::text, p."discountPercentage"::text,
                p."createdAt", p."updatedAt", c.id AS related_category_id
         FROM core.products p JOIN core.categories c ON c.id = p."categoryId"
         WHERE p.id = $1`,
        [productId],
      );
      expect(reverted).toEqual({
        id: productId,
        categoryId,
        priceUsd: '19.95',
        discountPercentage: '12.50',
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt),
        related_category_id: categoryId,
      });

      await migration.up(runner);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('applies the rename incrementally from valid two-migration history', async () => {
    const migration = new RenameCatalogColumnsToSnakeCase1793318400000();
    const categoryId = crypto.randomUUID();
    const productId = crypto.randomUUID();
    const sku =
      `SPEC07-UPGRADE-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
    const createdAt = '2026-10-30T12:34:56.000Z';
    const updatedAt = '2026-10-30T12:35:56.000Z';
    const runner = migrationDataSource.createQueryRunner();
    await runner.connect();
    try {
      await migration.down(runner);
    } finally {
      await runner.release();
    }

    await migrationDataSource.query(
      'INSERT INTO core.categories (id, name, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4)',
      [categoryId, `${sku}-category`, createdAt, updatedAt],
    );
    await migrationDataSource.query(
      `INSERT INTO core.products (
         id, sku, name, "categoryId", "priceUsd", "discountPercentage", "createdAt", "updatedAt"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        productId,
        sku,
        `${sku}-product`,
        categoryId,
        '19.95',
        '12.50',
        createdAt,
        updatedAt,
      ],
    );
    await migrationDataSource.query(
      'DELETE FROM core.typeorm_migrations WHERE name = $1',
      [migration.name],
    );

    expect((await preflight()).map(({ name }) => name)).toEqual(
      manifest.migrations.slice(0, 2).map(({ name }) => name),
    );
    const upgraded = await executeMigrations(migrationDataSource, manifest, {
      database: 'gootip_test_core',
      migrator: 'test_core_migrator',
      tls: false,
    });
    expect(upgraded.appliedNames).toEqual([migration.name]);
    expect(
      await executeMigrations(migrationDataSource, manifest, {
        database: 'gootip_test_core',
        migrator: 'test_core_migrator',
        tls: false,
      }),
    ).toMatchObject({ appliedNames: [] });

    const [product] = await migrationDataSource.query(
      `SELECT p.id, p.category_id, p.price_usd::text, p.discount_percentage::text,
              p.created_at, p.updated_at, c.id AS related_category_id
       FROM core.products p JOIN core.categories c ON c.id = p.category_id
       WHERE p.id = $1`,
      [productId],
    );
    expect(product).toEqual({
      id: productId,
      category_id: categoryId,
      price_usd: '19.95',
      discount_percentage: '12.50',
      created_at: new Date(createdAt),
      updated_at: new Date(updatedAt),
      related_category_id: categoryId,
    });
    await migrationDataSource.query('DELETE FROM core.products WHERE id = $1', [
      productId,
    ]);
    await migrationDataSource.query(
      'DELETE FROM core.categories WHERE id = $1',
      [categoryId],
    );
    expect((await preflight()).map(({ name }) => name)).toEqual(
      manifest.migrations.map(({ name }) => name),
    );
  });
});
