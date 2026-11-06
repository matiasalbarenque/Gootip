import { describe, expect, it } from 'vitest';

import {
  budgetedConnection,
  createOperationBudget,
  OperationBudgetExhaustedError,
} from '../src/migration-runner/budget.js';
import type { MigrationConnection } from '../src/migration-runner/database.js';

const connectionThatRecords = (
  handler: (
    text: string,
  ) => Promise<{ rows: readonly Record<string, unknown>[] }>,
): {
  statements: string[];
  values: (readonly unknown[] | undefined)[];
  connection: MigrationConnection;
} => {
  const statements: string[] = [];
  const values: (readonly unknown[] | undefined)[] = [];

  return {
    statements,
    values,
    connection: {
      query: async (text, parameters) => {
        statements.push(text);
        values.push(parameters);

        return handler(text);
      },
      close: async () => undefined,
    },
  };
};

const alwaysRows = () => connectionThatRecords(async () => ({ rows: [] }));

const mutableClock = (
  start = 0,
): { now: () => number; set: (value: number) => void } => {
  let current = start;

  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
  };
};

describe('createOperationBudget', () => {
  it('uses the reviewed timeout when the runtime is unknown', () => {
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 300_000,
      invocationRemainingMs: null,
      cleanupMarginMs: 30_000,
    });

    expect(budget.remainingMs()).toBe(300_000);
  });

  it('uses the runtime remaining time minus the cleanup margin when it is tighter', () => {
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 300_000,
      invocationRemainingMs: 120_000,
      cleanupMarginMs: 30_000,
    });

    expect(budget.remainingMs()).toBe(90_000);
  });

  it('never extends the reviewed timeout when the runtime reports more time', () => {
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 300_000,
      invocationRemainingMs: 900_000,
      cleanupMarginMs: 30_000,
    });

    expect(budget.remainingMs()).toBe(300_000);
  });

  it('clamps to zero when less than the cleanup margin remains', () => {
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 300_000,
      invocationRemainingMs: 10_000,
      cleanupMarginMs: 30_000,
    });

    expect(budget.remainingMs()).toBe(0);
    expect(budget.expired()).toBe(true);
    expect(budget.bounded(5_000)).toBe(0);
  });

  it('counts down against one absolute deadline', () => {
    const clock = mutableClock();
    const budget = createOperationBudget({
      now: clock.now,
      configuredMs: 1_000,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });

    expect(budget.deadline).toBe(1_000);
    expect(budget.expired()).toBe(false);
    expect(budget.bounded(50_000)).toBe(1_000);

    clock.set(750);

    expect(budget.remainingMs()).toBe(250);
    expect(budget.bounded(50_000)).toBe(250);
    expect(budget.expired()).toBe(false);

    clock.set(1_000);

    expect(budget.remainingMs()).toBe(0);
    expect(budget.expired()).toBe(true);
  });
});

describe('budgetedConnection', () => {
  it('adds no statement while the reviewed timeout already fits the budget', async () => {
    const { connection, statements } = alwaysRows();
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 300_000,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });

    await budgetedConnection(connection, budget, {
      statementTimeoutMs: 120_000,
    }).query('SELECT 1');

    expect(statements).toEqual(['SELECT 1']);
  });

  it('tightens the session statement timeout to the remaining budget', async () => {
    const { connection, statements } = alwaysRows();
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 50_000,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });

    await budgetedConnection(connection, budget, {
      statementTimeoutMs: 120_000,
    }).query('SELECT 1');

    expect(statements[0]).toContain("set_config('statement_timeout'");
    expect(statements[1]).toBe('SELECT 1');
  });

  it('refuses to start a statement once the budget is spent', async () => {
    const { connection, statements } = alwaysRows();
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 0,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });

    await expect(
      budgetedConnection(connection, budget, {
        statementTimeoutMs: 120_000,
      }).query('SELECT 1'),
    ).rejects.toBeInstanceOf(OperationBudgetExhaustedError);
    expect(statements).toEqual([]);
  });

  it('never writes a zero statement timeout, which would disable the bound', async () => {
    const clock = mutableClock();
    const { connection, statements, values } = alwaysRows();
    const budget = createOperationBudget({
      now: clock.now,
      configuredMs: 1_000,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });
    const bounded = budgetedConnection(connection, budget, {
      statementTimeoutMs: 120_000,
    });

    clock.set(999);
    await expect(bounded.query('SELECT 1')).resolves.toBeDefined();
    expect(values[0]).toEqual(['1']);

    clock.set(1_000);
    await expect(bounded.query('SELECT 2')).rejects.toBeInstanceOf(
      OperationBudgetExhaustedError,
    );
    expect(statements).not.toContain('SELECT 2');
    expect(values.every((parameters) => parameters?.[0] !== '0')).toBe(true);
  });

  it('maps a cancellation at the deadline to a budget exhaustion', async () => {
    const clock = mutableClock();
    const budget = createOperationBudget({
      now: clock.now,
      configuredMs: 1_000,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });
    const { connection } = connectionThatRecords(async () => {
      clock.set(1_000);

      throw Object.assign(
        new Error('canceling statement due to statement timeout'),
        {
          code: '57014',
        },
      );
    });

    await expect(
      budgetedConnection(connection, budget, {
        statementTimeoutMs: 500,
      }).query('SELECT 1'),
    ).rejects.toBeInstanceOf(OperationBudgetExhaustedError);
  });

  it('leaves a cancellation that is not the deadline alone', async () => {
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 1_000,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });
    const { connection } = connectionThatRecords(async () => {
      throw Object.assign(
        new Error('canceling statement due to statement timeout'),
        {
          code: '57014',
        },
      );
    });

    await expect(
      budgetedConnection(connection, budget, {
        statementTimeoutMs: 500,
      }).query('SELECT 1'),
    ).rejects.not.toBeInstanceOf(OperationBudgetExhaustedError);
  });

  it('lets the lock release run past the deadline', async () => {
    const { connection, statements } = alwaysRows();
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 0,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });
    const bounded = budgetedConnection(connection, budget, {
      statementTimeoutMs: 120_000,
    });

    await expect(
      bounded.query('SELECT pg_advisory_unlock($1)', ['42']),
    ).resolves.toEqual({ rows: [] });
    expect(statements).toEqual(['SELECT pg_advisory_unlock($1)']);
  });

  it('lets the transaction rollback run past the deadline', async () => {
    const { connection, statements } = alwaysRows();
    const budget = createOperationBudget({
      now: mutableClock().now,
      configuredMs: 0,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });
    const bounded = budgetedConnection(connection, budget, {
      statementTimeoutMs: 120_000,
    });

    await expect(bounded.query('ROLLBACK')).resolves.toEqual({ rows: [] });
    expect(statements).toEqual(['ROLLBACK']);
  });

  it('re-applies the bound after a failed statement', async () => {
    const clock = mutableClock();
    const budget = createOperationBudget({
      now: clock.now,
      configuredMs: 400,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });
    let fail = true;
    const { connection, values } = connectionThatRecords(async () => {
      if (fail) {
        fail = false;

        throw new Error('boom');
      }

      return { rows: [] };
    });
    const bounded = budgetedConnection(connection, budget, {
      statementTimeoutMs: 120_000,
    });

    await expect(bounded.query('SELECT 1')).rejects.toThrow('boom');

    clock.set(100);
    await bounded.query('SELECT 2');

    const bounds = values
      .filter((parameters) => parameters?.[0] !== undefined)
      .map((parameters) => parameters?.[0]);

    expect(bounds).toEqual(['400', '300']);
  });
});
