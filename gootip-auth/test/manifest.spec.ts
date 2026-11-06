import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256Hex } from '../src/migration-runner/digest.js';
import {
  validateManifest,
  validateMigrationFileNames,
  type MigrationFileDigest,
} from '../src/migration-runner/manifest.js';
import {
  describeSchema,
  fingerprintDescriptor,
  isSchemaDescriptor,
  type Queryable,
  type SchemaDescriptor,
} from '../src/migration-runner/schema-descriptor.js';

const descriptor: SchemaDescriptor = {
  schema: 'auth',
  tables: [
    {
      name: 'user',
      columns: [
        { name: 'id', dataType: 'text', nullable: false, default: null },
      ],
      constraints: [],
      indexes: [],
    },
  ],
  sequences: [],
};

const sqlFile = '000001-initial-auth.sql';

const buildManifest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  manifest_version: 1,
  service: 'auth',
  schema: 'auth',
  commit_sha: 'a'.repeat(40),
  better_auth_version: '1.7.7',
  generator_version: '1.7.7',
  configuration_sha256: 'b'.repeat(64),
  migrations: [{ id: '000001', file: sqlFile, sha256: 'c'.repeat(64) }],
  initial_schema_fingerprint: sha256Hex(canonicalJson(descriptor)),
  initial_schema: descriptor,
  ...overrides,
});

const fakeQueryable = (
  rowsByQuery: Partial<Record<string, Record<string, unknown>[]>>,
): Queryable => ({
  query: async (text) => {
    const key = text.includes('pg_sequences')
      ? 'sequences'
      : text.includes('FROM pg_constraint con')
        ? 'constraints'
        : text.includes('FROM pg_index i')
          ? 'indexes'
          : text.includes('FROM pg_attribute a')
            ? 'columns'
            : 'tables';

    return { rows: rowsByQuery[key] ?? [] };
  },
});

describe('digest', () => {
  it('sorts object keys before hashing', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('produces a stable sha256 hex digest', () => {
    expect(sha256Hex('gootip')).toBe(sha256Hex('gootip'));
    expect(sha256Hex('gootip')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('validateMigrationFileNames', () => {
  it('accepts ordered fixed-width ids', () => {
    expect(
      validateMigrationFileNames([
        '000001-initial-auth.sql',
        '000002-add-nickname.sql',
      ]),
    ).toEqual([]);
  });

  it('rejects malformed names', () => {
    expect(validateMigrationFileNames(['1-init.sql'])).not.toEqual([]);
    expect(validateMigrationFileNames(['000001-Init.sql'])).not.toEqual([]);
    expect(validateMigrationFileNames(['000002-add.sql'])).toEqual([]);
  });

  it('rejects duplicate and out-of-order ids', () => {
    expect(
      validateMigrationFileNames([
        '000001-initial-auth.sql',
        '000001-second.sql',
      ]),
    ).not.toEqual([]);
    expect(
      validateMigrationFileNames(['000002-second.sql', '000001-first.sql']),
    ).not.toEqual([]);
  });
});

describe('validateManifest', () => {
  const validFiles: MigrationFileDigest[] = [
    { name: sqlFile, sha256: 'c'.repeat(64) },
  ];

  it('accepts a matching manifest', () => {
    const result = validateManifest(buildManifest(), validFiles);

    expect(result.ok).toBe(true);
  });

  it('rejects a manifest whose fingerprint does not match the descriptor', () => {
    const result = validateManifest(
      buildManifest({ initial_schema_fingerprint: 'd'.repeat(64) }),
      validFiles,
    );

    expect(result.ok).toBe(false);
  });

  it('rejects a missing or extra SQL file', () => {
    expect(validateManifest(buildManifest(), []).ok).toBe(false);
    expect(
      validateManifest(buildManifest(), [
        ...validFiles,
        { name: '000002-extra.sql', sha256: 'd'.repeat(64) },
      ]).ok,
    ).toBe(false);
  });

  it('rejects SQL bytes that do not match the recorded checksum', () => {
    const result = validateManifest(buildManifest(), [
      { name: sqlFile, sha256: 'e'.repeat(64) },
    ]);

    expect(result.ok).toBe(false);
  });

  it('rejects an inconsistent identity or checksum', () => {
    expect(
      validateManifest(buildManifest({ service: 'core' }), validFiles).ok,
    ).toBe(false);
    expect(
      validateManifest(
        buildManifest({
          migrations: [{ id: '000001', file: sqlFile, sha256: 'nope' }],
        }),
        validFiles,
      ).ok,
    ).toBe(false);
  });

  it('rejects duplicate migration ids', () => {
    const result = validateManifest(
      buildManifest({
        migrations: [
          { id: '000001', file: sqlFile, sha256: 'c'.repeat(64) },
          { id: '000001', file: sqlFile, sha256: 'c'.repeat(64) },
        ],
      }),
      validFiles,
    );

    expect(result.ok).toBe(false);
  });
});

describe('describeSchema', () => {
  it('maps introspected rows into a sorted descriptor', async () => {
    const queryable = fakeQueryable({
      tables: [{ name: 'verification' }, { name: 'user' }],
      columns: [
        {
          table_name: 'user',
          name: 'email',
          data_type: 'text',
          not_null: true,
          default_expr: null,
        },
        {
          table_name: 'user',
          name: 'createdAt',
          data_type: 'timestamptz',
          not_null: true,
          default_expr: 'CURRENT_TIMESTAMP',
        },
      ],
      constraints: [
        {
          table_name: 'user',
          name: 'user_pkey',
          kind: 'p',
          references_schema: null,
          references_table: null,
          on_delete: ' ',
          columns: ['id'],
          references_columns: [],
        },
      ],
      indexes: [
        {
          table_name: 'verification',
          name: 'verification_identifier_idx',
          is_unique: false,
          is_valid: true,
          is_partial: false,
          columns: ['identifier'],
        },
      ],
    });

    const result = await describeSchema(queryable, 'auth');

    expect(result.tables.map((table) => table.name)).toEqual([
      'user',
      'verification',
    ]);

    const user = result.tables[0] as SchemaDescriptor['tables'][number];
    expect(user.columns.map((column) => column.name)).toEqual([
      'createdAt',
      'email',
    ]);
    expect(user.columns[1]?.nullable).toBe(false);
    expect(user.constraints[0]).toMatchObject({
      name: 'user_pkey',
      kind: 'primary_key',
      columns: ['id'],
      onDelete: null,
    });

    const verification = result.tables[1] as SchemaDescriptor['tables'][number];
    expect(verification.indexes[0]?.name).toBe('verification_identifier_idx');
  });

  it('drops excluded bookkeeping tables', async () => {
    const queryable = fakeQueryable({
      tables: [{ name: 'user' }, { name: 'gootip_schema_migrations' }],
    });

    const result = await describeSchema(queryable, 'auth', {
      excludeTables: ['gootip_schema_migrations'],
    });

    expect(result.tables.map((table) => table.name)).toEqual(['user']);
  });
});

describe('fingerprintDescriptor', () => {
  it('is stable for equivalent descriptors', () => {
    expect(fingerprintDescriptor(descriptor)).toBe(
      fingerprintDescriptor({ ...descriptor }),
    );
    expect(isSchemaDescriptor(descriptor)).toBe(true);
    expect(isSchemaDescriptor({ schema: 'auth' })).toBe(false);
  });
});
