import type { MigrationConnection } from './database.js';

/**
 * One absolute deadline for the whole invocation.
 *
 * The deadline is computed once from the tighter of the reviewed operation
 * budget and what the runtime actually has left (the Lambda context's remaining
 * time minus the cleanup margin). Everything that follows — credential load,
 * connection, lock acquisition, history verification, each statement, and (in
 * later steps) each migration transaction — is measured against that single
 * absolute deadline, so a slow phase cannot borrow time from the next one.
 *
 * Every statement is additionally bounded server-side: when the remaining
 * budget drops below the reviewed statement timeout, the session
 * `statement_timeout` is tightened to the remaining budget before the statement
 * runs. A statement therefore can never outlive the deadline.
 */

export class OperationBudgetExhaustedError extends Error {
  constructor() {
    super('the operation budget is exhausted');
    this.name = 'OperationBudgetExhaustedError';
  }
}

export interface OperationBudget {
  /** Absolute epoch milliseconds by which all work must be finished. */
  readonly deadline: number;
  now: () => number;
  remainingMs: () => number;
  expired: () => boolean;
  /** Clamps a reviewed timeout to the remaining budget, in whole milliseconds. */
  bounded: (limitMs: number) => number;
}

export interface OperationBudgetOptions {
  now: () => number;
  /** Reviewed total-operation timeout. */
  configuredMs: number;
  /** The runtime's own remaining time, or null outside Lambda. */
  invocationRemainingMs: number | null;
  /** Time reserved for releasing the lock, closing, and building the result. */
  cleanupMarginMs: number;
}

export const createOperationBudget = (
  options: OperationBudgetOptions,
): OperationBudget => {
  const limits = [options.configuredMs];

  if (options.invocationRemainingMs !== null) {
    limits.push(options.invocationRemainingMs - options.cleanupMarginMs);
  }

  const budgetMs = Math.max(0, Math.floor(Math.min(...limits)));
  const deadline = options.now() + budgetMs;

  return {
    deadline,
    now: options.now,
    remainingMs: () => Math.max(0, deadline - options.now()),
    expired: () => options.now() >= deadline,
    bounded: (limitMs: number) =>
      Math.max(0, Math.floor(Math.min(limitMs, deadline - options.now()))),
  };
};

export interface BudgetedConnectionOptions {
  /** Reviewed statement timeout, already applied to the session at connect. */
  statementTimeoutMs: number;
}

const isStatementCanceled = (error: unknown): boolean =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  (error as { code?: unknown }).code === '57014';

/**
 * Lock release and transaction rollback are cleanup, paid for by the reserved
 * cleanup margin, so they are allowed to run after the work deadline. A rollback
 * must also skip the timeout tightening: the transaction is already aborted, so
 * only ROLLBACK/COMMIT would be accepted there. Both are fixed statements the
 * session issues itself, never caller-provided SQL.
 */
const CLEANUP_STATEMENT =
  /^\s*(SELECT\s+pg_advisory_unlock\(|ROLLBACK\s*$|ABORT\s*$)/i;

/**
 * Wraps the dedicated connection so no statement can start after the deadline
 * and no statement can run past it.
 *
 * The session `statement_timeout` is only re-issued when the remaining budget
 * has dropped below the value already applied, which keeps the common path at
 * zero extra round trips: the reviewed timeout already guarantees a statement
 * cannot pass the deadline while the budget is larger than it.
 */
export const budgetedConnection = (
  connection: MigrationConnection,
  budget: OperationBudget,
  options: BudgetedConnectionOptions,
): MigrationConnection => {
  let appliedStatementTimeoutMs = options.statementTimeoutMs;

  const tightenStatementTimeout = async (): Promise<void> => {
    const bound = budget.bounded(options.statementTimeoutMs);

    // `statement_timeout = 0` disables the timeout, so a zero bound is never
    // written; it means the deadline already arrived.
    if (bound <= 0) {
      throw new OperationBudgetExhaustedError();
    }

    if (bound < appliedStatementTimeoutMs) {
      await connection.query(
        `SELECT set_config('statement_timeout', $1, false) AS statement_timeout`,
        [`${bound}`],
      );
      appliedStatementTimeoutMs = bound;
    }
  };

  return {
    query: async (text, values) => {
      if (CLEANUP_STATEMENT.test(text)) {
        return connection.query(text, values);
      }

      await tightenStatementTimeout();

      try {
        return await connection.query(text, values);
      } catch (error) {
        // A transaction rollback reverts a session-level `SET`, and the applied
        // bound is no longer trustworthy after any failure.
        appliedStatementTimeoutMs = options.statementTimeoutMs;

        if (budget.expired() && isStatementCanceled(error)) {
          throw new OperationBudgetExhaustedError();
        }

        throw error;
      }
    },
    close: () => connection.close(),
  };
};
