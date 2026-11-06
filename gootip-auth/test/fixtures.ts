import type { AppEnv } from '../src/config/env.js';
import type { MigrationSource } from '../src/migration-runner/apply.js';
import { sha256Hex } from '../src/migration-runner/digest.js';
import type { HistoryRow } from '../src/migration-runner/history.js';
import type { MigrationManifest } from '../src/migration-runner/manifest.js';
import {
  fingerprintDescriptor,
  type Queryable,
  type SchemaConstraintKind,
  type SchemaDescriptor,
} from '../src/migration-runner/schema-descriptor.js';

export const validEnv: AppEnv = {
  PORT: 3000,
  POSTGRES_DB_HOST: 'localhost',
  POSTGRES_DB_PORT: 5433,
  POSTGRES_DB_NAME: 'gootip',
  AUTH_PG_POOL_MAX: 2,
  AUTH_RATE_LIMIT_ENABLED: 'true',
  AUTH_RATE_LIMIT_RULES:
    '/sign-in/*:10:3,/sign-up/*:10:3,/request-password-reset:60:3,/forget-password/*:60:3',
  POSTGRES_DB_USER: 'user',
  POSTGRES_DB_PASSWORD: 'password',
  POSTGRES_SSL_MODE: 'disable',
  BETTER_AUTH_SECRET: 'a-secure-test-secret-with-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3000',
  JWT_AUDIENCE: 'api',
  FRONTEND_URL: 'http://localhost:5173',
};

/**
 * Shared migration-runner fixtures: the reviewed history shape as PostgreSQL
 * reports it, a history row, a manifest, and a scripted queryable that fails on
 * any query the code under test was not expected to issue.
 */

export const historyStructureRows = (): Record<string, unknown>[] => [
  {
    name: 'migration_id',
    data_type: 'text',
    not_null: true,
    default_expr: null,
  },
  {
    name: 'checksum_sha256',
    data_type: 'character(64)',
    not_null: true,
    default_expr: null,
  },
  {
    name: 'applied_at',
    data_type: 'timestamp with time zone',
    not_null: true,
    default_expr: 'now()',
  },
  { name: 'commit_sha', data_type: 'text', not_null: true, default_expr: null },
  { name: 'run_id', data_type: 'text', not_null: true, default_expr: null },
  {
    name: 'application_mode',
    data_type: 'text',
    not_null: true,
    default_expr: null,
  },
  {
    name: 'approval_reference',
    data_type: 'text',
    not_null: false,
    default_expr: null,
  },
  {
    name: 'schema_fingerprint',
    data_type: 'text',
    not_null: false,
    default_expr: null,
  },
];

export const historyConstraintRows = (): Record<string, unknown>[] => [
  {
    kind: 'p',
    definition: 'PRIMARY KEY (migration_id)',
    expression: null,
    columns: ['migration_id'],
  },
  {
    kind: 'c',
    definition:
      "CHECK ((application_mode = ANY (ARRAY['applied'::text, 'baseline_verified'::text])))",
    expression:
      "(application_mode = ANY (ARRAY['applied'::text, 'baseline_verified'::text]))",
    columns: ['application_mode'],
  },
];

/** The reviewed constraint accepts both modes and rejects anything else. */
export const historyModeProbeRows = (): Record<string, unknown>[] => [
  { probe_value: 'applied', accepted: true },
  { probe_value: 'baseline_verified', accepted: true },
  { probe_value: 'not-a-migration-mode', accepted: false },
];

/** A permissive constraint that still mentions both reviewed mode names. */
export const historyPermissiveModeProbeRows = (): Record<string, unknown>[] => [
  { probe_value: 'applied', accepted: true },
  { probe_value: 'baseline_verified', accepted: true },
  { probe_value: 'not-a-migration-mode', accepted: true },
];

export const historyRow = (
  overrides: Partial<HistoryRow> = {},
): HistoryRow & Record<string, unknown> => ({
  migration_id: '000001',
  checksum_sha256: 'a'.repeat(64),
  applied_at: '2026-01-01T00:00:00.000000Z',
  commit_sha: 'b'.repeat(40),
  run_id: 'run-1',
  application_mode: 'applied',
  approval_reference: null,
  schema_fingerprint: null,
  ...overrides,
});

export const emptySchemaDescriptor = (): SchemaDescriptor => ({
  schema: 'auth',
  tables: [],
  sequences: [],
});

/**
 * A small canonical structure used by baseline tests. It exercises a table,
 * columns with a default and nullability, a primary key, a unique index, and a
 * sequence.
 */
export const schemaDescriptorFixture = (): SchemaDescriptor => ({
  schema: 'auth',
  tables: [
    {
      name: 'user',
      columns: [
        {
          name: 'created_at',
          dataType: 'timestamp with time zone',
          nullable: false,
          default: 'now()',
        },
        {
          name: 'email',
          dataType: 'text',
          nullable: false,
          default: null,
        },
        {
          name: 'id',
          dataType: 'text',
          nullable: false,
          default: null,
        },
      ],
      constraints: [
        {
          name: 'user_pkey',
          kind: 'primary_key',
          columns: ['id'],
          referencesSchema: null,
          referencesTable: null,
          referencesColumns: [],
          onDelete: null,
        },
      ],
      indexes: [
        {
          name: 'user_email_idx',
          unique: true,
          valid: true,
          partial: false,
          columns: ['email'],
        },
      ],
    },
  ],
  sequences: ['user_sequence'],
});

const CONSTRAINT_KINDS: Record<SchemaConstraintKind, string> = {
  primary_key: 'p',
  foreign_key: 'f',
  unique: 'u',
  check: 'c',
};

const ON_DELETE_CODES: Record<string, string> = {
  'NO ACTION': 'a',
  RESTRICT: 'r',
  CASCADE: 'c',
  'SET NULL': 'n',
  'SET DEFAULT': 'd',
};

/**
 * The rows `describeSchema` reads, reconstructed from a descriptor. Round-trip
 * tests use it so a scripted live schema has exactly the expected fingerprint.
 */
export const descriptorRows = (
  descriptor: SchemaDescriptor,
): Record<string, unknown>[][] => [
  descriptor.tables.map((table) => ({ name: table.name })),
  descriptor.tables.flatMap((table) =>
    table.columns.map((column) => ({
      table_name: table.name,
      name: column.name,
      data_type: column.dataType,
      not_null: !column.nullable,
      default_expr: column.default,
    })),
  ),
  descriptor.tables.flatMap((table) =>
    table.constraints.map((constraint) => ({
      table_name: table.name,
      name: constraint.name,
      kind: CONSTRAINT_KINDS[constraint.kind],
      references_schema: constraint.referencesSchema,
      references_table: constraint.referencesTable,
      on_delete:
        constraint.onDelete === null
          ? null
          : (ON_DELETE_CODES[constraint.onDelete] ?? null),
      columns: constraint.columns,
      references_columns:
        constraint.referencesColumns.length === 0
          ? null
          : constraint.referencesColumns,
    })),
  ),
  descriptor.tables.flatMap((table) =>
    table.indexes.map((index) => ({
      table_name: table.name,
      name: index.name,
      is_unique: index.unique,
      is_valid: index.valid,
      is_partial: index.partial,
      columns: index.columns,
    })),
  ),
  descriptor.sequences.map((name) => ({ name })),
];

export const manifestFixture = (
  ids: string[],
  checksums: string[] = ids.map(() => 'a'.repeat(64)),
  initialSchema: SchemaDescriptor = emptySchemaDescriptor(),
): MigrationManifest => ({
  manifest_version: 1,
  service: 'auth',
  schema: 'auth',
  commit_sha: 'b'.repeat(40),
  better_auth_version: '1.7.7',
  generator_version: '1.7.7',
  configuration_sha256: 'c'.repeat(64),
  migrations: ids.map((id, index) => ({
    id,
    file: `${id}-step.sql`,
    sha256: checksums[index] as string,
  })),
  initial_schema_fingerprint: fingerprintDescriptor(initialSchema),
  initial_schema: initialSchema,
});

/**
 * Fixture migration SQL. Its hash is what the fixture manifest records, so the
 * apply path's exact-byte verification succeeds without touching real files.
 */
export const fixtureMigrationSql = (id: string): string =>
  `-- reviewed ${id}\nselect '${id}' as reviewed;\n`;

/**
 * A manifest plus the reviewed SQL it names. Checksums default to the real hash
 * of the fixture SQL; pass explicit ones when a test only needs manifest shape.
 */
export const migrationSourceFixture = (
  ids: readonly string[],
  checksums?: readonly string[],
  initialSchema: SchemaDescriptor = emptySchemaDescriptor(),
): MigrationSource => {
  const manifest = manifestFixture(
    [...ids],
    checksums
      ? [...checksums]
      : ids.map((id) => sha256Hex(fixtureMigrationSql(id))),
    initialSchema,
  );

  return {
    manifest,
    sql: new Map(
      manifest.migrations.map((entry) => [
        entry.file,
        fixtureMigrationSql(entry.id),
      ]),
    ),
  };
};

export interface ScriptedQueryable {
  queryable: Queryable;
  statements: string[];
  parameters: unknown[][];
}

/**
 * Returns scripted results in order and throws on an unexpected query, so a
 * missing script entry fails the test instead of silently returning nothing.
 */
export const scriptedQueryable = (
  rows: readonly (readonly Record<string, unknown>[])[],
): ScriptedQueryable => {
  const queue = [...rows];
  const statements: string[] = [];
  const parameters: unknown[][] = [];

  return {
    statements,
    parameters,
    queryable: {
      query: async (text, values) => {
        statements.push(text);
        parameters.push(values ? [...values] : []);
        const next = queue.shift();

        if (!next) {
          throw new Error('unexpected query');
        }

        return { rows: next };
      },
    },
  };
};
