import { HISTORY_TABLE } from './history.js';
import {
  compareSchemaDescriptors,
  type SchemaDifference,
} from './schema-comparison.js';
import {
  describeSchema,
  fingerprintDescriptor,
  type Queryable,
  type SchemaDescriptor,
} from './schema-descriptor.js';

/**
 * Structural baseline evidence for an `auth` schema that was populated before
 * migration history existed.
 *
 * Equivalence is exact descriptor-fingerprint equality against the reviewed
 * canonical structure in the manifest. Anything the descriptor cannot express
 * (relations such as views, materialized views, and foreign tables) is counted
 * separately and also blocks adoption, so an unexpected object can never be
 * approved by accident.
 */

const UNEXPECTED_RELATIONS_SQL = `
  SELECT count(*)::int AS count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relkind IN ('v', 'm', 'f')
`;

/**
 * The migration history table is internal bookkeeping, not application
 * structure, so it never participates in baseline comparison or detection.
 */
export const describeApplicationSchema = async (
  queryable: Queryable,
  schema: string,
): Promise<SchemaDescriptor> =>
  describeSchema(queryable, schema, { excludeTables: [HISTORY_TABLE] });

export const countUnexpectedRelations = async (
  queryable: Queryable,
  schema: string,
): Promise<number> => {
  const row = (await queryable.query(UNEXPECTED_RELATIONS_SQL, [schema]))
    .rows[0];
  const count = Number(row?.count ?? 0);

  return Number.isFinite(count) && count > 0 ? count : 0;
};

export interface ApplicationObjects {
  present: boolean;
  unexpectedRelations: number;
}

/**
 * True when the schema already holds authentication application objects — a
 * table, a sequence, or a relation kind the descriptor does not model. An empty
 * `auth` schema created by administrative bootstrap is not evidence of
 * application objects.
 */
export const detectApplicationObjects = async (
  queryable: Queryable,
  schema: string,
): Promise<ApplicationObjects> => {
  const descriptor = await describeApplicationSchema(queryable, schema);
  const unexpectedRelations = await countUnexpectedRelations(queryable, schema);

  return {
    present:
      descriptor.tables.length > 0 ||
      descriptor.sequences.length > 0 ||
      unexpectedRelations > 0,
    unexpectedRelations,
  };
};

export interface BaselineEquivalence {
  ok: boolean;
  fingerprint: string;
  differences: SchemaDifference[];
}

/**
 * Revalidates the live structure under the held session lock against the
 * reviewed descriptor. The fingerprint is the acceptance criterion; the
 * differences are only a bounded diagnostic for mismatched structures.
 */
export const checkBaselineEquivalence = async (
  queryable: Queryable,
  schema: string,
  expected: SchemaDescriptor,
  expectedFingerprint: string,
): Promise<BaselineEquivalence> => {
  const live = await describeApplicationSchema(queryable, schema);
  const unexpectedRelations = await countUnexpectedRelations(queryable, schema);
  const fingerprint = fingerprintDescriptor(live);
  const differences: SchemaDifference[] = [
    ...(fingerprint === expectedFingerprint
      ? []
      : compareSchemaDescriptors(expected, live)),
    ...(unexpectedRelations === 0
      ? []
      : [{ kind: 'unexpected_relation' as const, count: unexpectedRelations }]),
  ];

  return {
    ok: fingerprint === expectedFingerprint && unexpectedRelations === 0,
    fingerprint,
    differences,
  };
};
