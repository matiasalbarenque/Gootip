import { describe, expect, it } from 'vitest';

import {
  readMigrationConfig,
  type MigrationConfig,
} from '../src/migration-runner/config.js';
import {
  loadMigratorCredential,
  parseMigratorSecret,
} from '../src/migration-runner/credentials.js';
import { validateMigrationRequest } from '../src/migration-runner/request.js';

const manifestDigest = 'a'.repeat(64);

const validEvent = (overrides: Record<string, unknown> = {}) => ({
  operation: 'validate',
  run_id: 'run-2026-01-01T00:00:00Z',
  commit_sha: 'b'.repeat(40),
  expected_manifest_sha256: manifestDigest,
  ...overrides,
});

const validEnv = (overrides: Record<string, string | undefined> = {}) => ({
  POSTGRES_DB_HOST: 'db.internal',
  POSTGRES_DB_PORT: '5432',
  POSTGRES_DB_NAME: 'gootip',
  MIGRATION_DB_USER: 'auth_migrator',
  MIGRATION_CREDENTIAL_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-2:1:secret:auth',
  ...overrides,
});

describe('validateMigrationRequest', () => {
  it('accepts a minimal fixed operation', () => {
    const result = validateMigrationRequest(validEvent());

    expect(result.ok).toBe(true);
  });

  it('rejects non-object events and unknown fields', () => {
    expect(validateMigrationRequest(null).ok).toBe(false);
    expect(validateMigrationRequest([]).ok).toBe(false);
    expect(
      validateMigrationRequest(validEvent({ sql: 'drop schema auth' })).ok,
    ).toBe(false);
  });

  it('rejects an unknown operation', () => {
    expect(
      validateMigrationRequest(validEvent({ operation: 'migrate' })).ok,
    ).toBe(false);
  });

  it('rejects malformed correlation and digest fields', () => {
    expect(validateMigrationRequest(validEvent({ run_id: '' })).ok).toBe(false);
    expect(validateMigrationRequest(validEvent({ commit_sha: 'abc' })).ok).toBe(
      false,
    );
    expect(
      validateMigrationRequest(validEvent({ expected_manifest_sha256: 'nope' }))
        .ok,
    ).toBe(false);
  });

  it('requires approval evidence for baseline adoption', () => {
    expect(
      validateMigrationRequest(validEvent({ operation: 'baseline_adopt' })).ok,
    ).toBe(false);
    expect(
      validateMigrationRequest(
        validEvent({
          operation: 'baseline_adopt',
          approval_reference: 'GH-482',
          expected_schema_fingerprint: 'c'.repeat(64),
          expected_history_sha256: 'd'.repeat(64),
        }),
      ).ok,
    ).toBe(true);
  });

  it('treats expected_history_sha256 as optional for validate only', () => {
    expect(validateMigrationRequest(validEvent()).ok).toBe(true);
    expect(
      validateMigrationRequest(
        validEvent({ expected_history_sha256: 'd'.repeat(64) }),
      ).ok,
    ).toBe(true);

    for (const operation of ['apply', 'baseline_check'] as const) {
      const result = validateMigrationRequest(
        validEvent({ operation, expected_history_sha256: 'd'.repeat(64) }),
      );

      expect(result.ok).toBe(false);
      expect(validateMigrationRequest(validEvent({ operation })).ok).toBe(true);
    }

    expect(
      validateMigrationRequest(
        validEvent({
          operation: 'baseline_adopt',
          expected_history_sha256: 'nope',
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects approval evidence on ordinary operations', () => {
    expect(
      validateMigrationRequest(validEvent({ approval_reference: 'GH-482' })).ok,
    ).toBe(false);
    expect(
      validateMigrationRequest({ ...validEvent(), operation: 'apply' }).ok,
    ).toBe(true);
  });
});

describe('readMigrationConfig', () => {
  it('reads a bounded identity without echoing values', () => {
    const result = readMigrationConfig(validEnv());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.user).toBe('auth_migrator');
      expect(result.config.schema).toBe('auth');
      expect(result.config.database).toMatchObject({
        host: 'db.internal',
        port: 5432,
        name: 'gootip',
      });
    }
  });

  it('rejects a master-like migrator role', () => {
    const result = readMigrationConfig(
      validEnv({ MIGRATION_DB_USER: 'postgres' }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an incomplete or invalid configuration', () => {
    expect(readMigrationConfig({}).ok).toBe(false);
    expect(readMigrationConfig(validEnv({ POSTGRES_DB_PORT: '0' })).ok).toBe(
      false,
    );
    expect(
      readMigrationConfig(validEnv({ POSTGRES_SSL_MODE: 'verify-full' })).ok,
    ).toBe(false);
  });

  it('never returns a problem string containing a configuration value', () => {
    const result = readMigrationConfig(
      validEnv({ MIGRATION_DB_USER: 'postgres' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(' ')).not.toContain('postgres');
    }
  });
});

describe('migrator credential', () => {
  const config = (): MigrationConfig => {
    const result = readMigrationConfig(validEnv());

    if (!result.ok) {
      throw new Error('the fixture configuration must be valid');
    }

    return result.config;
  };

  it('accepts a secret whose username matches the configuration', () => {
    expect(
      parseMigratorSecret(
        JSON.stringify({ username: 'auth_migrator', password: 'pw' }),
        'auth_migrator',
      ),
    ).toEqual({ username: 'auth_migrator', password: 'pw' });
  });

  it('rejects a mismatched username, missing password, or malformed secret', () => {
    expect(
      parseMigratorSecret(
        JSON.stringify({ username: 'core_migrator', password: 'pw' }),
        'auth_migrator',
      ),
    ).toBeNull();
    expect(
      parseMigratorSecret(
        JSON.stringify({ username: 'auth_migrator' }),
        'auth_migrator',
      ),
    ).toBeNull();
    expect(parseMigratorSecret('not-json', 'auth_migrator')).toBeNull();
    expect(parseMigratorSecret(undefined, 'auth_migrator')).toBeNull();
  });

  it('loads the credential through the secret client without leaking failures', async () => {
    const ok = await loadMigratorCredential(config(), {
      send: async () => ({
        SecretString: JSON.stringify({
          username: 'auth_migrator',
          password: 'pw',
        }),
      }),
    });

    expect(ok).toEqual({
      ok: true,
      credential: { username: 'auth_migrator', password: 'pw' },
    });

    const empty = await loadMigratorCredential(config(), {
      send: async () => ({}),
    });

    expect(empty).toEqual({ ok: false });

    const failing = await loadMigratorCredential(config(), {
      send: async () => {
        throw new Error('AccessDeniedException');
      },
    });

    expect(failing).toEqual({ ok: false });
  });
});
