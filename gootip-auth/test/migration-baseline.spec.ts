import { describe, expect, it } from 'vitest';

import {
  checkBaselineEquivalence,
  detectApplicationObjects,
} from '../src/migration-runner/baseline.js';
import {
  compareSchemaDescriptors,
  formatSchemaDifferences,
} from '../src/migration-runner/schema-comparison.js';
import {
  describeSchema,
  fingerprintDescriptor,
  type SchemaDescriptor,
} from '../src/migration-runner/schema-descriptor.js';
import {
  descriptorRows,
  schemaDescriptorFixture,
  scriptedQueryable,
} from './fixtures.js';

const describeLive = async (
  descriptor: SchemaDescriptor,
  unexpectedRelations = 0,
) => {
  const { queryable } = scriptedQueryable([
    ...descriptorRows(descriptor),
    [{ count: unexpectedRelations }],
  ]);

  return queryable;
};

describe('schema comparison', () => {
  const expected = schemaDescriptorFixture();

  it('reports nothing when the structures are identical', () => {
    expect(compareSchemaDescriptors(expected, expected)).toEqual([]);
  });

  it('reports added, removed, and changed objects by bounded category', () => {
    const live: SchemaDescriptor = {
      schema: 'auth',
      tables: [
        {
          ...expected.tables[0]!,
          columns: [
            ...expected.tables[0]!.columns,
            { name: 'legacy', dataType: 'text', nullable: true, default: null },
          ],
          indexes: expected.tables[0]!.indexes.map((index) => ({
            ...index,
            valid: false,
          })),
        },
      ],
      sequences: [],
    };

    expect(compareSchemaDescriptors(expected, live)).toEqual([
      { kind: 'column', count: 1 },
      { kind: 'invalid_index', count: 1 },
      { kind: 'sequence', count: 1 },
    ]);

    expect(
      compareSchemaDescriptors(expected, {
        schema: 'auth',
        tables: [],
        sequences: [],
      }),
    ).toEqual([
      { kind: 'missing_table', count: 1 },
      { kind: 'sequence', count: 1 },
    ]);
    expect(
      compareSchemaDescriptors(
        { schema: 'auth', tables: [], sequences: [] },
        expected,
      ),
    ).toEqual([
      { kind: 'sequence', count: 1 },
      { kind: 'unexpected_table', count: 1 },
    ]);
  });

  it('formats differences without object names or SQL', () => {
    expect(
      formatSchemaDifferences([
        { kind: 'column', count: 2 },
        { kind: 'unexpected_table', count: 1 },
      ]),
    ).toBe('baseline mismatch: column=2, unexpected_table=1');
    expect(formatSchemaDifferences([])).toBe(
      'baseline mismatch: structure fingerprint differs',
    );
  });
});

describe('baseline equivalence', () => {
  const expected = schemaDescriptorFixture();
  const fingerprint = fingerprintDescriptor(expected);

  it('round-trips a descriptor through the introspection queries', async () => {
    const live = await describeSchema(await describeLive(expected), 'auth');

    expect(live).toEqual(expected);
    expect(fingerprintDescriptor(live)).toBe(fingerprint);
  });

  it('accepts an exact structural match', async () => {
    const equivalence = await checkBaselineEquivalence(
      await describeLive(expected),
      'auth',
      expected,
      fingerprint,
    );

    expect(equivalence).toEqual({
      ok: true,
      fingerprint,
      differences: [],
    });
  });

  it('rejects a structure whose fingerprint differs', async () => {
    const differing: SchemaDescriptor = {
      ...expected,
      tables: [
        {
          ...expected.tables[0]!,
          columns: expected.tables[0]!.columns.map((column) =>
            column.name === 'email' ? { ...column, nullable: true } : column,
          ),
        },
      ],
    };
    const equivalence = await checkBaselineEquivalence(
      await describeLive(differing),
      'auth',
      expected,
      fingerprint,
    );

    expect(equivalence.ok).toBe(false);
    expect(equivalence.fingerprint).not.toBe(fingerprint);
    expect(equivalence.differences).toEqual([{ kind: 'column', count: 1 }]);
  });

  it('rejects unmodelled relations even when the tables match', async () => {
    const equivalence = await checkBaselineEquivalence(
      await describeLive(expected, 2),
      'auth',
      expected,
      fingerprint,
    );

    expect(equivalence.ok).toBe(false);
    expect(equivalence.differences).toEqual([
      { kind: 'unexpected_relation', count: 2 },
    ]);
  });
});

describe('application object detection', () => {
  it('treats an empty auth schema as having no application objects', async () => {
    const { queryable } = scriptedQueryable([
      [],
      [],
      [],
      [],
      [],
      [{ count: 0 }],
    ]);

    await expect(detectApplicationObjects(queryable, 'auth')).resolves.toEqual({
      present: false,
      unexpectedRelations: 0,
    });
  });

  it('detects tables, sequences, and unmodelled relations', async () => {
    const expected = schemaDescriptorFixture();
    const withTables = scriptedQueryable([
      ...descriptorRows(expected),
      [{ count: 0 }],
    ]);
    const withRelation = scriptedQueryable([
      [],
      [],
      [],
      [],
      [],
      [{ count: 1 }],
    ]);

    await expect(
      detectApplicationObjects(withTables.queryable, 'auth'),
    ).resolves.toMatchObject({ present: true });
    await expect(
      detectApplicationObjects(withRelation.queryable, 'auth'),
    ).resolves.toMatchObject({ present: true, unexpectedRelations: 1 });
  });
});
