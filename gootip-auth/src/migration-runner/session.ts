import {
  applyPendingMigrations,
  type ApplyFailureCode,
  type MigrationSource,
} from './apply.js';
import {
  checkBaselineEquivalence,
  detectApplicationObjects,
} from './baseline.js';
import {
  OperationBudgetExhaustedError,
  type OperationBudget,
} from './budget.js';
import type {
  MigrationErrorCode,
  MigrationRequest,
  MigrationStatus,
} from './contract.js';
import type { MigrationConnection } from './database.js';
import {
  createHistoryTable,
  historyDigest,
  historyTableExists,
  insertHistoryRow,
  readHistory,
  validateHistoryTableStructure,
  verifyHistory,
  verifyHistoryProtection,
  type HistoryRow,
  type HistoryVerification,
} from './history.js';
import { acquireSessionLock, releaseSessionLock } from './lock.js';
import type { MigrationReporter } from './report.js';
import { formatSchemaDifferences } from './schema-comparison.js';

/**
 * The single ordered history phase, always executed while holding the session
 * advisory lock.
 *
 * Nothing is created or read before the lock is held, so two concurrent
 * invocations cannot both believe they are the first, and the ordered SQL
 * application that follows in the same session sees the same verified history.
 * A read-only operation never creates the table; only `apply` and
 * `baseline_adopt` may record history.
 *
 * `apply` fails closed with `baseline_approval_required` before creating
 * anything when application objects already exist without history. Baseline
 * checking and adoption revalidate the live structure, the reviewed
 * fingerprint, and the approved history digest under this same lock.
 *
 * The connection passed in must already be wrapped with `budgetedConnection`,
 * so every statement and wait is bounded by the invocation's absolute deadline.
 */

export interface MigrationSessionContext {
  schema: string;
  migratorUser: string;
  runtimeUser: string;
  lockKey: string;
  lockTimeoutMs: number;
  budget: OperationBudget;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Sanitized per-outcome observer; never allowed to change the outcome. */
  report?: MigrationReporter;
}

export interface MigrationSessionOutcome {
  status: MigrationStatus;
  errorCode: MigrationErrorCode | null;
  historySha256: string | null;
  appliedIds: string[];
  pendingIds: string[];
}

/** An outcome plus the bounded reason written to the sanitized report. */
interface SessionDecision {
  outcome: MigrationSessionOutcome;
  reason: string;
}

type VerifiedHistory = {
  historySha256: string;
  verification: Extract<HistoryVerification, { ok: true }>;
};

const failure = (
  errorCode: MigrationErrorCode,
  historySha256: string | null = null,
  appliedIds: string[] = [],
  pendingIds: string[] = [],
): MigrationSessionOutcome => ({
  status: 'failed',
  errorCode,
  historySha256,
  appliedIds,
  pendingIds,
});

const decided = (
  outcome: MigrationSessionOutcome,
  reason: string,
): SessionDecision => ({ outcome, reason });

const failureDecision = (
  errorCode: MigrationErrorCode,
  reason: string,
  historySha256: string | null = null,
  appliedIds: string[] = [],
  pendingIds: string[] = [],
): SessionDecision =>
  decided(failure(errorCode, historySha256, appliedIds, pendingIds), reason);

const successDecision = (
  historySha256: string,
  appliedIds: string[],
  pendingIds: string[],
  reason: string,
): SessionDecision =>
  decided(
    {
      status: 'succeeded',
      errorCode: null,
      historySha256,
      appliedIds,
      pendingIds,
    },
    reason,
  );

/**
 * A database that already holds application objects is not applied to or
 * adopted automatically: an operator has to review and authorize the baseline.
 */
const baselineRequiredDecision = (
  pendingIds: string[],
  reason: string,
): SessionDecision =>
  decided(
    {
      status: 'baseline_approval_required',
      errorCode: null,
      historySha256: historyDigest([]),
      appliedIds: [],
      pendingIds,
    },
    reason,
  );

const assertBudget = (budget: OperationBudget): void => {
  if (budget.expired()) {
    throw new OperationBudgetExhaustedError();
  }
};

/**
 * Best-effort live digest for a run that already committed something. If it
 * cannot be read, `null` is reported instead of a stale pre-run digest: an
 * uncertain outcome has to be reconciled with `validate`.
 */
const observedHistoryDigest = async (
  connection: MigrationConnection,
  schema: string,
): Promise<string | null> => {
  try {
    return historyDigest(await readHistory(connection, schema));
  } catch {
    return null;
  }
};

const settle = (
  request: MigrationRequest,
  context: MigrationSessionContext,
  outcome: MigrationSessionOutcome,
  reason: string,
): MigrationSessionOutcome => {
  try {
    context.report?.({
      operation: request.operation,
      status: outcome.status,
      error_code: outcome.errorCode,
      run_id: request.run_id,
      commit_sha: request.commit_sha,
      applied: outcome.appliedIds.length,
      pending: outcome.pendingIds.length,
      reason,
    });
  } catch {
    // Observability must never change the outcome of a migration operation.
  }

  return outcome;
};

const applyFailureReason = (code: ApplyFailureCode): string => {
  switch (code) {
    case 'sql_policy_violation':
      return 'a reviewed migration contains a disallowed statement';
    case 'manifest_mismatch':
      return 'the bundled SQL does not match the manifest';
    case 'operation_timeout':
      return 'the operation deadline was exhausted';
    case 'verification_failed':
      return 'the history row was not recorded';
    case 'sql_failed':
      return 'a reviewed migration failed to apply';
  }
};

export const runMigrationSession = async (
  connection: MigrationConnection,
  request: MigrationRequest,
  source: MigrationSource,
  context: MigrationSessionContext,
): Promise<MigrationSessionOutcome> => {
  const { budget } = context;
  let held = false;

  if (budget.expired()) {
    return settle(
      request,
      context,
      failure('operation_timeout'),
      'the operation deadline was already exhausted',
    );
  }

  try {
    // The session lock must fit inside the absolute deadline: a contended lock
    // that would overrun the invocation fails instead of being retried.
    const lock = await acquireSessionLock(connection, context.lockKey, {
      timeoutMs: budget.bounded(context.lockTimeoutMs),
      pollIntervalMs: context.pollIntervalMs,
      now: budget.now,
      sleep: context.sleep,
    });

    if (!lock.ok) {
      return settle(
        request,
        context,
        failure(
          lock.errorCode === 'lock_timeout' && budget.expired()
            ? 'operation_timeout'
            : lock.errorCode,
        ),
        'the session lock was not acquired',
      );
    }

    held = true;

    const decision = await verifyHistoryUnderLock(
      connection,
      request,
      source,
      context,
    );

    return settle(request, context, decision.outcome, decision.reason);
  } catch (error) {
    if (error instanceof OperationBudgetExhaustedError) {
      return settle(
        request,
        context,
        failure('operation_timeout'),
        'the operation deadline was exhausted',
      );
    }

    throw error;
  } finally {
    if (held) {
      await releaseSessionLock(connection, context.lockKey).catch(() => false);
    }
  }
};

const verifyHistoryUnderLock = async (
  connection: MigrationConnection,
  request: MigrationRequest,
  source: MigrationSource,
  context: MigrationSessionContext,
): Promise<SessionDecision> => {
  const { budget } = context;

  assertBudget(budget);
  const present = await historyTableExists(connection, context.schema);

  if (request.operation === 'baseline_check') {
    return checkBaseline(connection, request, source, context, present);
  }

  if (request.operation === 'baseline_adopt') {
    return adoptBaseline(connection, request, source, context, present);
  }

  let hasHistoryTable = present;
  let createdEmptyHistory = false;

  if (request.operation === 'apply' && !hasHistoryTable) {
    // The gate runs before creation: a database with application objects but no
    // reliable history must stay untouched until an operator adopts it.
    assertBudget(budget);
    const objects = await detectApplicationObjects(connection, context.schema);

    if (objects.present) {
      return baselineRequiredDecision(
        source.manifest.migrations.map((entry) => entry.id),
        'application objects exist without migration history',
      );
    }

    assertBudget(budget);
    await createHistoryTable(connection, context.schema, context.runtimeUser);
    hasHistoryTable = true;
    createdEmptyHistory = true;
  }

  const verified = await verifyLiveHistory(
    connection,
    request,
    source,
    context,
    hasHistoryTable,
  );

  if ('decision' in verified) {
    return verified.decision;
  }

  if (request.operation === 'validate') {
    return successDecision(
      verified.historySha256,
      verified.verification.appliedIds,
      verified.verification.pendingIds,
      'the live history is valid',
    );
  }

  return applyPending(
    connection,
    request,
    source,
    context,
    verified,
    createdEmptyHistory,
  );
};

/**
 * Validates an existing history table, reads it, and enforces the manifest
 * prefix plus an operator-supplied digest. An absent table verifies as empty
 * history without issuing a read.
 */
const verifyLiveHistory = async (
  connection: MigrationConnection,
  request: MigrationRequest,
  source: MigrationSource,
  context: MigrationSessionContext,
  present: boolean,
): Promise<VerifiedHistory | { decision: SessionDecision }> => {
  const { budget } = context;

  if (present) {
    // `CREATE TABLE IF NOT EXISTS` leaves a pre-existing table untouched, so the
    // structure is validated whether the table was just created or already
    // existed.
    assertBudget(budget);
    const structure = await validateHistoryTableStructure(
      connection,
      context.schema,
    );

    if (!structure.ok) {
      return {
        decision: failureDecision('history_invalid', structure.reason),
      };
    }

    assertBudget(budget);
    const protection = await verifyHistoryProtection(
      connection,
      context.schema,
      context.migratorUser,
      context.runtimeUser,
    );

    if (!protection.ok) {
      return {
        decision: failureDecision('privilege_mismatch', protection.reason),
      };
    }
  }

  assertBudget(budget);
  const rows = present ? await readHistory(connection, context.schema) : [];
  const verification = verifyHistory(rows, source.manifest);

  if (!verification.ok) {
    return {
      decision: failureDecision('history_invalid', verification.reason),
    };
  }

  const historySha256 = historyDigest(rows);

  if (
    request.expected_history_sha256 !== undefined &&
    request.expected_history_sha256 !== historySha256
  ) {
    return {
      decision: failureDecision(
        'history_invalid',
        'the live history digest does not match the approved digest',
        historySha256,
        verification.appliedIds,
        verification.pendingIds,
      ),
    };
  }

  return { historySha256, verification };
};

const applyPending = async (
  connection: MigrationConnection,
  request: MigrationRequest,
  source: MigrationSource,
  context: MigrationSessionContext,
  verified: VerifiedHistory,
  createdEmptyHistory: boolean,
): Promise<SessionDecision> => {
  const { budget } = context;

  // A history table that already existed may be empty while the schema holds
  // application objects; adoption is still required, so nothing is applied.
  if (verified.verification.appliedIds.length === 0 && !createdEmptyHistory) {
    assertBudget(budget);
    const objects = await detectApplicationObjects(connection, context.schema);

    if (objects.present) {
      return baselineRequiredDecision(
        verified.verification.pendingIds,
        'application objects exist without migration history',
      );
    }
  }

  if (verified.verification.pendingIds.length === 0) {
    return decided(
      {
        status: 'no_changes',
        errorCode: null,
        historySha256: verified.historySha256,
        appliedIds: verified.verification.appliedIds,
        pendingIds: [],
      },
      'the manifest is already applied',
    );
  }

  assertBudget(budget);
  const application = await applyPendingMigrations(
    connection,
    source,
    {
      schema: context.schema,
      commitSha: request.commit_sha,
      runId: request.run_id,
      budget,
    },
    verified.verification.pendingIds,
  );

  if (!application.ok) {
    return failureDecision(
      application.errorCode,
      applyFailureReason(application.errorCode),
      application.appliedIds.length === 0
        ? verified.historySha256
        : await observedHistoryDigest(connection, context.schema),
      application.appliedIds,
      verified.verification.pendingIds.filter(
        (id) => !application.appliedIds.includes(id),
      ),
    );
  }

  // Final validation: the history must now match the whole manifest, still
  // read under the same held lock. An uncertainty here is never reported as
  // success, and the committed ids are still reported so the operator knows
  // what may have landed.
  let finalRows: HistoryRow[];

  try {
    assertBudget(budget);
    finalRows = await readHistory(connection, context.schema);
  } catch (error) {
    if (error instanceof OperationBudgetExhaustedError) {
      return failureDecision(
        'operation_timeout',
        'the operation deadline was exhausted',
        await observedHistoryDigest(connection, context.schema),
        application.appliedIds,
        [],
      );
    }

    throw error;
  }

  const finalVerification = verifyHistory(finalRows, source.manifest);

  if (
    !finalVerification.ok ||
    finalVerification.pendingIds.length > 0 ||
    finalVerification.appliedIds.length !== source.manifest.migrations.length
  ) {
    return failureDecision(
      'verification_failed',
      'the recorded history does not match the manifest',
      historyDigest(finalRows),
      application.appliedIds,
      [],
    );
  }

  return successDecision(
    historyDigest(finalRows),
    application.appliedIds,
    [],
    'applied the pending migrations',
  );
};

/**
 * Read-only structural check. It never creates the history table or records
 * anything; a matching structure means adoption is possible, not that it has
 * been authorized.
 */
const checkBaseline = async (
  connection: MigrationConnection,
  request: MigrationRequest,
  source: MigrationSource,
  context: MigrationSessionContext,
  present: boolean,
): Promise<SessionDecision> => {
  const verified = await verifyLiveHistory(
    connection,
    request,
    source,
    context,
    present,
  );

  if ('decision' in verified) {
    return verified.decision;
  }

  if (verified.verification.appliedIds.length > 0) {
    return failureDecision(
      'history_invalid',
      'baseline checking requires empty history',
      verified.historySha256,
      verified.verification.appliedIds,
      verified.verification.pendingIds,
    );
  }

  assertBudget(context.budget);
  const equivalence = await checkBaselineEquivalence(
    connection,
    context.schema,
    source.manifest.initial_schema,
    source.manifest.initial_schema_fingerprint,
  );

  if (!equivalence.ok) {
    return failureDecision(
      'baseline_mismatch',
      formatSchemaDifferences(equivalence.differences),
      verified.historySha256,
      verified.verification.appliedIds,
      verified.verification.pendingIds,
    );
  }

  return successDecision(
    verified.historySha256,
    verified.verification.appliedIds,
    verified.verification.pendingIds,
    'the live structure matches the reviewed initial structure',
  );
};

/**
 * Records the reviewed initial migration as `baseline_verified` without
 * re-running its table creation.
 *
 * Every piece of evidence is revalidated under the held lock: the approved
 * fingerprint must be the reviewed one, the live structure must match it
 * exactly, and the approved history digest must match the live (empty) history.
 * The row itself is written in one transaction together with nothing else.
 */
const adoptBaseline = async (
  connection: MigrationConnection,
  request: MigrationRequest,
  source: MigrationSource,
  context: MigrationSessionContext,
  present: boolean,
): Promise<SessionDecision> => {
  const { budget } = context;
  const { manifest } = source;

  const verified = await verifyLiveHistory(
    connection,
    request,
    source,
    context,
    present,
  );

  if ('decision' in verified) {
    return verified.decision;
  }

  if (verified.verification.appliedIds.length > 0) {
    return failureDecision(
      'history_invalid',
      'baseline adoption requires empty history',
      verified.historySha256,
      verified.verification.appliedIds,
      verified.verification.pendingIds,
    );
  }

  const initial = manifest.migrations[0];

  if (!initial) {
    return failureDecision(
      'manifest_mismatch',
      'the manifest has no initial migration',
    );
  }

  if (request.approval_reference === undefined) {
    return failureDecision(
      'invalid_request',
      'baseline adoption requires an approval reference',
    );
  }

  if (
    request.expected_schema_fingerprint !== manifest.initial_schema_fingerprint
  ) {
    return failureDecision(
      'baseline_mismatch',
      'the approved fingerprint is not the reviewed initial structure',
      verified.historySha256,
      verified.verification.appliedIds,
      verified.verification.pendingIds,
    );
  }

  assertBudget(budget);
  const equivalence = await checkBaselineEquivalence(
    connection,
    context.schema,
    manifest.initial_schema,
    request.expected_schema_fingerprint,
  );

  if (!equivalence.ok) {
    return failureDecision(
      'baseline_mismatch',
      formatSchemaDifferences(equivalence.differences),
      verified.historySha256,
      verified.verification.appliedIds,
      verified.verification.pendingIds,
    );
  }

  // Creation happens only after equivalence passed, so a mismatched adoption
  // leaves the database exactly as it was.
  if (!present) {
    assertBudget(budget);
    await createHistoryTable(connection, context.schema, context.runtimeUser);
  }

  try {
    await connection.query('BEGIN');

    const recorded = await insertHistoryRow(connection, context.schema, {
      migrationId: initial.id,
      checksumSha256: initial.sha256,
      commitSha: request.commit_sha,
      runId: request.run_id,
      applicationMode: 'baseline_verified',
      approvalReference: request.approval_reference,
      schemaFingerprint: equivalence.fingerprint,
    });

    if (recorded !== 1) {
      await connection.query('ROLLBACK').catch(() => undefined);

      return failureDecision(
        'verification_failed',
        'the verified baseline was not recorded',
        verified.historySha256,
        verified.verification.appliedIds,
        verified.verification.pendingIds,
      );
    }

    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);

    return failureDecision(
      error instanceof OperationBudgetExhaustedError
        ? 'operation_timeout'
        : 'sql_failed',
      'the verified baseline could not be recorded',
      await observedHistoryDigest(connection, context.schema),
      verified.verification.appliedIds,
      verified.verification.pendingIds,
    );
  }

  let finalRows: HistoryRow[];

  try {
    assertBudget(budget);
    finalRows = await readHistory(connection, context.schema);
  } catch (error) {
    if (error instanceof OperationBudgetExhaustedError) {
      return failureDecision(
        'operation_timeout',
        'the operation deadline was exhausted',
        await observedHistoryDigest(connection, context.schema),
        [initial.id],
        verified.verification.pendingIds.filter((id) => id !== initial.id),
      );
    }

    throw error;
  }

  const finalVerification = verifyHistory(finalRows, manifest);

  if (
    !finalVerification.ok ||
    finalVerification.appliedIds.length !== 1 ||
    finalVerification.appliedIds[0] !== initial.id
  ) {
    return failureDecision(
      'verification_failed',
      'the recorded baseline does not match the manifest',
      historyDigest(finalRows),
      [initial.id],
      [],
    );
  }

  return successDecision(
    historyDigest(finalRows),
    finalVerification.appliedIds,
    finalVerification.pendingIds,
    'the verified baseline was recorded',
  );
};
