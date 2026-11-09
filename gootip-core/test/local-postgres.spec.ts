import { describe, expect, it } from 'vitest';

import { assertCoreTestDatabase } from './local-postgres.js';

const validEnv = (): NodeJS.ProcessEnv => ({
  POSTGRES_DB_HOST: '127.0.0.1',
  POSTGRES_DB_PORT: '5433',
  LOCAL_POSTGRES_PORT: '5433',
  POSTGRES_DB_NAME: 'gootip_test_core',
  POSTGRES_DB_USER: 'test_core_runtime',
  POSTGRES_DB_PASSWORD: 'local-test-runtime',
  CORE_TEST_MIGRATOR_PASSWORD: 'local-test-migrator',
  POSTGRES_SSL_MODE: 'disable',
});

describe('Core integration database guard', () => {
  it('accepts only the configured local test target', () => {
    expect(() => assertCoreTestDatabase(validEnv())).not.toThrow();
  });

  it('accepts the selected local port only when the test connection matches it', () => {
    const alternatePortEnv = {
      ...validEnv(),
      LOCAL_POSTGRES_PORT: '55439',
      POSTGRES_DB_PORT: '55439',
    };
    expect(() => assertCoreTestDatabase(alternatePortEnv)).not.toThrow();
    expect(() =>
      assertCoreTestDatabase({ ...alternatePortEnv, POSTGRES_DB_PORT: '5433' }),
    ).toThrow();
  });

  it.each([
    ['POSTGRES_DB_HOST', 'db.example.com'],
    ['POSTGRES_DB_HOST', 'localhost'],
    ['POSTGRES_DB_PORT', '5432'],
    ['POSTGRES_DB_NAME', 'gootip'],
    ['POSTGRES_DB_NAME', 'gootip_test_other'],
    ['POSTGRES_DB_USER', 'core_runtime'],
    ['POSTGRES_DB_USER', 'core_migrator'],
    ['POSTGRES_SSL_MODE', 'verify-full'],
    ['POSTGRES_DB_PASSWORD', ''],
    ['POSTGRES_DB_PASSWORD', 'unit-test-only-password'],
    ['CORE_TEST_MIGRATOR_PASSWORD', ''],
  ])('rejects unsafe or missing %s before connecting', (name, value) => {
    expect(() =>
      assertCoreTestDatabase({ ...validEnv(), [name]: value }),
    ).toThrow();
  });

  it('rejects missing configuration', () => {
    expect(() => assertCoreTestDatabase({})).toThrow();
  });
});
