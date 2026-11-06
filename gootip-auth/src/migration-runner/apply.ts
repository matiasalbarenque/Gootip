import {
  OperationBudgetExhaustedError,
  type OperationBudget,
} from './budget.js';
import type { MigrationErrorCode } from './contract.js';
import type { MigrationConnection } from './database.js';
import { sha256Hex } from './digest.js';
import { insertHistoryRow } from './history.js';
import type { MigrationManifest } from './manifest.js';
import { validateMigrationSql } from './sql-policy.js';

/**
 * Applies pending reviewed SQL one migration at a time.
 *
 * Each migration runs on the session's single connection inside a transaction the
 * runner opens itself: the reviewed SQL, the history insert, and the outcome
 * check commit together, or the transaction rolls back and the run stops.
 * Earlier commits stay committed, and a failed migration never leaves a
 * successful history row.
 *
 * Every file is policy-validated before the first transaction starts, so a
 * forbidden statement cannot partially apply, and the SQL bytes are re-hashed
 * against the manifest entry so a tampered in-memory source cannot be applied
 * under a reviewed identity.
 */

export interface MigrationSource {
  manifest: MigrationManifest;
  sql: ReadonlyMap<string, string>;
}

export interface ApplyContext {
  schema: string;
  commitSha: string;
  runId: string;
  budget: OperationBudget;
}

export type ApplyFailureCode = Extract<
  MigrationErrorCode,
  | 'manifest_mismatch'
  | 'sql_policy_violation'
  | 'sql_failed'
  | 'operation_timeout'
  | 'verification_failed'
>;

export type ApplyResult =
  | { ok: true; appliedIds: string[] }
  | { ok: false; errorCode: ApplyFailureCode; appliedIds: string[] };

class HistoryRowNotRecorded extends Error {
  constructor() {
    super('the history row was not recorded');
    this.name = 'HistoryRowNotRecorded';
  }
}

const failureCode = (error: unknown): ApplyFailureCode => {
  if (error instanceof OperationBudgetExhaustedError) {
    return 'operation_timeout';
  }

  if (error instanceof HistoryRowNotRecorded) {
    return 'verification_failed';
  }

  return 'sql_failed';
};

/**
 * Orders the pending ids through the manifest so a caller cannot reorder or
 * inject an entry: the manifest order always wins, and an id that is not in the
 * manifest makes the pending set inconsistent.
 */
const pendingEntries = (
  source: MigrationSource,
  pendingIds: readonly string[],
): MigrationManifest['migrations'] =>
  source.manifest.migrations.filter((entry) => pendingIds.includes(entry.id));

export const applyPendingMigrations = async (
  connection: MigrationConnection,
  source: MigrationSource,
  context: ApplyContext,
  pendingIds: readonly string[],
): Promise<ApplyResult> => {
  const entries = pendingEntries(source, pendingIds);

  if (entries.length !== pendingIds.length) {
    return { ok: false, errorCode: 'manifest_mismatch', appliedIds: [] };
  }

  const statements = new Map<string, string>();

  for (const entry of entries) {
    const sql = source.sql.get(entry.file);

    if (sql === undefined) {
      return { ok: false, errorCode: 'manifest_mismatch', appliedIds: [] };
    }

    if (sha256Hex(sql) !== entry.sha256) {
      return { ok: false, errorCode: 'manifest_mismatch', appliedIds: [] };
    }

    if (!validateMigrationSql(sql).ok) {
      return { ok: false, errorCode: 'sql_policy_violation', appliedIds: [] };
    }

    statements.set(entry.id, sql);
  }

  const appliedIds: string[] = [];
  for (const entry of entries) {
    if (context.budget.expired()) {
      return {
        ok: false,
        errorCode: 'operation_timeout',
        appliedIds,
      };
    }

    try {
      await connection.query('BEGIN');
      await connection.query(statements.get(entry.id) as string);

      const recorded = await insertHistoryRow(connection, context.schema, {
        migrationId: entry.id,
        checksumSha256: entry.sha256,
        commitSha: context.commitSha,
        runId: context.runId,
        applicationMode: 'applied',
        approvalReference: null,
        schemaFingerprint: null,
      });

      if (recorded !== 1) {
        throw new HistoryRowNotRecorded();
      }

      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);

      return {
        ok: false,
        errorCode: failureCode(error),
        appliedIds,
      };
    }

    appliedIds.push(entry.id);
  }

  return { ok: true, appliedIds };
};
