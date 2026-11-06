import { readFileSync } from 'node:fs';

import { DataSource } from 'typeorm';

import { createDatabaseOptions } from '../config/database/database.config.js';
import { migrations } from '../config/database/migrations/index.js';
import {
  assertArtifactIdentity,
  migrationHistorySha256,
  parseMigrationRequest,
  type MigrationRequest,
  type MigrationResult,
} from './contract.js';
import {
  loadMigratorCredential,
  type MigrationCredential,
} from './credentials.js';
import {
  assertManifestMatchesRegistry,
  migrationManifestSha256,
  validateMigrationManifest,
  type MigrationManifest,
} from './manifest.js';
import {
  executeMigrations,
  MigrationExecutionError,
  validateMigrations,
} from './runner.js';

type Dependencies = {
  env: NodeJS.ProcessEnv;
  invokedFunctionArn: () => string | null;
  loadManifest: () => { manifest: MigrationManifest; sha256: string };
  loadCredential: (arn: string) => Promise<MigrationCredential>;
  createDataSource: (
    env: NodeJS.ProcessEnv,
    credential: MigrationCredential,
  ) => DataSource;
};

const defaultDependencies = (): Dependencies => ({
  env: process.env,
  invokedFunctionArn: () => null,
  loadManifest: () => {
    const bytes = readFileSync(new URL('./manifest.json', import.meta.url));
    return {
      manifest: validateMigrationManifest(JSON.parse(bytes.toString('utf8'))),
      sha256: migrationManifestSha256(bytes),
    };
  },
  loadCredential: loadMigratorCredential,
  createDataSource: (env, credential) =>
    new DataSource({
      ...createDatabaseOptions({
        ...env,
        POSTGRES_DB_USER: credential.username,
        POSTGRES_DB_PASSWORD: credential.password,
        CORE_PG_POOL_MAX: '1',
      }),
      migrationsTableName: 'typeorm_migrations',
      migrationsTransactionMode: 'all',
    }),
});

const result = (
  request: MigrationRequest,
  manifestSha256: string,
  values: Partial<MigrationResult> = {},
): MigrationResult => ({
  operation: request.operation,
  run_id: request.run_id,
  commit_sha: request.commit_sha,
  status: 'failed',
  manifest_sha256: manifestSha256,
  history_sha256: null,
  applied_names: [],
  pending_names: [],
  error_code: 'migration_failed',
  ...values,
});

/** Runs one validated migration request and returns only sanitized outcome data. */
export const runMigration = async (
  event: unknown,
  overrides: Partial<Dependencies> = {},
): Promise<MigrationResult> => {
  const request = parseMigrationRequest(event);
  const dependencies = { ...defaultDependencies(), ...overrides };
  const invocationArn = dependencies.invokedFunctionArn();
  // Lambda context ARN is passed by the adapter, never trusted from the event.
  if (
    !invocationArn ||
    !/^arn:[^:]+:lambda:[^:]+:\d{12}:function:[^:]+:deployment$/.test(
      invocationArn,
    )
  ) {
    return result(request, '', { error_code: 'invalid_invocation' });
  }

  let manifest: MigrationManifest;
  let manifestSha256: string;
  try {
    ({ manifest, sha256: manifestSha256 } = dependencies.loadManifest());
    assertManifestMatchesRegistry(manifest, migrations);
    assertArtifactIdentity(request, manifest.commit_sha, manifestSha256);
  } catch {
    return result(request, '', { error_code: 'manifest_mismatch' });
  }

  const secretArn = dependencies.env.MIGRATION_CREDENTIAL_SECRET_ARN;
  if (!secretArn)
    return result(request, manifestSha256, {
      error_code: 'configuration_error',
    });
  if (dependencies.env.POSTGRES_SSL_MODE !== 'verify-full')
    return result(request, manifestSha256, {
      error_code: 'configuration_error',
    });

  let credential: MigrationCredential;
  try {
    credential = await dependencies.loadCredential(secretArn);
  } catch {
    return result(request, manifestSha256, { error_code: 'credential_error' });
  }

  let dataSource: DataSource;
  try {
    dataSource = dependencies.createDataSource(dependencies.env, credential);
  } catch {
    return result(request, manifestSha256, {
      error_code: 'configuration_error',
    });
  }
  let initialized = false;
  try {
    await dataSource.initialize();
    initialized = true;
    const identity = {
      database: dependencies.env.POSTGRES_DB_NAME ?? '',
      migrator: 'core_migrator',
      tls: dependencies.env.POSTGRES_SSL_MODE === 'verify-full',
    };
    const execution =
      request.operation === 'apply'
        ? await executeMigrations(dataSource, manifest, identity, {
            expectedHistorySha256: request.expected_history_sha256,
          })
        : null;
    const history =
      execution?.history ??
      (await validateMigrations(dataSource, manifest, identity));
    const historySha256 = migrationHistorySha256(history);
    const pending = manifest.migrations
      .filter((entry) => !history.some((row) => row.name === entry.name))
      .map(({ name }) => name);
    return result(request, manifestSha256, {
      status:
        execution && execution.appliedNames.length === 0
          ? 'no_changes'
          : 'succeeded',
      history_sha256: historySha256,
      applied_names: history.map(({ name }) => name),
      pending_names: pending,
      error_code: null,
    });
  } catch (error) {
    const errorCode =
      error instanceof MigrationExecutionError
        ? error.code.toLowerCase()
        : 'database_operation_failed';
    return result(request, manifestSha256, { error_code: errorCode });
  } finally {
    if (initialized) await dataSource.destroy().catch(() => undefined);
  }
};
