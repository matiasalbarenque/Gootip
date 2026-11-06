import {
  budgetedConnection,
  createOperationBudget,
  OperationBudgetExhaustedError,
  type OperationBudget,
} from './budget.js';
import { loadMigrationBundle, type BundleLoadResult } from './bundle.js';
import {
  MIGRATION_LAMBDA_CLEANUP_MARGIN_SECONDS,
  readMigrationConfig,
  type MigrationConfig,
} from './config.js';
import { createResult, type MigrationResult } from './contract.js';
import {
  loadMigratorCredential,
  type CredentialLoadResult,
  type MigrationCredential,
} from './credentials.js';
import { connectToDatabase, type ConnectionResult } from './database.js';
import { isInvocationAuthorized } from './invocation.js';
import { advisoryLockKey } from './lock.js';
import { verifyMigrationIdentity } from './preflight.js';
import { logMigrationReport, type MigrationReporter } from './report.js';
import { validateMigrationRequest } from './request.js';
import { runMigrationSession } from './session.js';

/**
 * Runs one fixed migration operation.
 *
 * The order is fixed and fails closed before mutation: event validation,
 * deployment configuration, bundled manifest identity, credential identity,
 * the live role/database/permission checks, then the session advisory lock and
 * the history phase. SQL application, structural baseline checking, and the
 * separately authorized adoption path all run under that lock.
 *
 * A single absolute deadline, derived from the reviewed operation timeout and
 * the runtime's real remaining time, bounds every phase and statement.
 */

export interface MigrationDependencies {
  env: Record<string, string | undefined>;
  loadManifest: () => BundleLoadResult;
  loadCredential: (config: MigrationConfig) => Promise<CredentialLoadResult>;
  connect: (
    config: MigrationConfig,
    credential: MigrationCredential,
    budget: OperationBudget,
  ) => Promise<ConnectionResult>;
  now: () => number;
  /** The runtime's real remaining time, or null outside Lambda. */
  remainingInvocationMs: () => number | null;
  /** Trusted Lambda context ARN; never supplied by the invocation event. */
  invokedFunctionArn: () => string | null;
  /** Sanitized outcome observer; defaults to one structured CloudWatch line. */
  report: MigrationReporter;
}

const defaultDependencies = (): MigrationDependencies => ({
  env: process.env,
  loadManifest: () => loadMigrationBundle(),
  loadCredential: (config) => loadMigratorCredential(config),
  connect: (config, credential, budget) =>
    connectToDatabase(config, credential, budget),
  now: () => Date.now(),
  remainingInvocationMs: () => null,
  invokedFunctionArn: () => null,
  report: logMigrationReport,
});

export const runMigration = async (
  event: unknown,
  overrides: Partial<MigrationDependencies> = {},
): Promise<MigrationResult> => {
  const requestValidation = validateMigrationRequest(event);

  if (!requestValidation.ok) {
    return createResult({ status: 'failed', error_code: 'invalid_request' });
  }

  const request = requestValidation.request;
  const dependencies = { ...defaultDependencies(), ...overrides };

  // This is intentionally before configuration, manifest, Secrets Manager, and
  // database access. A deployment-alias caller can never turn an event field
  // into baseline authority, and unqualified/version/$LATEST calls fail closed.
  if (
    !isInvocationAuthorized(
      request.operation,
      dependencies.invokedFunctionArn(),
    )
  ) {
    return createResult({
      operation: request.operation,
      run_id: request.run_id,
      commit_sha: request.commit_sha,
      status: 'failed',
      error_code: 'invalid_request',
    });
  }

  const correlation = {
    operation: request.operation,
    run_id: request.run_id,
    commit_sha: request.commit_sha,
  };

  const configValidation = readMigrationConfig(dependencies.env);

  if (!configValidation.ok) {
    return createResult({
      ...correlation,
      status: 'failed',
      error_code: 'configuration_error',
    });
  }

  const config = configValidation.config;
  const budget = createOperationBudget({
    now: dependencies.now,
    configuredMs: config.timeouts.operationSeconds * 1000,
    invocationRemainingMs: dependencies.remainingInvocationMs(),
    cleanupMarginMs: MIGRATION_LAMBDA_CLEANUP_MARGIN_SECONDS * 1000,
  });
  const bundleResult = dependencies.loadManifest();

  if (!bundleResult.ok) {
    return createResult({
      ...correlation,
      status: 'failed',
      error_code: 'manifest_mismatch',
    });
  }

  const { manifest, manifestSha256, sql } = bundleResult.bundle;
  const withManifest = { ...correlation, manifest_sha256: manifestSha256 };

  if (
    manifestSha256 !== request.expected_manifest_sha256 ||
    manifest.schema !== config.schema
  ) {
    return createResult({
      ...withManifest,
      status: 'failed',
      error_code: 'manifest_mismatch',
    });
  }

  let credentialResult: CredentialLoadResult;

  if (budget.expired()) {
    return createResult({
      ...withManifest,
      status: 'failed',
      error_code: 'operation_timeout',
    });
  }

  try {
    credentialResult = await dependencies.loadCredential(config);
  } catch {
    return createResult({
      ...withManifest,
      status: 'failed',
      error_code: 'credential_error',
    });
  }

  if (!credentialResult.ok) {
    return createResult({
      ...withManifest,
      status: 'failed',
      error_code: 'credential_error',
    });
  }

  let connectionResult: ConnectionResult;

  try {
    connectionResult = await dependencies.connect(
      config,
      credentialResult.credential,
      budget,
    );
  } catch {
    return createResult({
      ...withManifest,
      status: 'failed',
      error_code: 'connection_error',
    });
  }

  if (!connectionResult.ok) {
    return createResult({
      ...withManifest,
      status: 'failed',
      error_code: connectionResult.errorCode,
    });
  }

  const connection = budgetedConnection(connectionResult.connection, budget, {
    statementTimeoutMs: config.timeouts.statementSeconds * 1000,
  });

  try {
    const identity = await verifyMigrationIdentity(connection, {
      user: config.user,
      database: config.database.name,
      schema: config.schema,
    });

    if (!identity.ok) {
      return createResult({
        ...withManifest,
        status: 'failed',
        error_code: identity.errorCode,
      });
    }

    const session = await runMigrationSession(
      connection,
      request,
      { manifest, sql },
      {
        schema: config.schema,
        migratorUser: config.user,
        runtimeUser: config.runtimeUser,
        lockKey: advisoryLockKey(config.database.name, config.schema),
        lockTimeoutMs: config.timeouts.lockSeconds * 1000,
        budget,
        report: dependencies.report,
      },
    );

    return createResult({
      ...withManifest,
      status: session.status,
      error_code: session.errorCode,
      history_sha256: session.historySha256,
      applied_ids: session.appliedIds,
      pending_ids: session.pendingIds,
    });
  } catch (error) {
    return createResult({
      ...withManifest,
      status: 'failed',
      error_code:
        error instanceof OperationBudgetExhaustedError
          ? 'operation_timeout'
          : 'verification_failed',
    });
  } finally {
    await connectionResult.connection.close().catch(() => undefined);
  }
};
