import { describe, expect, it } from 'vitest';

import type { MigrationSource } from '../src/migration-runner/apply.js';
import {
  budgetedConnection,
  createOperationBudget,
  type OperationBudget,
} from '../src/migration-runner/budget.js';
import type { MigrationRequest } from '../src/migration-runner/contract.js';
import type { MigrationConnection } from '../src/migration-runner/database.js';
import { sha256Hex } from '../src/migration-runner/digest.js';
import { historyDigest } from '../src/migration-runner/history.js';
import { fingerprintDescriptor } from '../src/migration-runner/schema-descriptor.js';
import {
  runMigrationSession,
  type MigrationSessionContext,
} from '../src/migration-runner/session.js';
import {
  descriptorRows,
  fixtureMigrationSql,
  historyConstraintRows,
  historyModeProbeRows,
  historyRow,
  historyStructureRows,
  migrationSourceFixture,
  schemaDescriptorFixture,
  scriptedQueryable,
} from './fixtures.js';

const source = migrationSourceFixture(['000001']);
const appliedChecksum = source.manifest.migrations[0]?.sha256 as string;

/** A committed history row for the fixture's initial migration. */
const appliedRow = (
  overrides: Parameters<typeof historyRow>[0] = {},
): ReturnType<typeof historyRow> =>
  historyRow({ checksum_sha256: appliedChecksum, ...overrides });

const request = (
  overrides: Partial<MigrationRequest> = {},
): MigrationRequest => ({
  operation: 'validate',
  run_id: 'run-1',
  commit_sha: 'b'.repeat(40),
  expected_manifest_sha256: 'c'.repeat(64),
  ...overrides,
});

const fakeClock = (): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} => {
  let current = 0;

  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
};

const clockBudget = (
  clock: ReturnType<typeof fakeClock>,
  configuredMs = 300_000,
): OperationBudget =>
  createOperationBudget({
    now: clock.now,
    configuredMs,
    invocationRemainingMs: null,
    cleanupMarginMs: 0,
  });

const context = (
  overrides: Partial<MigrationSessionContext> = {},
): MigrationSessionContext => {
  const clock = fakeClock();

  return {
    schema: 'auth',
    migratorUser: 'auth_migrator',
    runtimeUser: 'auth_runtime',
    lockKey: '1129090495775515127',
    lockTimeoutMs: 1000,
    pollIntervalMs: 250,
    sleep: clock.sleep,
    budget: clockBudget(clock),
    ...overrides,
  };
};

const connectionFor = (
  rows: readonly (readonly Record<string, unknown>[])[],
): {
  scripted: ReturnType<typeof scriptedQueryable>;
  connection: MigrationConnection;
} => {
  const scripted = scriptedQueryable(rows);

  return {
    scripted,
    connection: {
      query: scripted.queryable.query,
      close: async () => undefined,
    },
  };
};

/** Advisory lock, then an existing table that passes every check. */
const healthyTable = (
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
];

/** Advisory lock, then a database with no history table yet. */
const missingTable = (): Record<string, unknown>[][] => [
  [{ locked: true }],
  [],
];

/** The five statements of the create-with-revokes transaction. */
const creationStatements = (): Record<string, unknown>[][] => [
  [],
  [],
  [],
  [],
  [],
];

/**
 * The structural introspection of an `auth` schema with no application
 * objects: five descriptor queries plus the unexpected-relation count.
 */
const emptyApplicationSchema = (): Record<string, unknown>[][] => [
  [],
  [],
  [],
  [],
  [],
  [],
];

/** One pending migration: BEGIN, reviewed SQL, history insert, COMMIT. */
const applyStatements = (id: string): Record<string, unknown>[][] => [
  [],
  [],
  [{ migration_id: id }],
  [],
];

const run = async (
  rows: readonly (readonly Record<string, unknown>[])[],
  requestOverrides: Partial<MigrationRequest> = {},
  contextOverrides: Partial<MigrationSessionContext> = {},
  migrationSource: MigrationSource = source,
) => {
  const { scripted, connection } = connectionFor(rows);
  const session = context(contextOverrides);
  const outcome = await runMigrationSession(
    budgetedConnection(connection, session.budget, {
      statementTimeoutMs: 120_000,
    }),
    request(requestOverrides),
    migrationSource,
    session,
  );

  return { outcome, scripted, session };
};

describe('runMigrationSession locking', () => {
  it('takes the session lock before touching history and releases it afterwards', async () => {
    const { outcome, scripted } = await run(healthyTable());

    expect(outcome.status).toBe('succeeded');
    expect(scripted.statements[0]).toContain('pg_try_advisory_lock');
    expect(scripted.parameters[0]).toEqual(['1129090495775515127']);
    expect(scripted.statements[1]).toContain('pg_class');
    expect(scripted.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('fails with lock_timeout without reading any history', async () => {
    const contended = Array.from({ length: 5 }, () => [{ locked: false }]);
    const { outcome, scripted } = await run(contended);

    expect(outcome).toEqual({
      status: 'failed',
      errorCode: 'lock_timeout',
      historySha256: null,
      appliedIds: [],
      pendingIds: [],
    });
    expect(scripted.statements).toHaveLength(5);
    expect(
      scripted.statements.every((s) => s.includes('pg_try_advisory_lock')),
    ).toBe(true);
  });

  it('releases the lock when verification fails', async () => {
    const { outcome, scripted } = await run([
      [{ locked: true }],
      [{ present: 1 }],
      historyStructureRows().slice(0, 3),
    ]);

    expect(outcome.errorCode).toBe('history_invalid');
    expect(scripted.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('releases the lock when a query throws', async () => {
    const { scripted, connection } = connectionFor([[{ locked: true }]]);
    const session = context();

    await expect(
      runMigrationSession(
        budgetedConnection(connection, session.budget, {
          statementTimeoutMs: 120_000,
        }),
        request(),
        source,
        session,
      ),
    ).rejects.toThrow('unexpected query');

    expect(scripted.statements.at(-1)).toContain('pg_advisory_unlock');
  });
});

describe('runMigrationSession operation budget', () => {
  it('fails with operation_timeout when the lock succeeds but later work exhausts the budget', async () => {
    let elapsed = 0;
    const clock = {
      now: () => {
        const value = elapsed;
        elapsed += 200;
        return value;
      },
    };
    const budget = createOperationBudget({
      now: clock.now,
      configuredMs: 1000,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });
    const statements: string[] = [];
    const connection: MigrationConnection = {
      query: async (text, values) => {
        void values;
        statements.push(text);

        return {
          rows: text.includes('pg_try_advisory_lock') ? [{ locked: true }] : [],
        };
      },
      close: async () => undefined,
    };

    const outcome = await runMigrationSession(
      budgetedConnection(connection, budget, { statementTimeoutMs: 120_000 }),
      request(),
      source,
      {
        schema: 'auth',
        migratorUser: 'auth_migrator',
        runtimeUser: 'auth_runtime',
        lockKey: '1129090495775515127',
        lockTimeoutMs: 1000,
        pollIntervalMs: 250,
        sleep: async () => undefined,
        budget,
      },
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'operation_timeout',
      historySha256: null,
    });
    expect(statements.some((s) => s.includes('pg_try_advisory_lock'))).toBe(
      true,
    );
    expect(statements.some((s) => s.includes('pg_class'))).toBe(false);
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
  });
});

describe('runMigrationSession history phase', () => {
  it('reports the verified state for validate without creating the table', async () => {
    const { outcome, scripted } = await run(missingTable());

    expect(outcome).toEqual({
      status: 'succeeded',
      errorCode: null,
      historySha256: historyDigest([]),
      appliedIds: [],
      pendingIds: ['000001'],
    });
    expect(scripted.statements.some((s) => s.includes('CREATE TABLE'))).toBe(
      false,
    );
  });

  it('reports applied and pending ids for validate', async () => {
    const { outcome } = await run(healthyTable([appliedRow()]));

    expect(outcome).toMatchObject({
      status: 'succeeded',
      appliedIds: ['000001'],
      pendingIds: [],
    });
  });

  it('creates, protects, applies, and records the initial migration', async () => {
    const { outcome, scripted } = await run(
      [
        ...missingTable(),
        ...emptyApplicationSchema(),
        ...creationStatements(),
        historyStructureRows(),
        historyConstraintRows(),
        historyModeProbeRows(),
        [{ owner: 'auth_migrator' }],
        [],
        [],
        [],
        ...applyStatements('000001'),
        [appliedRow()],
      ],
      { operation: 'apply' },
    );

    expect(outcome).toEqual({
      status: 'succeeded',
      errorCode: null,
      historySha256: historyDigest([appliedRow()]),
      appliedIds: ['000001'],
      pendingIds: [],
    });

    const statements = scripted.statements;
    const creation = statements.findIndex((statement) =>
      statement.includes('CREATE TABLE IF NOT EXISTS'),
    );
    const insert = statements.findIndex((statement) =>
      statement.includes('INSERT INTO'),
    );

    expect(statements[0]).toContain('pg_try_advisory_lock');
    expect(statements[1]).toContain('pg_class');
    expect(statements[creation - 1]).toBe('BEGIN');
    expect(statements[creation + 1]).toContain('FROM PUBLIC');
    expect(statements[creation + 2]).toContain('FROM "auth_runtime"');
    expect(statements[creation + 3]).toBe('COMMIT');
    expect(statements[creation + 4]).toContain('pg_attribute');
    expect(statements[creation + 5]).toContain('pg_constraint');
    expect(statements[creation + 6]).toContain('probe_value');
    expect(statements[creation + 7]).toContain('relowner');
    expect(statements[insert - 2]).toBe('BEGIN');
    expect(statements[insert - 1]).toContain("select '000001' as reviewed");
    expect(statements[insert + 1]).toBe('COMMIT');
    expect(statements.at(-2)).toContain('gootip_schema_migrations');
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
    expect(scripted.parameters[insert]).toEqual([
      '000001',
      appliedChecksum,
      'b'.repeat(40),
      'run-1',
      'applied',
      null,
      null,
    ]);
  });

  it('reports no_changes when the manifest is already applied', async () => {
    const { outcome, scripted } = await run(healthyTable([appliedRow()]), {
      operation: 'apply',
    });

    expect(outcome).toEqual({
      status: 'no_changes',
      errorCode: null,
      historySha256: historyDigest([appliedRow()]),
      appliedIds: ['000001'],
      pendingIds: [],
    });
    expect(scripted.statements.some((statement) => statement === 'BEGIN')).toBe(
      false,
    );
  });

  it('never creates the history table for a baseline operation', async () => {
    const sourceWithObjects = migrationSourceFixture(
      ['000001'],
      undefined,
      schemaDescriptorFixture(),
    );
    const check = await run(
      [...missingTable(), ...emptyApplicationSchema()],
      { operation: 'baseline_check' },
      {},
      sourceWithObjects,
    );
    const adopt = await run(
      [...missingTable(), ...emptyApplicationSchema()],
      {
        operation: 'baseline_adopt',
        approval_reference: 'OPS-42',
        expected_schema_fingerprint: fingerprintDescriptor(
          schemaDescriptorFixture(),
        ),
        expected_history_sha256: historyDigest([]),
      },
      {},
      sourceWithObjects,
    );

    expect(check.outcome).toMatchObject({
      status: 'failed',
      errorCode: 'baseline_mismatch',
    });
    expect(adopt.outcome).toMatchObject({
      status: 'failed',
      errorCode: 'baseline_mismatch',
    });
    expect(
      check.scripted.statements.some((s) => s.includes('CREATE TABLE')),
    ).toBe(false);
    expect(
      adopt.scripted.statements.some((s) => s.includes('CREATE TABLE')),
    ).toBe(false);
  });

  it('rejects a history table that does not match the reviewed structure', async () => {
    const { outcome } = await run([
      [{ locked: true }],
      [{ present: 1 }],
      historyStructureRows().map((row) =>
        row.name === 'applied_at' ? { ...row, not_null: false } : row,
      ),
      historyConstraintRows(),
    ]);

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'history_invalid',
    });
  });

  it('rejects a history table the runtime role can still modify', async () => {
    const { outcome } = await run([
      [{ locked: true }],
      [{ present: 1 }],
      historyStructureRows(),
      historyConstraintRows(),
      historyModeProbeRows(),
      [{ owner: 'auth_migrator' }],
      [],
      [{ privilege: 'DELETE', allowed: true }],
    ]);

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'privilege_mismatch',
    });
  });

  it('rejects a changed checksum before applying anything', async () => {
    const { outcome } = await run(
      healthyTable([historyRow({ checksum_sha256: 'e'.repeat(64) })]),
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'history_invalid',
    });
  });

  it('rejects a malformed history row', async () => {
    const { outcome } = await run(
      healthyTable([historyRow({ application_mode: 'baseline_verified' })]),
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'history_invalid',
    });
  });

  it('rejects a live database that has run ahead of the manifest', async () => {
    const { outcome } = await run(
      healthyTable([
        historyRow({ migration_id: '000001' }),
        historyRow({ migration_id: '000002' }),
      ]),
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'history_invalid',
    });
  });

  it('compares the deterministic digest when validate supplies one', async () => {
    const matching = await run(healthyTable([appliedRow()]), {
      expected_history_sha256: historyDigest([appliedRow()]),
    });
    const mismatched = await run(healthyTable([appliedRow()]), {
      expected_history_sha256: 'f'.repeat(64),
    });

    expect(matching.outcome).toMatchObject({
      status: 'succeeded',
      appliedIds: ['000001'],
    });
    expect(mismatched.outcome).toMatchObject({
      status: 'failed',
      errorCode: 'history_invalid',
      historySha256: historyDigest([appliedRow()]),
    });
  });
});

describe('runMigrationSession apply phase', () => {
  it('applies every pending migration in manifest order, one transaction each', async () => {
    const two = migrationSourceFixture(['000001', '000002']);
    const secondChecksum = two.manifest.migrations[1]?.sha256 as string;
    const finalRows: ReturnType<typeof appliedRow>[] = [
      appliedRow(),
      historyRow({
        migration_id: '000002',
        checksum_sha256: secondChecksum,
      }),
    ];
    const { outcome, scripted } = await run(
      [
        ...healthyTable(),
        ...emptyApplicationSchema(),
        ...applyStatements('000001'),
        ...applyStatements('000002'),
        finalRows,
      ],
      { operation: 'apply' },
      {},
      two,
    );

    expect(outcome).toEqual({
      status: 'succeeded',
      errorCode: null,
      historySha256: historyDigest(finalRows),
      appliedIds: ['000001', '000002'],
      pendingIds: [],
    });

    const transactions = scripted.statements.filter(
      (statement) => statement === 'BEGIN' || statement === 'COMMIT',
    );

    expect(transactions).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
    expect(
      scripted.statements.indexOf(fixtureMigrationSql('000001')),
    ).toBeLessThan(scripted.statements.indexOf(fixtureMigrationSql('000002')));
  });

  it('rolls back a failed migration, keeps earlier commits, and records no failed row', async () => {
    const two = migrationSourceFixture(['000001', '000002']);
    const { scripted } = connectionFor([
      ...healthyTable(),
      ...emptyApplicationSchema(),
      ...applyStatements('000001'),
      [],
      [],
      [appliedRow()],
    ]);
    const session = context();
    const failing: MigrationConnection = {
      query: async (text, values) => {
        if (text.includes("select '000002' as reviewed")) {
          throw new Error('syntax error at or near "created"');
        }

        return scripted.queryable.query(text, values);
      },
      close: async () => undefined,
    };

    const outcome = await runMigrationSession(
      budgetedConnection(failing, session.budget, {
        statementTimeoutMs: 120_000,
      }),
      request({ operation: 'apply' }),
      two,
      session,
    );

    expect(outcome).toEqual({
      status: 'failed',
      errorCode: 'sql_failed',
      historySha256: historyDigest([appliedRow()]),
      appliedIds: ['000001'],
      pendingIds: ['000002'],
    });
    expect(scripted.statements.at(-3)).toBe('ROLLBACK');
    expect(scripted.statements.at(-2)).toContain('gootip_schema_migrations');
    expect(scripted.statements.at(-1)).toContain('pg_advisory_unlock');
    expect(
      scripted.statements.filter((statement) =>
        statement.includes('INSERT INTO'),
      ),
    ).toHaveLength(1);
  });

  it('rejects transaction control before starting any transaction', async () => {
    const sqlText = 'create table auth.unexpected (id int);\ncommit;\n';
    const violatingBase = migrationSourceFixture(
      ['000001'],
      [sha256Hex(sqlText)],
    );
    const violating: MigrationSource = {
      manifest: violatingBase.manifest,
      sql: new Map([
        [violatingBase.manifest.migrations[0]?.file as string, sqlText],
      ]),
    };

    const { outcome, scripted } = await run(
      [...healthyTable(), ...emptyApplicationSchema()],
      { operation: 'apply' },
      {},
      violating,
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'sql_policy_violation',
      appliedIds: [],
      pendingIds: ['000001'],
    });
    expect(scripted.statements).not.toContain('BEGIN');
  });

  it('rejects SQL bytes that no longer match the manifest', async () => {
    const tamperedBase = migrationSourceFixture(['000001']);
    const tampered: MigrationSource = {
      manifest: tamperedBase.manifest,
      sql: new Map([
        [
          tamperedBase.manifest.migrations[0]?.file as string,
          'create table auth.unexpected (id int);\n',
        ],
      ]),
    };

    const { outcome, scripted } = await run(
      [...healthyTable(), ...emptyApplicationSchema()],
      { operation: 'apply' },
      {},
      tampered,
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'manifest_mismatch',
      appliedIds: [],
      pendingIds: ['000001'],
    });
    expect(scripted.statements).not.toContain('BEGIN');
  });

  it('never reports success when the final history does not match the manifest', async () => {
    const { outcome } = await run(
      [
        ...healthyTable(),
        ...emptyApplicationSchema(),
        ...applyStatements('000001'),
        [],
      ],
      { operation: 'apply' },
    );

    expect(outcome).toEqual({
      status: 'failed',
      errorCode: 'verification_failed',
      historySha256: historyDigest([]),
      appliedIds: ['000001'],
      pendingIds: [],
    });
  });
});

describe('runMigrationSession baseline phase', () => {
  const descriptor = schemaDescriptorFixture();
  const fingerprint = fingerprintDescriptor(descriptor);
  const baselineSource = migrationSourceFixture(
    ['000001'],
    undefined,
    descriptor,
  );
  const liveSchema = (): Record<string, unknown>[][] => [
    ...descriptorRows(descriptor),
    [],
  ];
  const baselineRow = (): ReturnType<typeof historyRow> =>
    historyRow({
      checksum_sha256: appliedChecksum,
      application_mode: 'baseline_verified',
      approval_reference: 'OPS-42',
      schema_fingerprint: fingerprint,
    });

  it('requires baseline approval instead of applying over existing objects', async () => {
    const { outcome, scripted } = await run(
      [...missingTable(), ...liveSchema()],
      { operation: 'apply' },
      {},
      baselineSource,
    );

    expect(outcome).toEqual({
      status: 'baseline_approval_required',
      errorCode: null,
      historySha256: historyDigest([]),
      appliedIds: [],
      pendingIds: ['000001'],
    });
    expect(
      scripted.statements.some((statement) =>
        statement.includes('CREATE TABLE'),
      ),
    ).toBe(false);
    expect(scripted.statements).not.toContain('BEGIN');
  });

  it('requires baseline approval for an empty history table beside existing objects', async () => {
    const { outcome, scripted } = await run(
      [...healthyTable(), ...liveSchema()],
      { operation: 'apply' },
      {},
      baselineSource,
    );

    expect(outcome.status).toBe('baseline_approval_required');
    expect(scripted.statements).not.toContain('BEGIN');
  });

  it('reports a matching structure without adopting it', async () => {
    const { outcome, scripted } = await run(
      [...healthyTable(), ...liveSchema()],
      { operation: 'baseline_check' },
      {},
      baselineSource,
    );

    expect(outcome).toEqual({
      status: 'succeeded',
      errorCode: null,
      historySha256: historyDigest([]),
      appliedIds: [],
      pendingIds: ['000001'],
    });
    expect(scripted.statements).not.toContain('BEGIN');
  });

  it('blocks a differing structure and reports bounded differences', async () => {
    const reports: { reason: string; status: string }[] = [];
    const rows = descriptorRows(descriptor);

    rows[1] = [
      ...(rows[1] as Record<string, unknown>[]),
      {
        table_name: 'user',
        name: 'legacy',
        data_type: 'text',
        not_null: false,
        default_expr: null,
      },
    ];

    const { outcome } = await run(
      [...healthyTable(), ...rows, []],
      { operation: 'baseline_check' },
      { report: (report) => reports.push(report) },
      baselineSource,
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'baseline_mismatch',
      appliedIds: [],
      pendingIds: ['000001'],
    });
    expect(reports.at(-1)).toMatchObject({
      status: 'failed',
      reason: 'baseline mismatch: column=1',
    });
  });

  it('refuses to check or adopt a database with applied history', async () => {
    const history = historyDigest([baselineRow()]);
    const check = await run(
      healthyTable([baselineRow()]),
      { operation: 'baseline_check' },
      {},
      baselineSource,
    );
    const adopt = await run(
      healthyTable([baselineRow()]),
      {
        operation: 'baseline_adopt',
        approval_reference: 'OPS-42',
        expected_schema_fingerprint: fingerprint,
        expected_history_sha256: history,
      },
      {},
      baselineSource,
    );

    expect(check.outcome).toMatchObject({
      status: 'failed',
      errorCode: 'history_invalid',
      appliedIds: ['000001'],
    });
    expect(adopt.outcome).toMatchObject({
      status: 'failed',
      errorCode: 'history_invalid',
      appliedIds: ['000001'],
    });
    expect(adopt.scripted.statements).not.toContain('BEGIN');
  });

  it('records the verified baseline in one transaction without creating tables again', async () => {
    const { outcome, scripted } = await run(
      [
        ...missingTable(),
        ...liveSchema(),
        ...creationStatements(),
        [],
        [{ migration_id: '000001' }],
        [],
        [baselineRow()],
      ],
      {
        operation: 'baseline_adopt',
        approval_reference: 'OPS-42',
        expected_schema_fingerprint: fingerprint,
        expected_history_sha256: historyDigest([]),
      },
      {},
      baselineSource,
    );

    expect(outcome).toEqual({
      status: 'succeeded',
      errorCode: null,
      historySha256: historyDigest([baselineRow()]),
      appliedIds: ['000001'],
      pendingIds: [],
    });

    const statements = scripted.statements;
    const insert = statements.findIndex((statement) =>
      statement.includes('INSERT INTO'),
    );

    expect(statements.slice(insert - 1, insert + 2)).toEqual([
      'BEGIN',
      statements[insert] as string,
      'COMMIT',
    ]);
    expect(scripted.parameters[insert]).toEqual([
      '000001',
      appliedChecksum,
      'b'.repeat(40),
      'run-1',
      'baseline_verified',
      'OPS-42',
      fingerprint,
    ]);
    expect(
      statements.some((statement) =>
        statement.includes('CREATE TABLE IF NOT EXISTS'),
      ),
    ).toBe(true);
    expect(statements.join('\n')).not.toContain("select '000001' as reviewed");
  });

  it('rejects a structure that changed after review without adopting it', async () => {
    const rows = descriptorRows(descriptor);

    rows[1] = [
      ...(rows[1] as Record<string, unknown>[]),
      {
        table_name: 'user',
        name: 'added_after_review',
        data_type: 'text',
        not_null: false,
        default_expr: null,
      },
    ];

    const { outcome, scripted } = await run(
      [...missingTable(), ...rows, []],
      {
        operation: 'baseline_adopt',
        approval_reference: 'OPS-42',
        expected_schema_fingerprint: fingerprint,
        expected_history_sha256: historyDigest([]),
      },
      {},
      baselineSource,
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'baseline_mismatch',
      appliedIds: [],
      pendingIds: ['000001'],
    });
    expect(
      scripted.statements.some((statement) =>
        statement.includes('CREATE TABLE'),
      ),
    ).toBe(false);
    expect(scripted.statements).not.toContain('BEGIN');
  });

  it('rejects a fingerprint that is not the reviewed initial structure', async () => {
    const { outcome, scripted } = await run(
      missingTable(),
      {
        operation: 'baseline_adopt',
        approval_reference: 'OPS-42',
        expected_schema_fingerprint: 'e'.repeat(64),
        expected_history_sha256: historyDigest([]),
      },
      {},
      baselineSource,
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'baseline_mismatch',
    });
    expect(
      scripted.statements.some((statement) =>
        statement.includes('pg_attribute'),
      ),
    ).toBe(false);
  });
});
