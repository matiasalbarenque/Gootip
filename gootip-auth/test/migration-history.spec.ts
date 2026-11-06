import { describe, expect, it } from 'vitest';

import {
  HISTORY_COLUMNS,
  createHistoryTable,
  historyDigest,
  historyMatchesExpected,
  historyTableDdl,
  historyTableExists,
  historyTableName,
  readHistory,
  validateHistoryTableStructure,
  verifyHistory,
  verifyHistoryProtection,
  type HistoryRow,
} from '../src/migration-runner/history.js';
import {
  historyConstraintRows as constraintRows,
  historyModeProbeRows,
  historyPermissiveModeProbeRows,
  historyRow,
  historyStructureRows as structureRows,
  manifestFixture as manifest,
  scriptedQueryable,
} from './fixtures.js';

describe('history table contract', () => {
  it('creates the internal table in the reviewed schema and revokes every other role', () => {
    const statements = historyTableDdl('auth', 'auth_runtime');

    expect(historyTableName('auth')).toBe('"auth"."gootip_schema_migrations"');
    expect(statements[0]).toContain(
      'CREATE TABLE IF NOT EXISTS "auth"."gootip_schema_migrations"',
    );
    expect(statements[0]).toContain('"checksum_sha256" char(64) NOT NULL');
    expect(statements[0]).toContain(
      `CHECK ("application_mode" IN ('applied', 'baseline_verified'))`,
    );
    expect(statements[1]).toContain('REVOKE ALL ON TABLE');
    expect(statements[1]).toContain('FROM PUBLIC');
    expect(statements[2]).toBe(
      'REVOKE ALL ON TABLE "auth"."gootip_schema_migrations" FROM "auth_runtime"',
    );
  });

  it('creates the table and applies both revokes in one transaction', async () => {
    const scripted = scriptedQueryable([[], [], [], [], [], []]);

    await createHistoryTable(scripted.queryable, 'auth', 'auth_runtime');

    expect(scripted.statements).toHaveLength(5);
    expect(scripted.statements[0]).toBe('BEGIN');
    expect(scripted.statements[1]).toContain('CREATE TABLE IF NOT EXISTS');
    expect(scripted.statements[2]).toContain('FROM PUBLIC');
    expect(scripted.statements[3]).toContain('FROM "auth_runtime"');
    expect(scripted.statements[4]).toBe('COMMIT');
    expect(scripted.statements[5]).toBeUndefined();
  });

  it('rolls the transaction back when a revoke fails', async () => {
    const scripted = scriptedQueryable([[], [], []]);

    await expect(
      createHistoryTable(scripted.queryable, 'auth', 'auth_runtime'),
    ).rejects.toThrow('unexpected query');

    expect(scripted.statements).toContain('ROLLBACK');
    expect(scripted.statements).not.toContain('COMMIT');
  });

  it('exposes the reviewed history columns', () => {
    expect(HISTORY_COLUMNS).toEqual([
      'migration_id',
      'checksum_sha256',
      'applied_at',
      'commit_sha',
      'run_id',
      'application_mode',
      'approval_reference',
      'schema_fingerprint',
    ]);
  });
});

describe('historyTableExists', () => {
  it('reports presence and absence', async () => {
    expect(
      await historyTableExists(
        scriptedQueryable([[{ present: 1 }]]).queryable,
        'auth',
      ),
    ).toBe(true);
    expect(
      await historyTableExists(scriptedQueryable([[]]).queryable, 'auth'),
    ).toBe(false);
  });
});

describe('validateHistoryTableStructure', () => {
  const validate = (rows: readonly (readonly Record<string, unknown>[])[]) =>
    validateHistoryTableStructure(scriptedQueryable(rows).queryable, 'auth');

  it('accepts the reviewed eight-column shape', async () => {
    expect(
      await validate([
        structureRows(),
        constraintRows(),
        historyModeProbeRows(),
      ]),
    ).toEqual({
      ok: true,
    });
  });

  it('rejects a missing or extra column', async () => {
    expect(await validate([[], []])).toMatchObject({
      ok: false,
      reason: 'the history table does not exist',
    });

    expect(
      await validate([structureRows().slice(0, 7), constraintRows()]),
    ).toMatchObject({
      ok: false,
      reason: 'the history table does not have the reviewed columns',
    });

    expect(
      await validate([
        [
          ...structureRows(),
          {
            name: 'extra',
            data_type: 'text',
            not_null: false,
            default_expr: null,
          },
        ],
        constraintRows(),
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'the history table does not have the reviewed columns',
    });
  });

  it('rejects a changed type, nullability, or default', async () => {
    const wrongType = structureRows().map((row) =>
      row.name === 'checksum_sha256' ? { ...row, data_type: 'text' } : row,
    );
    const wrongNullable = structureRows().map((row) =>
      row.name === 'approval_reference' ? { ...row, not_null: true } : row,
    );
    const wrongDefault = structureRows().map((row) =>
      row.name === 'applied_at' ? { ...row, default_expr: null } : row,
    );

    for (const [rows, reason] of [
      [wrongType, 'the history column checksum_sha256 has an unexpected type'],
      [
        wrongNullable,
        'the history column approval_reference has unexpected nullability',
      ],
      [wrongDefault, 'the history column applied_at has an unexpected default'],
    ] as const) {
      expect(await validate([rows, constraintRows()])).toMatchObject({
        ok: false,
        reason,
      });
    }
  });

  it('rejects a missing primary key or application_mode check', async () => {
    const noPrimaryKey = constraintRows().filter((row) => row.kind !== 'p');
    const wrongPrimaryKey = [
      {
        ...(constraintRows()[0] as Record<string, unknown>),
        columns: ['checksum_sha256'],
      },
      constraintRows()[1] as Record<string, unknown>,
    ];
    const noCheck = constraintRows().filter((row) => row.kind !== 'c');

    expect(await validate([structureRows(), noPrimaryKey])).toMatchObject({
      ok: false,
      reason: 'the history table primary key is not migration_id',
    });
    expect(await validate([structureRows(), wrongPrimaryKey])).toMatchObject({
      ok: false,
      reason: 'the history table primary key is not migration_id',
    });
    expect(await validate([structureRows(), noCheck])).toMatchObject({
      ok: false,
      reason: 'the history table application_mode check is missing',
    });
  });

  it('rejects a permissive check that merely mentions both modes', async () => {
    const permissive = constraintRows().map((row) =>
      row.kind === 'c'
        ? {
            ...row,
            definition:
              "CHECK ((application_mode = ANY (ARRAY['applied'::text, 'baseline_verified'::text])) OR true)",
            expression:
              "(application_mode = ANY (ARRAY['applied'::text, 'baseline_verified'::text])) OR true",
          }
        : row,
    );

    expect(
      await validate([
        structureRows(),
        permissive,
        historyPermissiveModeProbeRows(),
      ]),
    ).toMatchObject({
      ok: false,
      reason:
        'the history table application_mode check does not match the reviewed values',
    });
  });

  it('rejects a check whose expression cannot be probed safely', async () => {
    const unprobeable = constraintRows().map((row) =>
      row.kind === 'c'
        ? {
            ...row,
            expression: "(application_mode = 'applied'); DROP TABLE auth.x",
          }
        : row,
    );

    expect(await validate([structureRows(), unprobeable])).toMatchObject({
      ok: false,
      reason: 'the history table application_mode check could not be validated',
    });
  });
});

describe('readHistory', () => {
  it('reads ordered rows and normalizes nullable columns', async () => {
    const scripted = scriptedQueryable([
      [
        {
          migration_id: '000001',
          checksum_sha256: 'a'.repeat(64),
          applied_at: '2026-01-01T00:00:00.000000Z',
          commit_sha: 'b'.repeat(40),
          run_id: 'run-1',
          application_mode: 'applied',
          approval_reference: null,
          schema_fingerprint: null,
        },
      ],
    ]);

    const rows = await readHistory(scripted.queryable, 'auth');

    expect(scripted.statements[0]).toContain('ORDER BY "migration_id"');
    expect(scripted.statements[0]).toContain("AT TIME ZONE 'UTC'");
    expect(rows).toEqual([historyRow()]);
  });

  it('reports an empty history without inventing rows', async () => {
    expect(
      await readHistory(scriptedQueryable([[]]).queryable, 'auth'),
    ).toEqual([]);
  });
});

describe('historyDigest', () => {
  it('is stable and sensitive to any change', () => {
    expect(historyDigest([historyRow()])).toBe(historyDigest([historyRow()]));
    expect(historyDigest([])).toMatch(/^[0-9a-f]{64}$/);
    expect(historyDigest([historyRow()])).not.toBe(historyDigest([]));
    expect(historyDigest([historyRow()])).not.toBe(
      historyDigest([historyRow({ run_id: 'run-2' })]),
    );
    expect(historyDigest([historyRow()])).not.toBe(
      historyDigest([historyRow({ approval_reference: 'GH-1' })]),
    );
  });

  it('does not depend on object key insertion order', () => {
    const reordered = {
      schema_fingerprint: null,
      approval_reference: null,
      application_mode: 'applied',
      run_id: 'run-1',
      commit_sha: 'b'.repeat(40),
      applied_at: '2026-01-01T00:00:00.000000Z',
      checksum_sha256: 'a'.repeat(64),
      migration_id: '000001',
    } as HistoryRow;

    expect(historyDigest([reordered])).toBe(historyDigest([historyRow()]));
  });

  it('compares against an expected activation digest', () => {
    const rows = [historyRow()];

    expect(historyMatchesExpected(rows, historyDigest(rows))).toBe(true);
    expect(historyMatchesExpected(rows, 'f'.repeat(64))).toBe(false);
  });
});

describe('verifyHistory', () => {
  it('accepts empty history and reports every migration as pending', () => {
    expect(verifyHistory([], manifest(['000001']))).toEqual({
      ok: true,
      appliedIds: [],
      pendingIds: ['000001'],
    });
  });

  it('accepts an exact prefix', () => {
    expect(
      verifyHistory(
        [historyRow({ migration_id: '000001' })],
        manifest(['000001', '000002']),
      ),
    ).toEqual({ ok: true, appliedIds: ['000001'], pendingIds: ['000002'] });
  });

  it('accepts an adopted baseline row', () => {
    expect(
      verifyHistory(
        [
          historyRow({
            application_mode: 'baseline_verified',
            approval_reference: 'GH-482',
            schema_fingerprint: 'e'.repeat(64),
          }),
        ],
        manifest(['000001']),
      ),
    ).toMatchObject({ ok: true });
  });

  it('rejects an unknown applied migration', () => {
    expect(
      verifyHistory(
        [historyRow({ migration_id: '000009' })],
        manifest(['000001']),
      ),
    ).toMatchObject({ ok: false });
  });

  it('rejects a changed checksum', () => {
    expect(
      verifyHistory(
        [
          historyRow({
            migration_id: '000001',
            checksum_sha256: 'e'.repeat(64),
          }),
        ],
        manifest(['000001']),
      ),
    ).toMatchObject({
      ok: false,
      reason: 'an applied migration checksum changed',
    });
  });

  it('rejects a gap or reordering against the manifest', () => {
    expect(
      verifyHistory(
        [
          historyRow({ migration_id: '000001' }),
          historyRow({ migration_id: '000003' }),
        ],
        manifest(['000001', '000002', '000003']),
      ),
    ).toMatchObject({
      ok: false,
      reason: 'history is not a prefix of the manifest',
    });

    expect(
      verifyHistory(
        [
          historyRow({ migration_id: '000002' }),
          historyRow({ migration_id: '000001' }),
        ],
        manifest(['000001', '000002']),
      ),
    ).toMatchObject({
      ok: false,
      reason: 'history is not in manifest order',
    });
  });

  it('rejects duplicate rows and malformed rows', () => {
    expect(
      verifyHistory(
        [
          historyRow({ migration_id: '000001' }),
          historyRow({ migration_id: '000001' }),
        ],
        manifest(['000001']),
      ),
    ).toMatchObject({
      ok: false,
      reason: 'history contains a duplicate entry',
    });

    for (const row of [
      historyRow({ application_mode: 'something_else' }),
      historyRow({ checksum_sha256: 'not-a-checksum' }),
      historyRow({ commit_sha: 'short' }),
      historyRow({ run_id: '' }),
      historyRow({ migration_id: '1' }),
      historyRow({ applied_at: '' }),
    ]) {
      expect(verifyHistory([row], manifest(['000001']))).toMatchObject({
        ok: false,
        reason: 'history contains a malformed row',
      });
    }
  });

  it('rejects an adopted baseline row without approval evidence', () => {
    for (const row of [
      historyRow({ application_mode: 'baseline_verified' }),
      historyRow({
        application_mode: 'baseline_verified',
        approval_reference: 'not a reference',
        schema_fingerprint: 'e'.repeat(64),
      }),
      historyRow({
        application_mode: 'baseline_verified',
        approval_reference: 'GH-482',
      }),
      historyRow({
        application_mode: 'baseline_verified',
        approval_reference: 'GH-482',
        schema_fingerprint: 'nope',
      }),
    ]) {
      expect(verifyHistory([row], manifest(['000001']))).toMatchObject({
        ok: false,
        reason: 'history contains a malformed row',
      });
    }
  });

  it('rejects a manifest that is behind the live database', () => {
    expect(
      verifyHistory(
        [
          historyRow({ migration_id: '000001' }),
          historyRow({ migration_id: '000002' }),
        ],
        manifest(['000001']),
      ),
    ).toMatchObject({
      ok: false,
      reason: 'the manifest is behind the live database',
    });
  });
});

describe('verifyHistoryProtection', () => {
  const protection = (rows: readonly (readonly Record<string, unknown>[])[]) =>
    verifyHistoryProtection(
      scriptedQueryable(rows).queryable,
      'auth',
      'auth_migrator',
      'auth_runtime',
    );

  it('accepts a migrator-owned table with no other grants or effective privileges', async () => {
    expect(
      await protection([
        [{ owner: 'auth_migrator' }],
        [{ grantee: 'auth_migrator', privilege: 'INSERT' }],
        [
          { privilege: 'INSERT', allowed: false },
          { privilege: 'DELETE', allowed: false },
        ],
        [],
      ]),
    ).toEqual({ ok: true });
  });

  it('rejects a missing table or a different owner', async () => {
    expect(await protection([[]])).toMatchObject({
      ok: false,
      reason: 'the history table does not exist',
    });

    expect(await protection([[{ owner: 'auth_runtime' }]])).toMatchObject({
      ok: false,
      reason: 'the history table is not owned by the migrator',
    });
  });

  it('rejects raw modification privileges held by the runtime role or PUBLIC', async () => {
    for (const grantee of ['auth_runtime', 'PUBLIC']) {
      expect(
        await protection([
          [{ owner: 'auth_migrator' }],
          [{ grantee, privilege: 'DELETE' }],
        ]),
      ).toMatchObject({
        ok: false,
        reason: `the history table grants DELETE to ${grantee}`,
      });
    }
  });

  it('rejects effective modification privileges even when the raw ACL looks clean', async () => {
    expect(
      await protection([
        [{ owner: 'auth_migrator' }],
        [],
        [{ privilege: 'UPDATE', allowed: true }],
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'auth_runtime can UPDATE the history table',
    });

    expect(
      await protection([
        [{ owner: 'auth_migrator' }],
        [],
        [
          { privilege: 'INSERT', allowed: false },
          { privilege: 'TRUNCATE', allowed: true },
        ],
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'auth_runtime can TRUNCATE the history table',
    });
  });
});
