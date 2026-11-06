import { afterEach, describe, expect, it } from 'vitest';

import { suiteDatabaseUrl } from './local-postgres.js';

const VARIABLE = 'LOCAL_POSTGRES_TEST_URL';
const original = process.env[VARIABLE];

afterEach(() => {
  if (original === undefined) {
    delete process.env[VARIABLE];
  } else {
    process.env[VARIABLE] = original;
  }
});

describe('suiteDatabaseUrl', () => {
  it('accepts only the expected local test database and admin identity', () => {
    process.env[VARIABLE] =
      'postgres://gootip_local_admin:local-only@127.0.0.1:55433/gootip_test_auth_runtime';

    expect(suiteDatabaseUrl(VARIABLE, 'gootip_test_auth_runtime')).toBe(
      process.env[VARIABLE],
    );
  });

  it.each([
    'postgres://gootip_local_admin:local-only@db.example.com:5433/gootip_test_auth_runtime',
    'postgres://gootip_local_admin:local-only@127.0.0.1:5433/gootip',
    'postgres://other:local-only@127.0.0.1:5433/gootip_test_auth_runtime',
  ])('rejects an unexpected endpoint or database: %s', (url) => {
    process.env[VARIABLE] = url;

    expect(() =>
      suiteDatabaseUrl(VARIABLE, 'gootip_test_auth_runtime'),
    ).toThrow(VARIABLE);
  });

  it('leaves unit-only runs unconfigured', () => {
    delete process.env[VARIABLE];

    expect(suiteDatabaseUrl(VARIABLE, 'gootip_test_auth_runtime')).toBe('');
  });
});
