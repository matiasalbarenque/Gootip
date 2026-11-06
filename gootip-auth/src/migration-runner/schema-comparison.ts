import type {
  SchemaDescriptor,
  SchemaTableDescriptor,
} from './schema-descriptor.js';

/**
 * Diagnostic comparison between the reviewed canonical structure and the live
 * one.
 *
 * Acceptance is decided by exact descriptor-fingerprint equality, never by this
 * comparison (a missed category must not be able to approve a different
 * structure). This module only explains a mismatch in bounded categories and
 * counts so the sanitized CloudWatch outcome is useful without exposing object
 * names, SQL, or row data.
 */

export type SchemaDifferenceKind =
  | 'missing_table'
  | 'unexpected_table'
  | 'column'
  | 'constraint'
  | 'index'
  | 'invalid_index'
  | 'sequence'
  | 'unexpected_relation';

export interface SchemaDifference {
  kind: SchemaDifferenceKind;
  count: number;
}

const merge = (
  accumulator: Map<SchemaDifferenceKind, number>,
  kind: SchemaDifferenceKind,
): void => {
  accumulator.set(kind, (accumulator.get(kind) ?? 0) + 1);
};

const byName = <T extends { name: string }>(
  entries: readonly T[],
): Map<string, T> => new Map(entries.map((entry) => [entry.name, entry]));

const sameColumn = (
  expected: SchemaTableDescriptor['columns'][number],
  live: SchemaTableDescriptor['columns'][number],
): boolean =>
  expected.dataType === live.dataType &&
  expected.nullable === live.nullable &&
  expected.default === live.default;

const sameConstraint = (
  expected: SchemaTableDescriptor['constraints'][number],
  live: SchemaTableDescriptor['constraints'][number],
): boolean =>
  expected.kind === live.kind &&
  expected.columns.join(',') === live.columns.join(',') &&
  expected.referencesSchema === live.referencesSchema &&
  expected.referencesTable === live.referencesTable &&
  expected.referencesColumns.join(',') === live.referencesColumns.join(',') &&
  expected.onDelete === live.onDelete;

const sameIndex = (
  expected: SchemaTableDescriptor['indexes'][number],
  live: SchemaTableDescriptor['indexes'][number],
): boolean =>
  expected.unique === live.unique &&
  expected.partial === live.partial &&
  expected.columns.join(',') === live.columns.join(',');

export const compareSchemaDescriptors = (
  expected: SchemaDescriptor,
  live: SchemaDescriptor,
): SchemaDifference[] => {
  const differences = new Map<SchemaDifferenceKind, number>();
  const expectedTables = byName(expected.tables);
  const liveTables = byName(live.tables);

  for (const name of expectedTables.keys()) {
    if (!liveTables.has(name)) {
      merge(differences, 'missing_table');
    }
  }

  for (const name of liveTables.keys()) {
    if (!expectedTables.has(name)) {
      merge(differences, 'unexpected_table');
    }
  }

  for (const [name, expectedTable] of expectedTables) {
    const liveTable = liveTables.get(name);

    if (!liveTable) {
      continue;
    }

    const expectedColumns = byName(expectedTable.columns);
    const liveColumns = byName(liveTable.columns);

    for (const [columnName, column] of expectedColumns) {
      const liveColumn = liveColumns.get(columnName);

      if (!liveColumn || !sameColumn(column, liveColumn)) {
        merge(differences, 'column');
      }
    }

    for (const columnName of liveColumns.keys()) {
      if (!expectedColumns.has(columnName)) {
        merge(differences, 'column');
      }
    }

    const expectedConstraints = byName(expectedTable.constraints);
    const liveConstraints = byName(liveTable.constraints);

    for (const [constraintName, constraint] of expectedConstraints) {
      const liveConstraint = liveConstraints.get(constraintName);

      if (!liveConstraint || !sameConstraint(constraint, liveConstraint)) {
        merge(differences, 'constraint');
      }
    }

    for (const constraintName of liveConstraints.keys()) {
      if (!expectedConstraints.has(constraintName)) {
        merge(differences, 'constraint');
      }
    }

    const expectedIndexes = byName(expectedTable.indexes);
    const liveIndexes = byName(liveTable.indexes);

    for (const [indexName, index] of expectedIndexes) {
      const liveIndex = liveIndexes.get(indexName);

      if (!liveIndex || !sameIndex(index, liveIndex)) {
        merge(differences, 'index');
      }
    }

    for (const [indexName, index] of liveIndexes) {
      if (!expectedIndexes.has(indexName)) {
        merge(differences, 'index');
      } else if (!index.valid) {
        merge(differences, 'invalid_index');
      }
    }
  }

  const expectedSequences = new Set(expected.sequences);
  const liveSequences = new Set(live.sequences);

  for (const name of expectedSequences) {
    if (!liveSequences.has(name)) {
      merge(differences, 'sequence');
    }
  }

  for (const name of liveSequences) {
    if (!expectedSequences.has(name)) {
      merge(differences, 'sequence');
    }
  }

  return [...differences.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => (left.kind < right.kind ? -1 : 1));
};

/**
 * Bounded one-line diagnostic: category names and counts only.
 */
export const formatSchemaDifferences = (
  differences: readonly SchemaDifference[],
): string =>
  `baseline mismatch: ${
    differences.length === 0
      ? 'structure fingerprint differs'
      : differences
          .map((difference) => `${difference.kind}=${difference.count}`)
          .join(', ')
  }`;
