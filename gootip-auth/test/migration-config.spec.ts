import { describe, expect, it } from 'vitest';

import {
  MIGRATION_LAMBDA_CLEANUP_MARGIN_SECONDS,
  readMigrationConfig,
} from '../src/migration-runner/config.js';

const baseEnv: Record<string, string | undefined> = {
  POSTGRES_DB_HOST: 'db.internal',
  POSTGRES_DB_PORT: '5432',
  POSTGRES_DB_NAME: 'gootip',
  MIGRATION_DB_USER: 'auth_migrator',
  MIGRATION_CREDENTIAL_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-2:1:secret:auth',
};

const read = (overrides: Record<string, string | undefined> = {}) =>
  readMigrationConfig({ ...baseEnv, ...overrides });

const problems = (overrides: Record<string, string | undefined> = {}) =>
  (read(overrides) as { ok: false; problems: string[] }).problems;

describe('readMigrationConfig', () => {
  it('applies the reviewed timeout and runtime-role defaults', () => {
    const parsed = read();

    if (!parsed.ok) {
      throw new Error('the baseline migration configuration must be valid');
    }

    expect(parsed.config.runtimeUser).toBe('auth_runtime');
    expect(parsed.config.timeouts).toEqual({
      connectSeconds: 10,
      lockSeconds: 30,
      statementSeconds: 120,
      operationSeconds: 300,
      lambdaSeconds: 600,
    });
  });

  it('accepts reviewed overrides that fit inside the Lambda timeout', () => {
    const parsed = read({
      MIGRATION_DB_RUNTIME_USER: 'gootip_runtime',
      MIGRATION_CONNECT_TIMEOUT_SECONDS: '5',
      MIGRATION_LOCK_TIMEOUT_SECONDS: '20',
      MIGRATION_STATEMENT_TIMEOUT_SECONDS: '60',
      MIGRATION_OPERATION_TIMEOUT_SECONDS: '600',
      MIGRATION_LAMBDA_TIMEOUT_SECONDS: '900',
    });

    expect(parsed.ok).toBe(true);
  });

  it('rejects a runtime role that is the migrator or a master-like role', () => {
    expect(read({ MIGRATION_DB_RUNTIME_USER: 'auth_migrator' })).toMatchObject({
      ok: false,
    });
    expect(read({ MIGRATION_DB_RUNTIME_USER: 'postgres' })).toMatchObject({
      ok: false,
    });
    expect(
      read({ MIGRATION_DB_RUNTIME_USER: 'Not An Identifier' }),
    ).toMatchObject({ ok: false });
  });

  it('rejects an inner timeout larger than the operation budget', () => {
    for (const field of [
      'MIGRATION_CONNECT_TIMEOUT_SECONDS',
      'MIGRATION_LOCK_TIMEOUT_SECONDS',
      'MIGRATION_STATEMENT_TIMEOUT_SECONDS',
    ]) {
      expect(
        problems({
          MIGRATION_OPERATION_TIMEOUT_SECONDS: '60',
          [field]: '120',
        }).join(' | '),
      ).toContain(
        `${field} must not exceed MIGRATION_OPERATION_TIMEOUT_SECONDS.`,
      );
    }
  });

  it('rejects a release that does not leave a cleanup margin', () => {
    expect(
      problems({
        MIGRATION_OPERATION_TIMEOUT_SECONDS: '600',
        MIGRATION_LAMBDA_TIMEOUT_SECONDS: '600',
      }).join(' | '),
    ).toContain(
      'MIGRATION_OPERATION_TIMEOUT_SECONDS must leave a cleanup margin inside MIGRATION_LAMBDA_TIMEOUT_SECONDS.',
    );

    const parsed = read({
      MIGRATION_OPERATION_TIMEOUT_SECONDS: `${900 - MIGRATION_LAMBDA_CLEANUP_MARGIN_SECONDS}`,
      MIGRATION_LAMBDA_TIMEOUT_SECONDS: '900',
    });

    expect(parsed.ok).toBe(true);
  });

  it('rejects a Lambda timeout beyond the fifteen-minute service maximum', () => {
    expect(problems({ MIGRATION_LAMBDA_TIMEOUT_SECONDS: '901' })).not.toEqual(
      [],
    );
  });

  it('rejects malformed timeout values', () => {
    expect(problems({ MIGRATION_LOCK_TIMEOUT_SECONDS: 'soon' })).not.toEqual(
      [],
    );
    expect(problems({ MIGRATION_LOCK_TIMEOUT_SECONDS: '0' })).not.toEqual([]);
    expect(problems({ MIGRATION_LOCK_TIMEOUT_SECONDS: '-1' })).not.toEqual([]);
  });
});
