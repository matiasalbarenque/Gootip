import { beforeEach, describe, expect, it, vi } from 'vitest';

const runner = vi.hoisted(() => ({
  executeMigrations: vi.fn(),
  validateMigrations: vi.fn(),
}));
vi.mock('../src/migration-runner/runner.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/migration-runner/runner.js')
  >()),
  executeMigrations: runner.executeMigrations,
  validateMigrations: runner.validateMigrations,
}));

import { migrations } from '../src/config/database/migrations/index.js';
import {
  loadMigratorCredential,
  parseMigratorSecret,
} from '../src/migration-runner/credentials.js';
import { runMigration } from '../src/migration-runner/handler.js';
import { handler } from '../src/migration-runner/lambda.js';
import { migrationManifestSha256 } from '../src/migration-runner/manifest.js';

const commit = 'a'.repeat(40);
const manifest = {
  format_version: 1 as const,
  commit_sha: commit,
  migrations: migrations.map((migration) => {
    const name = new migration().name as string;
    return {
      name,
      timestamp: Number(name.match(/(\d+)$/)?.[1]),
      source_sha256: 'b'.repeat(64),
    };
  }),
};
const manifestBytes = JSON.stringify(manifest);
const manifestSha = migrationManifestSha256(manifestBytes);
const migrationEvent = (operation = 'validate') => ({
  operation,
  run_id: 'run-1',
  commit_sha: commit,
  expected_manifest_sha256: manifestSha,
});
const trustedArn =
  'arn:aws:lambda:us-east-2:123456789012:function:gootip-core-migrations:deployment';

describe('Core migration Lambda adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runner.validateMigrations.mockResolvedValue([]);
    runner.executeMigrations.mockResolvedValue({
      appliedNames: [],
      history: [],
    });
  });

  it('accepts only the trusted deployment alias from Lambda context', async () => {
    const rejected = await handler(migrationEvent(), {
      invokedFunctionArn: trustedArn.replace(':deployment', ':4'),
    } as never);
    expect(rejected.error_code).toBe('invalid_invocation');

    const accepted = await runMigration(migrationEvent(), {
      env: {
        MIGRATION_CREDENTIAL_SECRET_ARN: 'arn:secret',
        POSTGRES_SSL_MODE: 'verify-full',
      },
      invokedFunctionArn: () => trustedArn,
      loadManifest: () => ({ manifest, sha256: manifestSha }),
      loadCredential: async () => ({
        username: 'core_migrator',
        password: 'x',
      }),
      createDataSource: () =>
        ({
          initialize: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn().mockResolvedValue(undefined),
        }) as never,
    });
    expect(accepted.status).toBe('succeeded');
  });

  it('returns sanitized credential errors without exposing provider details', async () => {
    const secretProviderError = new Error('password leaked by provider');
    await expect(
      loadMigratorCredential('arn:secret', {
        send: vi.fn().mockRejectedValue(secretProviderError),
      }),
    ).rejects.toBe(secretProviderError);
    expect(
      parseMigratorSecret('{"username":"core_runtime","password":"x"}'),
    ).toBeNull();
    expect(
      parseMigratorSecret('{"username":"core_migrator","password":"x"}'),
    ).toEqual({ username: 'core_migrator', password: 'x' });

    const response = await runMigration(migrationEvent(), {
      env: {
        MIGRATION_CREDENTIAL_SECRET_ARN: 'arn:secret',
        POSTGRES_SSL_MODE: 'verify-full',
      },
      invokedFunctionArn: () => trustedArn,
      loadManifest: () => ({ manifest, sha256: manifestSha }),
      loadCredential: async () => {
        throw secretProviderError;
      },
    });
    expect(response.error_code).toBe('credential_error');
    expect(JSON.stringify(response)).not.toContain('password leaked');
  });

  it('destroys an initialized data source and returns only contract fields', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    runner.executeMigrations.mockResolvedValue({
      appliedNames: [manifest.migrations[0]!.name],
      history: manifest.migrations.map(({ name, timestamp }) => ({
        name,
        timestamp,
      })),
    });
    const response = await runMigration(
      {
        ...migrationEvent('apply'),
        expected_history_sha256: migrationManifestSha256('[]'),
      },
      {
        env: {
          MIGRATION_CREDENTIAL_SECRET_ARN: 'arn:secret',
          POSTGRES_DB_NAME: 'gootip_test_core',
          POSTGRES_SSL_MODE: 'verify-full',
        },
        invokedFunctionArn: () => trustedArn,
        loadManifest: () => ({ manifest, sha256: manifestSha }),
        loadCredential: async () => ({
          username: 'core_migrator',
          password: 'secret',
        }),
        createDataSource: () =>
          ({
            initialize: vi.fn().mockResolvedValue(undefined),
            destroy,
          }) as never,
      },
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      status: 'succeeded',
      error_code: null,
      pending_names: [],
    });
    expect(runner.executeMigrations).toHaveBeenCalledWith(
      expect.anything(),
      manifest,
      expect.objectContaining({ migrator: 'core_migrator' }),
      { expectedHistorySha256: migrationManifestSha256('[]') },
    );
    expect(Object.keys(response).sort()).toEqual([
      'applied_names',
      'commit_sha',
      'error_code',
      'history_sha256',
      'manifest_sha256',
      'operation',
      'pending_names',
      'run_id',
      'status',
    ]);
  });
});
