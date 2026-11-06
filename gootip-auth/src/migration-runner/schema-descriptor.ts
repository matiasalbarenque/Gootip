import { canonicalJson, sha256Hex } from './digest.js';

/**
 * Structural descriptor of an application schema.
 *
 * Ownership, grants, and migration bookkeeping are deliberately excluded: the
 * privilege contract is validated separately and the history table is internal.
 */

export interface Queryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
}

export interface SchemaColumnDescriptor {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
}

export const CONSTRAINT_KINDS = [
  'primary_key',
  'foreign_key',
  'unique',
  'check',
] as const;

export type SchemaConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export interface SchemaConstraintDescriptor {
  name: string;
  kind: SchemaConstraintKind;
  columns: string[];
  referencesSchema: string | null;
  referencesTable: string | null;
  referencesColumns: string[];
  onDelete: string | null;
}

export interface SchemaIndexDescriptor {
  name: string;
  unique: boolean;
  valid: boolean;
  partial: boolean;
  columns: string[];
}

export interface SchemaTableDescriptor {
  name: string;
  columns: SchemaColumnDescriptor[];
  constraints: SchemaConstraintDescriptor[];
  indexes: SchemaIndexDescriptor[];
}

export interface SchemaDescriptor {
  schema: string;
  tables: SchemaTableDescriptor[];
  sequences: string[];
}

export interface DescribeSchemaOptions {
  excludeTables?: readonly string[];
}

const TABLES_SQL = `
  SELECT c.relname AS name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind = 'r'
`;

const COLUMNS_SQL = `
  SELECT c.relname AS table_name,
         a.attname AS name,
         format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull AS not_null,
         pg_get_expr(d.adbin, d.adrelid) AS default_expr
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
`;

const CONSTRAINTS_SQL = `
  SELECT c.relname AS table_name,
         con.conname AS name,
         con.contype AS kind,
         fn.nspname AS references_schema,
         fc.relname AS references_table,
         con.confdeltype AS on_delete,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
           AS columns,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum)
           AS references_columns
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class fc ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  WHERE n.nspname = $1 AND con.contype IN ('p', 'f', 'u', 'c')
`;

const INDEXES_SQL = `
  SELECT c.relname AS table_name,
         ic.relname AS name,
         i.indisunique AS is_unique,
         i.indisvalid AS is_valid,
         (i.indpred IS NOT NULL) AS is_partial,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
           AS columns
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
  WHERE n.nspname = $1 AND con.oid IS NULL
`;

const SEQUENCES_SQL = `
  SELECT sequencename AS name
  FROM pg_sequences
  WHERE schemaname = $1
`;

const CONSTRAINT_KIND_BY_CODE: Record<string, SchemaConstraintKind> = {
  p: 'primary_key',
  f: 'foreign_key',
  u: 'unique',
  c: 'check',
};

const ON_DELETE_BY_CODE: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : String(value);

const asNullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : asString(value);

const asBoolean = (value: unknown): boolean =>
  value === true || value === 't' || value === 'true';

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => asString(entry)) : [];

const byName = <T extends { name: string }>(left: T, right: T): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

const asTableName = (row: Record<string, unknown>): string =>
  asString(row.table_name);

const groupByTable = (
  rows: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> => {
  const grouped = new Map<string, Record<string, unknown>[]>();

  for (const row of rows) {
    const tableName = asTableName(row);
    const bucket = grouped.get(tableName);

    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(tableName, [row]);
    }
  }

  return grouped;
};

/**
 * Introspects one schema into a deterministic descriptor. Rows are sorted by
 * name so two equivalent structures serialize identically.
 */
export const describeSchema = async (
  queryable: Queryable,
  schema: string,
  options: DescribeSchemaOptions = {},
): Promise<SchemaDescriptor> => {
  const excluded = new Set(options.excludeTables ?? []);
  const [tables, columns, constraints, indexes, sequences] = await Promise.all([
    queryable.query(TABLES_SQL, [schema]),
    queryable.query(COLUMNS_SQL, [schema]),
    queryable.query(CONSTRAINTS_SQL, [schema]),
    queryable.query(INDEXES_SQL, [schema]),
    queryable.query(SEQUENCES_SQL, [schema]),
  ]);

  const columnsByTable = groupByTable(columns.rows);
  const constraintsByTable = groupByTable(constraints.rows);
  const indexesByTable = groupByTable(indexes.rows);

  const tableDescriptors = tables.rows
    .map((row) => asString(row.name))
    .filter((name) => !excluded.has(name))
    .sort()
    .map<SchemaTableDescriptor>((name) => ({
      name,
      columns: (columnsByTable.get(name) ?? [])
        .map<SchemaColumnDescriptor>((row) => ({
          name: asString(row.name),
          dataType: asString(row.data_type),
          nullable: !asBoolean(row.not_null),
          default: asNullableString(row.default_expr),
        }))
        .sort(byName),
      constraints: (constraintsByTable.get(name) ?? [])
        .map<SchemaConstraintDescriptor>((row) => ({
          name: asString(row.name),
          kind: CONSTRAINT_KIND_BY_CODE[asString(row.kind)] ?? 'check',
          columns: asStringArray(row.columns),
          referencesSchema: asNullableString(row.references_schema),
          referencesTable: asNullableString(row.references_table),
          referencesColumns: asStringArray(row.references_columns),
          onDelete: ON_DELETE_BY_CODE[asString(row.on_delete)] ?? null,
        }))
        .sort(byName),
      indexes: (indexesByTable.get(name) ?? [])
        .map<SchemaIndexDescriptor>((row) => ({
          name: asString(row.name),
          unique: asBoolean(row.is_unique),
          valid: asBoolean(row.is_valid),
          partial: asBoolean(row.is_partial),
          columns: asStringArray(row.columns),
        }))
        .sort(byName),
    }));

  return {
    schema,
    tables: tableDescriptors,
    sequences: sequences.rows.map((row) => asString(row.name)).sort(),
  };
};

export const fingerprintDescriptor = (descriptor: SchemaDescriptor): string =>
  sha256Hex(canonicalJson(descriptor));

export const isSchemaDescriptor = (
  value: unknown,
): value is SchemaDescriptor => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.schema === 'string' &&
    Array.isArray(record.tables) &&
    Array.isArray(record.sequences) &&
    record.tables.every(isSchemaTableDescriptor)
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isSchemaTableDescriptor = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === 'string' &&
    Array.isArray(value.columns) &&
    Array.isArray(value.constraints) &&
    Array.isArray(value.indexes)
  );
};
