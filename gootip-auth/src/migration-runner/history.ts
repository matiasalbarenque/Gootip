import { canonicalJson, sha256Hex } from './digest.js';
import type { MigrationManifest } from './manifest.js';
import {
  APPROVAL_REFERENCE_PATTERN,
  COMMIT_SHA_PATTERN,
  RUN_ID_PATTERN,
  SHA256_PATTERN,
} from './patterns.js';
import type { Queryable } from './schema-descriptor.js';

/**
 * Internal migration bookkeeping owned by `auth_migrator`.
 *
 * The table is created, validated, and read under the session advisory lock
 * (Step 8), never during normal application initialization, and holds no
 * credentials. Its checksum column binds each applied ID to the exact reviewed
 * SQL bytes.
 */

export const HISTORY_TABLE = 'gootip_schema_migrations';

export const HISTORY_APPLICATION_MODES = [
  'applied',
  'baseline_verified',
] as const;

export type HistoryApplicationMode = (typeof HISTORY_APPLICATION_MODES)[number];

/**
 * Privileges that must never be held by any role other than the migrator owner.
 * `ALTER` is not a table ACL privilege; altering requires ownership, which the
 * owner check enforces instead.
 */
export const FORBIDDEN_HISTORY_PRIVILEGES = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

export interface HistoryRow {
  migration_id: string;
  checksum_sha256: string;
  applied_at: string;
  commit_sha: string;
  run_id: string;
  application_mode: string;
  approval_reference: string | null;
  schema_fingerprint: string | null;
}

export type HistoryVerification =
  | { ok: true; appliedIds: string[]; pendingIds: string[] }
  | { ok: false; reason: string };

export const HISTORY_COLUMNS = [
  'migration_id',
  'checksum_sha256',
  'applied_at',
  'commit_sha',
  'run_id',
  'application_mode',
  'approval_reference',
  'schema_fingerprint',
] as const;

/**
 * Expected column shape: name, PostgreSQL type, nullability, and default.
 * `format_type` output is the canonical spelling used by both PostgreSQL and
 * the descriptor module.
 */
export const HISTORY_COLUMN_CONTRACT = [
  { name: 'migration_id', dataType: 'text', notNull: true, default: null },
  {
    name: 'checksum_sha256',
    dataType: 'character(64)',
    notNull: true,
    default: null,
  },
  {
    name: 'applied_at',
    dataType: 'timestamp with time zone',
    notNull: true,
    default: 'now()',
  },
  { name: 'commit_sha', dataType: 'text', notNull: true, default: null },
  { name: 'run_id', dataType: 'text', notNull: true, default: null },
  { name: 'application_mode', dataType: 'text', notNull: true, default: null },
  {
    name: 'approval_reference',
    dataType: 'text',
    notNull: false,
    default: null,
  },
  {
    name: 'schema_fingerprint',
    dataType: 'text',
    notNull: false,
    default: null,
  },
] as const;

const HISTORY_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS %TABLE% (
     "migration_id" text NOT NULL PRIMARY KEY,
     "checksum_sha256" char(64) NOT NULL,
     "applied_at" timestamptz NOT NULL DEFAULT now(),
     "commit_sha" text NOT NULL,
     "run_id" text NOT NULL,
     "application_mode" text NOT NULL
       CHECK ("application_mode" IN ('applied', 'baseline_verified')),
     "approval_reference" text,
     "schema_fingerprint" text
   )`,
  // SPEC 03 grants the runtime role DML on tables created by the migrator through
  // ALTER DEFAULT PRIVILEGES, so the revoke must name it explicitly and must be
  // part of the same transaction as the create.
  `REVOKE ALL ON TABLE %TABLE% FROM PUBLIC`,
  `REVOKE ALL ON TABLE %TABLE% FROM %RUNTIME%`,
];

export const historyTableName = (schema: string): string =>
  `"${schema}"."${HISTORY_TABLE}"`;

export const historyTableDdl = (
  schema: string,
  runtimeUser: string,
): string[] =>
  HISTORY_TABLE_DDL.map((statement) =>
    statement
      .replaceAll('%TABLE%', historyTableName(schema))
      .replaceAll('%RUNTIME%', `"${runtimeUser}"`),
  );

/**
 * Creates the table and applies both revokes in one transaction, so there is no
 * window in which the runtime role holds the default privileges SPEC 03 grants
 * to tables created by the migrator.
 */
export const createHistoryTable = async (
  queryable: Queryable,
  schema: string,
  runtimeUser: string,
): Promise<void> => {
  await queryable.query('BEGIN');

  try {
    for (const statement of historyTableDdl(schema, runtimeUser)) {
      await queryable.query(statement);
    }

    await queryable.query('COMMIT');
  } catch (error) {
    await queryable.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
};

export interface HistoryInsert {
  migrationId: string;
  checksumSha256: string;
  commitSha: string;
  runId: string;
  applicationMode: HistoryApplicationMode;
  approvalReference: string | null;
  schemaFingerprint: string | null;
}

const HISTORY_INSERT_SQL = `
  INSERT INTO %TABLE%
    ("migration_id", "checksum_sha256", "commit_sha", "run_id",
     "application_mode", "approval_reference", "schema_fingerprint")
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING "migration_id"
`;

/**
 * Records one applied or adopted migration. The caller owns the transaction:
 * `apply` commits the reviewed SQL together with this row, and baseline
 * adoption records the verified evidence in a transaction of its own.
 */
export const insertHistoryRow = async (
  queryable: Queryable,
  schema: string,
  row: HistoryInsert,
): Promise<number> => {
  const result = await queryable.query(
    HISTORY_INSERT_SQL.replaceAll('%TABLE%', historyTableName(schema)),
    [
      row.migrationId,
      row.checksumSha256,
      row.commitSha,
      row.runId,
      row.applicationMode,
      row.approvalReference,
      row.schemaFingerprint,
    ],
  );

  return result.rows.length;
};

const HISTORY_EXISTS_SQL = `
  SELECT 1 AS present
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
`;

/**
 * Distinguishes "no history yet" from "history exists", so read-only
 * operations never create the table and creation happens only on the paths that
 * are allowed to record history.
 */
export const historyTableExists = async (
  queryable: Queryable,
  schema: string,
  table: string = HISTORY_TABLE,
): Promise<boolean> =>
  (await queryable.query(HISTORY_EXISTS_SQL, [schema, table])).rows.length > 0;

const HISTORY_STRUCTURE_SQL = `
  SELECT a.attname::text AS name,
         format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull AS not_null,
         pg_get_expr(d.adbin, d.adrelid) AS default_expr
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = $1
     AND c.relname = $2
     AND c.relkind = 'r'
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY a.attnum
`;

const HISTORY_CONSTRAINTS_SQL = `
  SELECT con.contype AS kind,
         pg_get_constraintdef(con.oid) AS definition,
         pg_get_expr(con.conbin, con.conrelid) AS expression,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = $2
`;

/**
 * The canonical check expression only ever contains these characters. Anything
 * else is refused before the expression is used in a probe query.
 */
const MODE_EXPRESSION_PATTERN = /^[A-Za-z0-9_\s().,'":[\]=<>!%+*|~^-]+$/;

const MODE_PROBE_UNEXPECTED = 'not-a-migration-mode';

/**
 * Evaluates the live check expression against representative values instead of
 * matching its text. A permissive constraint that merely mentions both mode
 * names — `... OR application_mode LIKE '%'`, an extra literal, or a disjunct
 * over another column — is therefore rejected rather than trusted.
 */
const modeProbeSql = (expression: string): string => `
  SELECT probe.value AS probe_value,
         (SELECT (${expression})
            FROM (SELECT probe.value::text AS "application_mode") AS row_probe)
           AS accepted
    FROM (VALUES ('applied'), ('baseline_verified'), ('${MODE_PROBE_UNEXPECTED}'))
           AS probe(value)
`;

const MODE_PROBE_EXPECTATION = [
  ['applied', true],
  ['baseline_verified', true],
  [MODE_PROBE_UNEXPECTED, false],
] as const;

export type HistoryStructure = { ok: true } | { ok: false; reason: string };

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : [];

/**
 * Validates the exact structure of an existing history table: the eight
 * columns with their types, nullability and defaults, the primary key on
 * `migration_id`, and the `application_mode` check constraint. A table that is
 * merely "close enough" is rejected rather than trusted.
 */
export const validateHistoryTableStructure = async (
  queryable: Queryable,
  schema: string,
  table: string = HISTORY_TABLE,
): Promise<HistoryStructure> => {
  const columns = (
    await queryable.query(HISTORY_STRUCTURE_SQL, [schema, table])
  ).rows;

  if (columns.length === 0) {
    return { ok: false, reason: 'the history table does not exist' };
  }

  if (columns.length !== HISTORY_COLUMN_CONTRACT.length) {
    return {
      ok: false,
      reason: 'the history table does not have the reviewed columns',
    };
  }

  for (const expected of HISTORY_COLUMN_CONTRACT) {
    const actual = columns.find(
      (column) => String(column.name) === expected.name,
    );

    if (!actual) {
      return {
        ok: false,
        reason: 'the history table does not have the reviewed columns',
      };
    }

    if (String(actual.data_type) !== expected.dataType) {
      return {
        ok: false,
        reason: `the history column ${expected.name} has an unexpected type`,
      };
    }

    if ((actual.not_null === true) !== expected.notNull) {
      return {
        ok: false,
        reason: `the history column ${expected.name} has unexpected nullability`,
      };
    }

    const defaultExpr =
      actual.default_expr === null || actual.default_expr === undefined
        ? null
        : String(actual.default_expr);

    if (defaultExpr !== expected.default) {
      return {
        ok: false,
        reason: `the history column ${expected.name} has an unexpected default`,
      };
    }
  }

  const constraints = (
    await queryable.query(HISTORY_CONSTRAINTS_SQL, [schema, table])
  ).rows;

  const primaryKeys = constraints.filter(
    (constraint) => String(constraint.kind) === 'p',
  );

  if (
    primaryKeys.length !== 1 ||
    asStringArray(primaryKeys[0]?.columns).join(',') !== 'migration_id'
  ) {
    return {
      ok: false,
      reason: 'the history table primary key is not migration_id',
    };
  }

  const modeChecks = constraints.filter(
    (constraint) =>
      String(constraint.kind) === 'c' &&
      typeof constraint.expression === 'string' &&
      constraint.expression.includes('application_mode'),
  );

  if (modeChecks.length !== 1) {
    return {
      ok: false,
      reason: 'the history table application_mode check is missing',
    };
  }

  const modeExpression = String(modeChecks[0]?.expression);

  if (!MODE_EXPRESSION_PATTERN.test(modeExpression)) {
    return {
      ok: false,
      reason: 'the history table application_mode check could not be validated',
    };
  }

  let probes: readonly Record<string, unknown>[];

  try {
    probes = (await queryable.query(modeProbeSql(modeExpression))).rows;
  } catch {
    return {
      ok: false,
      reason: 'the history table application_mode check could not be validated',
    };
  }

  for (const [probeValue, expected] of MODE_PROBE_EXPECTATION) {
    const probe = probes.find((row) => String(row.probe_value) === probeValue);

    if (!probe || (probe.accepted === true) !== expected) {
      return {
        ok: false,
        reason:
          'the history table application_mode check does not match the reviewed values',
      };
    }
  }

  return { ok: true };
};

/**
 * Reads history in manifest order. `applied_at` is normalized to a fixed
 * microsecond UTC string so the digest never depends on driver date parsing,
 * the session time zone, or host locale.
 */
export const HISTORY_READ_SQL = `
  SELECT "migration_id",
         "checksum_sha256",
         to_char(
           "applied_at" AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS "applied_at",
         "commit_sha",
         "run_id",
         "application_mode",
         "approval_reference",
         "schema_fingerprint"
    FROM %TABLE%
   ORDER BY "migration_id"
`;

export const readHistory = async (
  queryable: Queryable,
  schema: string,
): Promise<HistoryRow[]> => {
  const result = await queryable.query(
    HISTORY_READ_SQL.replaceAll('%TABLE%', historyTableName(schema)),
  );

  return result.rows.map((row) => ({
    migration_id: String(row.migration_id),
    checksum_sha256: String(row.checksum_sha256),
    applied_at: String(row.applied_at),
    commit_sha: String(row.commit_sha),
    run_id: String(row.run_id),
    application_mode: String(row.application_mode),
    approval_reference:
      row.approval_reference === null || row.approval_reference === undefined
        ? null
        : String(row.approval_reference),
    schema_fingerprint:
      row.schema_fingerprint === null || row.schema_fingerprint === undefined
        ? null
        : String(row.schema_fingerprint),
  }));
};

/**
 * Deterministic digest over the ordered history rows. Equivalent history always
 * produces the same digest on any host, and any changed row changes it.
 */
export const historyDigest = (rows: readonly HistoryRow[]): string =>
  sha256Hex(canonicalJson(rows));

const isHistoryRowMalformed = (row: HistoryRow): boolean => {
  if (
    !/^\d{6}$/.test(row.migration_id) ||
    !SHA256_PATTERN.test(row.checksum_sha256) ||
    row.applied_at.length === 0 ||
    !COMMIT_SHA_PATTERN.test(row.commit_sha) ||
    !RUN_ID_PATTERN.test(row.run_id) ||
    !(HISTORY_APPLICATION_MODES as readonly string[]).includes(
      row.application_mode,
    )
  ) {
    return true;
  }

  if (row.application_mode === 'baseline_verified') {
    return (
      row.approval_reference === null ||
      !APPROVAL_REFERENCE_PATTERN.test(row.approval_reference) ||
      row.schema_fingerprint === null ||
      !SHA256_PATTERN.test(row.schema_fingerprint)
    );
  }

  return false;
};

/**
 * Verifies that the live history is an exact prefix of the packaged manifest.
 *
 * Unknown, reordered, gapped, altered, malformed, or manifest-ahead-of-history
 * states are rejected before any pending SQL runs, and an already-applied entry
 * is never skipped as though a changed checksum were fine.
 */
export const verifyHistory = (
  rows: readonly HistoryRow[],
  manifest: MigrationManifest,
): HistoryVerification => {
  const migrations = manifest.migrations;

  for (const row of rows) {
    if (isHistoryRowMalformed(row)) {
      return { ok: false, reason: 'history contains a malformed row' };
    }
  }

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1] as HistoryRow;
    const current = rows[index] as HistoryRow;

    if (current.migration_id === previous.migration_id) {
      return { ok: false, reason: 'history contains a duplicate entry' };
    }

    if (current.migration_id < previous.migration_id) {
      return { ok: false, reason: 'history is not in manifest order' };
    }
  }

  if (rows.length > migrations.length) {
    return { ok: false, reason: 'the manifest is behind the live database' };
  }

  const knownIds = new Set(migrations.map((entry) => entry.id));

  for (const row of rows) {
    if (!knownIds.has(row.migration_id)) {
      return { ok: false, reason: 'history contains an unknown migration id' };
    }
  }

  for (const [index, row] of rows.entries()) {
    const expected = migrations[index];

    if (!expected || row.migration_id !== expected.id) {
      return { ok: false, reason: 'history is not a prefix of the manifest' };
    }

    if (row.checksum_sha256 !== expected.sha256) {
      return { ok: false, reason: 'an applied migration checksum changed' };
    }
  }

  return {
    ok: true,
    appliedIds: rows.map((row) => row.migration_id),
    pendingIds: migrations.slice(rows.length).map((entry) => entry.id),
  };
};

export type HistoryProtection = { ok: true } | { ok: false; reason: string };

const HISTORY_OWNER_SQL = `
  SELECT c.relowner::regrole::text AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
`;

/**
 * Raw ACL entries. The fallback to `acldefault` also exposes what a default
 * privileges policy would have granted, and the owner is allowed to hold the
 * privileges it needs.
 */
const HISTORY_GRANTS_SQL = `
  SELECT CASE
           WHEN a.grantee = 0 THEN 'PUBLIC'
           ELSE a.grantee::regrole::text
         END AS grantee,
         a.privilege_type AS privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(c.relacl, acldefault('r', c.relowner))
    ) AS a
   WHERE n.nspname = $1
     AND c.relname = $2
     AND c.relkind = 'r'
     AND a.privilege_type IN (
       'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
     )
`;

/**
 * Effective privileges for one role, using `has_table_privilege` so ownership,
 * role membership, and grants that arrive only through `PUBLIC` are all
 * accounted for rather than inferred from raw ACL rows. `PUBLIC` itself is not
 * a role, so it is covered by the raw ACL expansion above.
 */
const HISTORY_EFFECTIVE_SQL = `
  SELECT p.privilege AS privilege,
         has_table_privilege($1, $2, p.privilege) AS allowed
    FROM unnest($3::text[]) AS p(privilege)
`;

/**
 * Confirms the history table is owned by the migrator and that the runtime role
 * and `PUBLIC` hold neither raw ACL entries nor effective modification
 * privileges.
 */
export const verifyHistoryProtection = async (
  queryable: Queryable,
  schema: string,
  owner: string,
  runtimeUser: string,
): Promise<HistoryProtection> => {
  const table = historyTableName(schema);
  const ownerRow = (
    await queryable.query(HISTORY_OWNER_SQL, [schema, HISTORY_TABLE])
  ).rows[0];

  if (!ownerRow) {
    return { ok: false, reason: 'the history table does not exist' };
  }

  if (String(ownerRow.owner) !== owner) {
    return {
      ok: false,
      reason: 'the history table is not owned by the migrator',
    };
  }

  const grants = (
    await queryable.query(HISTORY_GRANTS_SQL, [schema, HISTORY_TABLE])
  ).rows;

  for (const grant of grants) {
    const grantee = String(grant.grantee);

    if (grantee !== owner) {
      return {
        ok: false,
        reason: `the history table grants ${String(grant.privilege)} to ${grantee}`,
      };
    }
  }

  const effective = (
    await queryable.query(HISTORY_EFFECTIVE_SQL, [
      runtimeUser,
      table,
      [...FORBIDDEN_HISTORY_PRIVILEGES],
    ])
  ).rows;

  const allowed = effective.find((row) => row.allowed === true);

  if (allowed) {
    return {
      ok: false,
      reason: `auth_runtime can ${String(allowed.privilege)} the history table`,
    };
  }

  return { ok: true };
};

/**
 * Activation revalidation: compares the deterministic digest of the live
 * history with the digest an operator recorded at review time.
 */
export const historyMatchesExpected = (
  rows: readonly HistoryRow[],
  expectedHistorySha256: string,
): boolean => historyDigest(rows) === expectedHistorySha256;
