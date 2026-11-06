import { MigrationExecutor, type DataSource, type QueryRunner } from 'typeorm';

import { migrationHistorySha256 } from './contract.js';
import type { MigrationManifest } from './manifest.js';
import {
  preflightMigrationState,
  readMigrationHistory,
  type PreflightIdentity,
} from './preflight.js';

export class MigrationExecutionError extends Error {
  constructor(
    readonly code: 'LOCK_TIMEOUT' | 'INCOMPATIBLE_STATE' | 'HISTORY_MISMATCH',
  ) {
    super(code);
    this.name = 'MigrationExecutionError';
  }
}

/** Polls for the database-scoped session lock until it is acquired or times out. */
export const acquireMigrationLock = async (
  queryRunner: QueryRunner,
  waitMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + waitMs;
  let acquired = false;
  while (!acquired) {
    const [result] = await queryRunner.query(
      `SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':core', 0)) AS acquired`,
    );
    acquired = result.acquired;
    if (!acquired) {
      if (Date.now() >= deadline) {
        throw new MigrationExecutionError('LOCK_TIMEOUT');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

/** Releases the session lock using the same connection that acquired it. */
export const releaseMigrationLock = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  const [result] = await queryRunner.query(
    `SELECT pg_advisory_unlock(hashtextextended(current_database() || ':core', 0)) AS released`,
  );
  if (!result.released) throw new Error('Migration lock was not held');
};

/** Preflights and runs pending migrations on one locked connection and transaction. */
export const executeMigrations = async (
  dataSource: DataSource,
  manifest: MigrationManifest,
  identity: PreflightIdentity,
  options: { lockWaitMs?: number; expectedHistorySha256?: string } = {},
): Promise<{
  appliedNames: string[];
  history: Awaited<ReturnType<typeof readMigrationHistory>>;
}> => {
  const queryRunner = dataSource.createQueryRunner();
  let lockAcquired = false;
  try {
    await queryRunner.connect();
    await queryRunner.query("SET statement_timeout = '120s'");
    await queryRunner.query("SET lock_timeout = '30s'");
    await acquireMigrationLock(queryRunner, options.lockWaitMs);
    lockAcquired = true;

    const before = await preflightMigrationState(
      queryRunner,
      manifest,
      identity,
    );
    if (
      options.expectedHistorySha256 &&
      migrationHistorySha256(before) !== options.expectedHistorySha256
    ) {
      throw new MigrationExecutionError('HISTORY_MISMATCH');
    }
    const executor = new MigrationExecutor(dataSource, queryRunner);
    executor.transaction = 'all';
    executor.fake = false;
    const applied = await executor.executePendingMigrations();
    const history = await preflightMigrationState(
      queryRunner,
      manifest,
      identity,
    );
    if (history.length !== manifest.migrations.length) {
      throw new MigrationExecutionError('INCOMPATIBLE_STATE');
    }
    return {
      appliedNames: applied.map(({ name }) => name),
      history: history.map(({ name, timestamp }) => ({ name, timestamp })),
    };
  } finally {
    try {
      if (lockAcquired) await releaseMigrationLock(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }
};

/** Reads and validates history under the same session lock without mutation. */
export const validateMigrations = async (
  dataSource: DataSource,
  manifest: MigrationManifest,
  identity: PreflightIdentity,
): Promise<Awaited<ReturnType<typeof readMigrationHistory>>> => {
  const queryRunner = dataSource.createQueryRunner();
  let lockAcquired = false;
  try {
    await queryRunner.connect();
    await queryRunner.query("SET statement_timeout = '120s'");
    await queryRunner.query("SET lock_timeout = '30s'");
    await acquireMigrationLock(queryRunner);
    lockAcquired = true;
    return await preflightMigrationState(queryRunner, manifest, identity);
  } finally {
    try {
      if (lockAcquired) await releaseMigrationLock(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }
};
