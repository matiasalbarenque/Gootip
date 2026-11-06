import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  loadMigrationBundle,
  type MigrationBundle,
} from '../src/migration-runner/bundle.js';
import {
  MIGRATION_ERROR_CODES,
  MIGRATION_OPERATIONS,
  MIGRATION_STATUSES,
  createResult,
} from '../src/migration-runner/contract.js';
import type { MigrationCredential } from '../src/migration-runner/credentials.js';
import type { MigrationConnection } from '../src/migration-runner/database.js';
import { runMigration } from '../src/migration-runner/handler.js';
import {
  handler,
  invocationRemaining,
} from '../src/migration-runner/lambda.js';
import {
  historyConstraintRows,
  historyModeProbeRows,
  historyRow,
  historyStructureRows,
} from './fixtures.js';

const RESULT_FIELDS = [
  'applied_ids',
  'commit_sha',
  'error_code',
  'history_sha256',
  'manifest_sha256',
  'operation',
  'pending_ids',
  'run_id',
  'status',
];

const migrationsDirectory = fileURLToPath(
  new URL('../migrations', import.meta.url),
);

const loaded = loadMigrationBundle(migrationsDirectory);

if (!loaded.ok) {
  throw new Error('the committed migrations directory must be valid');
}

const bundle: MigrationBundle = loaded.bundle;
const initialOnly: MigrationBundle = {
  ...bundle,
  manifest: {
    ...bundle.manifest,
    migrations: bundle.manifest.migrations.slice(0, 1),
  },
  files: bundle.files.slice(0, 1),
  sql: new Map([...bundle.sql].slice(0, 1)),
};
const manifestSha256 = bundle.manifestSha256;

const env: Record<string, string | undefined> = {
  POSTGRES_DB_HOST: 'db.internal',
  POSTGRES_DB_PORT: '5432',
  POSTGRES_DB_NAME: 'gootip',
  MIGRATION_DB_USER: 'auth_migrator',
  MIGRATION_CREDENTIAL_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-2:1:secret:auth',
};

const credential: MigrationCredential = {
  username: 'auth_migrator',
  password: 'not-a-real-password',
};

const event = (overrides: Record<string, unknown> = {}) => ({
  operation: 'apply',
  run_id: 'run-1',
  commit_sha: 'a'.repeat(40),
  expected_manifest_sha256: manifestSha256,
  ...overrides,
});

const identityRow = (overrides: Record<string, unknown> = {}) => ({
  current_user: 'auth_migrator',
  session_user: 'auth_migrator',
  current_database: 'gootip',
  is_superuser: false,
  can_create_role: false,
  can_create_db: false,
  bypass_rls: false,
  can_replicate: false,
  ...overrides,
});

const schemaRow = {
  can_create_schema: true,
  can_use_schema: true,
  can_create_database_objects: false,
};

/**
 * The identity and privilege checks the preflight performs.
 */
const preflightRows = (): Record<string, unknown>[][] => [
  [identityRow()],
  [],
  [schemaRow],
  [],
];

/**
 * The session phase for a database whose history table already matches the
 * reviewed shape: advisory lock, existence probe, structure, protection, read,
 * and the release in `finally`.
 */
const sessionRows = (
  history: readonly Record<string, unknown>[] = [],
): Record<string, unknown>[][] => [
  [{ locked: true }],
  [{ present: 1 }],
  historyStructureRows(),
  historyConstraintRows(),
  historyModeProbeRows(),
  [{ owner: 'auth_migrator' }],
  [],
  [],
  [...history],
  [{ unlocked: true }],
];

const scriptedConnection = (
  rows: readonly (readonly Record<string, unknown>[])[],
): { connection: MigrationConnection; closed: () => boolean } => {
  const queue = [...rows];
  let closed = false;

  return {
    closed: () => closed,
    connection: {
      query: async () => ({ rows: queue.shift() ?? [] }),
      close: async () => {
        closed = true;
      },
    },
  };
};

const dependencies = (
  rows: readonly (readonly Record<string, unknown>[])[] = [
    ...preflightRows(),
    ...sessionRows(),
  ],
) => {
  const scripted = scriptedConnection(rows);

  return {
    scripted,
    overrides: {
      env,
      loadManifest: () => ({ ok: true as const, bundle: initialOnly }),
      loadCredential: async () => ({ ok: true as const, credential }),
      connect: async () => ({
        ok: true as const,
        connection: scripted.connection,
      }),
      invokedFunctionArn: () =>
        'arn:aws:lambda:us-east-2:123456789012:function:gootip-dev-auth-migrations:deployment',
      report: () => undefined,
    },
  };
};

describe('migration runner contract', () => {
  it('exposes the four fixed operations', () => {
    expect(MIGRATION_OPERATIONS).toEqual([
      'validate',
      'apply',
      'baseline_check',
      'baseline_adopt',
    ]);
  });

  it('exposes the bounded statuses and error codes', () => {
    expect(MIGRATION_STATUSES).toEqual([
      'succeeded',
      'no_changes',
      'baseline_approval_required',
      'failed',
    ]);
    expect(MIGRATION_ERROR_CODES).toContain('invalid_request');
    expect(MIGRATION_ERROR_CODES).toContain('privilege_mismatch');
    expect(MIGRATION_ERROR_CODES).toContain('connection_error');
  });

  it('fills every result field with a default', () => {
    const result = createResult({ status: 'no_changes' });

    expect(Object.keys(result).sort()).toEqual(RESULT_FIELDS);
    expect(result.operation).toBeNull();
    expect(result.run_id).toBeNull();
    expect(result.commit_sha).toBeNull();
    expect(result.manifest_sha256).toBeNull();
    expect(result.history_sha256).toBeNull();
    expect(result.applied_ids).toEqual([]);
    expect(result.pending_ids).toEqual([]);
    expect(result.error_code).toBeNull();
  });
});

describe('migration runner handler', () => {
  it('rejects an invalid event before reading any configuration', async () => {
    const result = await handler({ operation: 'migrate' });

    expect(Object.keys(result).sort()).toEqual(RESULT_FIELDS);
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('invalid_request');
  });

  it('reads the real remaining time from the Lambda context', () => {
    const remaining = invocationRemaining({
      getRemainingTimeInMillis: () => 42_500,
    });

    expect(remaining()).toBe(42_500);
  });

  it('fails with configuration_error when deployment configuration is absent', async () => {
    const result = await runMigration(event(), {
      env: {},
      invokedFunctionArn: () =>
        'arn:aws:lambda:us-east-2:123456789012:function:gootip-dev-auth-migrations:deployment',
    });

    expect(result.error_code).toBe('configuration_error');
  });

  it('rejects an event whose manifest digest does not match the bundle', async () => {
    const { overrides } = dependencies();
    const result = await runMigration(
      event({ expected_manifest_sha256: 'f'.repeat(64) }),
      overrides,
    );

    expect(result.error_code).toBe('manifest_mismatch');
  });

  it('rejects a bundle whose schema differs from the configured schema', async () => {
    const { overrides } = dependencies();
    const result = await runMigration(event(), {
      ...overrides,
      env: { ...env, MIGRATION_DB_SCHEMA: 'core' },
    });

    expect(result.error_code).toBe('manifest_mismatch');
  });

  it('fails with credential_error when the migrator secret cannot be used', async () => {
    const { overrides } = dependencies();
    const result = await runMigration(event(), {
      ...overrides,
      loadCredential: async () => ({ ok: false as const }),
    });

    expect(result.error_code).toBe('credential_error');
  });

  it('propagates a bounded connection failure', async () => {
    const { overrides } = dependencies();
    const result = await runMigration(event(), {
      ...overrides,
      connect: async () => ({
        ok: false as const,
        errorCode: 'connection_error' as const,
      }),
    });

    expect(result.error_code).toBe('connection_error');
  });

  it('fails before mutation when the live identity is wrong', async () => {
    const { overrides, scripted } = dependencies([
      [
        identityRow({
          current_user: 'auth_runtime',
          session_user: 'auth_runtime',
        }),
      ],
    ]);
    const result = await runMigration(event(), overrides);

    expect(result.error_code).toBe('database_identity_mismatch');
    expect(scripted.closed()).toBe(true);
  });

  it('fails before mutation on a cross-schema grant', async () => {
    const { overrides } = dependencies([
      [identityRow()],
      [],
      [schemaRow],
      [{ name: 'public' }],
    ]);
    const result = await runMigration(event(), overrides);

    expect(result.error_code).toBe('privilege_mismatch');
  });

  it('applies reviewed SQL through the handler and records it in history', async () => {
    const initial = bundle.manifest.migrations[0] as {
      id: string;
      sha256: string;
    };
    const applied = historyRow({
      checksum_sha256: initial.sha256,
      commit_sha: 'a'.repeat(40),
      run_id: 'run-1',
    });
    const { overrides, scripted } = dependencies([
      ...preflightRows(),
      [{ locked: true }],
      [{ present: 1 }],
      historyStructureRows(),
      historyConstraintRows(),
      historyModeProbeRows(),
      [{ owner: 'auth_migrator' }],
      [],
      [],
      [],
      // Structural baseline detection: an empty application schema.
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [{ migration_id: initial.id }],
      [],
      [applied],
      [{ unlocked: true }],
    ]);
    const result = await runMigration(event(), overrides);

    expect(result).toMatchObject({
      status: 'succeeded',
      operation: 'apply',
      run_id: 'run-1',
      commit_sha: 'a'.repeat(40),
      manifest_sha256: manifestSha256,
      error_code: null,
      applied_ids: ['000001'],
      pending_ids: [],
    });
    expect(result.history_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(scripted.closed()).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/password|secret|token/i);
  });

  it('reports no_changes for an apply that finds nothing pending', async () => {
    const initial = bundle.manifest.migrations[0] as {
      id: string;
      sha256: string;
    };
    const applied = historyRow({
      checksum_sha256: initial.sha256,
      commit_sha: 'a'.repeat(40),
      run_id: 'run-1',
    });
    const { overrides, scripted } = dependencies([
      ...preflightRows(),
      ...sessionRows([applied]),
    ]);
    const result = await runMigration(event(), overrides);

    expect(result).toMatchObject({
      status: 'no_changes',
      operation: 'apply',
      error_code: null,
      applied_ids: ['000001'],
      pending_ids: [],
    });
    expect(scripted.closed()).toBe(true);
  });

  it('reports the verified history for a validate invocation', async () => {
    const { overrides, scripted } = dependencies();
    const result = await runMigration(
      event({ operation: 'validate' }),
      overrides,
    );

    expect(result).toMatchObject({
      status: 'succeeded',
      operation: 'validate',
      error_code: null,
      applied_ids: [],
      pending_ids: ['000001'],
    });
    expect(result.history_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(scripted.closed()).toBe(true);
  });

  it('rejects an unreviewed history table for a validate invocation', async () => {
    const { overrides } = dependencies([
      ...preflightRows(),
      [{ locked: true }],
      [{ present: 1 }],
      historyStructureRows().map((row) =>
        row.name === 'migration_id' ? { ...row, data_type: 'uuid' } : row,
      ),
      historyConstraintRows(),
    ]);
    const result = await runMigration(
      event({ operation: 'validate' }),
      overrides,
    );

    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'history_invalid',
    });
  });

  it('maps unexpected provider or driver failures to bounded codes', async () => {
    const { overrides } = dependencies();

    expect(
      (
        await runMigration(event(), {
          ...overrides,
          loadCredential: async () => {
            throw new Error(
              'AccessDeniedException: arn:aws:secretsmanager:...',
            );
          },
        })
      ).error_code,
    ).toBe('credential_error');

    expect(
      (
        await runMigration(event(), {
          ...overrides,
          connect: async () => {
            throw new Error('getaddrinfo ENOTFOUND db.internal');
          },
        })
      ).error_code,
    ).toBe('connection_error');

    expect(
      (
        await runMigration(event(), {
          ...overrides,
          connect: async () => ({
            ok: true as const,
            connection: {
              query: async () => {
                throw new Error('relation "pg_roles" does not exist');
              },
              close: async () => {
                throw new Error('connection already closed');
              },
            },
          }),
        })
      ).error_code,
    ).toBe('verification_failed');
  });

  it('bounds the invocation by the runtime remaining time and cleanup margin', async () => {
    const { overrides } = dependencies();
    let connected = false;

    const result = await runMigration(event(), {
      ...overrides,
      remainingInvocationMs: () => 5_000,
      connect: async () => {
        connected = true;

        return { ok: false as const, errorCode: 'connection_error' as const };
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'operation_timeout',
    });
    expect(connected).toBe(false);
  });

  it('uses the reviewed operation budget when the runtime reports more time', async () => {
    const { overrides } = dependencies();

    const result = await runMigration(event({ operation: 'validate' }), {
      ...overrides,
      remainingInvocationMs: () => 900_000,
    });

    expect(result).toMatchObject({ status: 'succeeded' });
  });
});
