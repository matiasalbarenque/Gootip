import type { QueryRunner } from 'typeorm';

import type { MigrationManifest } from './manifest.js';

export type HistoryRecord = { name: string; timestamp: number };
export type PreflightIdentity = {
  database: string;
  migrator: string;
  tls: boolean;
};

const expectedObjects: Record<string, string[]> = {
  CreateCategories1782086400000: ['categories'],
  CreateProducts1793059200000: ['products'],
};

/** Reads TypeORM history without creating its table or changing database state. */
export const readMigrationHistory = async (
  queryRunner: QueryRunner,
): Promise<HistoryRecord[]> => {
  const [table] = await queryRunner.query(
    `SELECT to_regclass('core.typeorm_migrations') AS relation`,
  );
  if (!table?.relation) return [];

  const columns = await queryRunner.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'core' AND table_name = 'typeorm_migrations'`,
  );
  const columnNames = new Set(
    columns.map((column: { column_name: string }) => column.column_name),
  );
  if (!['id', 'timestamp', 'name'].every((column) => columnNames.has(column))) {
    throw new Error('Incompatible migration history');
  }

  const rows = await queryRunner.query(
    'SELECT timestamp, name FROM core.typeorm_migrations ORDER BY id',
  );
  const names = new Set<string>();
  const timestamps = new Set<number>();
  return rows.map((row: { name: unknown; timestamp: unknown }) => {
    const timestamp = Number(row.timestamp);
    if (
      typeof row.name !== 'string' ||
      !Number.isSafeInteger(timestamp) ||
      names.has(row.name) ||
      timestamps.has(timestamp)
    ) {
      throw new Error('Incompatible migration history');
    }
    names.add(row.name);
    timestamps.add(timestamp);
    return { name: row.name, timestamp };
  });
};

/** Verifies database identity and rejects history that cannot be reconciled safely. */
export const preflightMigrationState = async (
  queryRunner: QueryRunner,
  manifest: MigrationManifest,
  expected: PreflightIdentity,
): Promise<HistoryRecord[]> => {
  const [identity] = await queryRunner.query(
    `SELECT current_database() AS database, current_user AS username,
            pg_get_userbyid(nspowner) AS owner,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls
     FROM pg_namespace WHERE nspname = 'core'`,
  );
  if (
    !identity ||
    identity.database !== expected.database ||
    identity.username !== expected.migrator ||
    identity.owner !== expected.migrator ||
    identity.tls !== expected.tls
  ) {
    throw new Error('Migration database prerequisites are not satisfied');
  }

  const history = await readMigrationHistory(queryRunner);
  const objects = await queryRunner.query(
    `SELECT c.relname AS name
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'core' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND c.relname NOT IN ('typeorm_migrations', 'typeorm_metadata')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
         WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
           AND d.refclassid = 'pg_class'::regclass
           AND d.refobjid = to_regclass('core.typeorm_migrations')
           AND d.deptype IN ('a', 'i')
       )`,
  );
  if (history.length === 0 && objects.length > 0) {
    throw new Error(
      'Existing Core objects have no compatible migration history',
    );
  }

  const registered = manifest.migrations;
  history.forEach((record, index) => {
    const expected = registered[index];
    if (
      !expected ||
      record.name !== expected.name ||
      record.timestamp !== expected.timestamp
    ) {
      throw new Error('Incompatible migration history');
    }
    for (const object of expectedObjects[record.name] ?? []) {
      if (
        !objects.some(
          (candidate: { name: string }) => candidate.name === object,
        )
      ) {
        throw new Error('Migration history does not match Core objects');
      }
    }
  });
  return history;
};
