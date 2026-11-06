import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import migrationDataSource from '../src/config/database/data-source.js';
import { createDatabaseOptions } from '../src/config/database/database.config.js';

const validEnv = (): NodeJS.ProcessEnv => ({
  POSTGRES_DB_HOST: 'localhost',
  POSTGRES_DB_PORT: '5432',
  POSTGRES_DB_NAME: 'core_test',
  POSTGRES_DB_USER: 'runtime_user',
  POSTGRES_DB_PASSWORD: 'never-include-this-secret-in-errors',
  POSTGRES_SSL_MODE: 'disable',
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe('database configuration', () => {
  it('loads its DataSource through the TypeORM migration CLI', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
          import { resolve } from 'node:path';
          import { CommandUtils } from 'typeorm/commands/CommandUtils.js';
          const source = await CommandUtils.loadDataSource(resolve('src/config/database/data-source.ts'));
          console.log(source.options.type);
        `,
      ],
      { encoding: 'utf8' },
    );
    expect(output.trim()).toBe('postgres');
  });

  it('uses core-owned schema and explicit migration configuration', () => {
    expect(migrationDataSource.options).toMatchObject({
      schema: 'core',
      migrations: expect.arrayContaining([expect.any(Function)]),
      migrationsTableName: 'typeorm_migrations',
    });

    const runtimeOptions = createDatabaseOptions(validEnv());
    expect(runtimeOptions).toMatchObject({
      schema: 'core',
      entities: migrationDataSource.options.entities,
      migrations: migrationDataSource.options.migrations,
    });
  });

  it('rejects missing settings and invalid ports or pool sizes without exposing credentials', () => {
    const missing = validEnv();
    delete missing.POSTGRES_DB_PASSWORD;
    expect(() => createDatabaseOptions(missing)).toThrow(
      /POSTGRES_DB_PASSWORD/,
    );

    for (const [name, value] of [
      ['POSTGRES_DB_PORT', '0'],
      ['POSTGRES_DB_PORT', '5432.5'],
      ['POSTGRES_DB_PORT', '65536'],
      ['CORE_PG_POOL_MAX', '-1'],
    ] as const) {
      expect(() =>
        createDatabaseOptions({ ...validEnv(), [name]: value }),
      ).toThrow(name);
    }

    try {
      createDatabaseOptions(missing);
    } catch (error) {
      expect(String(error)).not.toContain(
        'never-include-this-secret-in-errors',
      );
    }
  });

  it('requires supported TLS settings and configures verified CA validation', () => {
    const local = createDatabaseOptions(validEnv());
    expect(local.ssl).toBe(false);
    expect(local.poolSize).toBe(2);
    expect(local.schema).toBe('core');
    expect(local.synchronize).toBe(false);
    expect(local.migrationsRun).toBe(false);
    expect(local.connectTimeoutMS).toBeUndefined();
    expect(local.extra).toBeUndefined();
    expect(() =>
      createDatabaseOptions({ ...validEnv(), POSTGRES_SSL_MODE: 'require' }),
    ).toThrow('POSTGRES_SSL_MODE');
    expect(() =>
      createDatabaseOptions({
        ...validEnv(),
        POSTGRES_SSL_MODE: 'verify-full',
      }),
    ).toThrow('POSTGRES_CA_PATH');

    const dir = mkdtempSync(join(tmpdir(), 'gootip-ca-'));
    tempDirs.push(dir);
    const caPath = join(dir, 'ca.pem');
    writeFileSync(caPath, 'test certificate');
    const ssl = createDatabaseOptions({
      ...validEnv(),
      POSTGRES_SSL_MODE: 'verify-full',
      POSTGRES_CA_PATH: caPath,
    }).ssl;
    expect(ssl).toMatchObject({
      ca: readFileSync(caPath, 'utf8'),
      rejectUnauthorized: true,
    });
  });
});
