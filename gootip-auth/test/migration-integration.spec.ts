import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  budgetedConnection,
  createOperationBudget,
  OperationBudgetExhaustedError,
  type OperationBudget,
} from '../src/migration-runner/budget.js';
import { loadMigrationBundle } from '../src/migration-runner/bundle.js';
import type { MigrationConfig } from '../src/migration-runner/config.js';
import type { MigrationRequest } from '../src/migration-runner/contract.js';
import type { MigrationConnection } from '../src/migration-runner/database.js';
import { connectToDatabase } from '../src/migration-runner/database.js';
import { sha256Hex } from '../src/migration-runner/digest.js';
import {
  createHistoryTable,
  historyDigest,
  historyTableName,
  readHistory,
  validateHistoryTableStructure,
  verifyHistory,
  verifyHistoryProtection,
} from '../src/migration-runner/history.js';
import {
  acquireSessionLock,
  advisoryLockKey,
  releaseSessionLock,
} from '../src/migration-runner/lock.js';
import type { Queryable } from '../src/migration-runner/schema-descriptor.js';
import {
  runMigrationSession,
  type MigrationSessionContext,
} from '../src/migration-runner/session.js';
import { manifestFixture } from './fixtures.js';
import {
  requiredTestPassword,
  sqlLiteral,
  suiteDatabaseUrl,
} from './local-postgres.js';

/**
 * Integration coverage against a real PostgreSQL server.
 *
 * Uses the shared PostgreSQL service and its isolated auth-migrations database.
 * The suite is skipped during unit-only runs when its local URL is not supplied.
 */

const TEST_DATABASE = 'gootip_test_auth_migrations';
const MIGRATOR_USER = 'test_auth_migrations_migrator';
const RUNTIME_USER = 'test_auth_migrations_runtime';
const adminUrl = suiteDatabaseUrl(
  'AUTH_MIGRATION_TEST_DATABASE_URL',
  TEST_DATABASE,
);
const migratorPassword = adminUrl
  ? requiredTestPassword('TEST_AUTH_MIGRATIONS_MIGRATOR_PASSWORD')
  : '';
const runtimePassword = adminUrl
  ? requiredTestPassword('TEST_AUTH_MIGRATIONS_RUNTIME_PASSWORD')
  : '';
const SCHEMA = 'auth';
const TABLE = historyTableName(SCHEMA);

const connect = async (
  user: string,
  password: string,
): Promise<{ client: Client; queryable: Queryable }> => {
  const url = new URL(adminUrl);
  const client = new Client({
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.replace(/^\//, ''),
    user,
    password,
  });

  await client.connect();

  return {
    client,
    queryable: {
      query: async (text, values) => {
        const result = await client.query(
          text,
          values ? [...values] : undefined,
        );

        return { rows: result.rows as Record<string, unknown>[] };
      },
    },
  };
};

const attempt = async (user: string, password: string, sql: string) => {
  const { client } = await connect(user, password);

  try {
    await client.query(sql);

    return 'allowed';
  } catch (error) {
    return `denied:${(error as { code?: string }).code}`;
  } finally {
    await client.end();
  }
};

describe.skipIf(adminUrl === '')('migration runner integration', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();

    await admin.query(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      DROP ROLE IF EXISTS ${MIGRATOR_USER};
      DROP ROLE IF EXISTS ${RUNTIME_USER};
      CREATE ROLE ${MIGRATOR_USER} LOGIN PASSWORD ${sqlLiteral(migratorPassword)};
      CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD ${sqlLiteral(runtimePassword)};
      CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${MIGRATOR_USER};
      GRANT USAGE, CREATE ON SCHEMA ${SCHEMA} TO ${MIGRATOR_USER};
      GRANT USAGE ON SCHEMA ${SCHEMA} TO ${RUNTIME_USER};
    `);

    // The SPEC 03 contract: tables created by the migrator inherit DML grants
    // for the runtime role, so the history table must strip them explicitly.
    await admin.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_USER} IN SCHEMA ${SCHEMA}
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_USER};
    `);
  });

  afterAll(async () => {
    await admin.query(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      DROP ROLE IF EXISTS ${RUNTIME_USER};
      DROP ROLE IF EXISTS ${MIGRATOR_USER};
    `);
    await admin.end();
  });

  it('creates the history table with no runtime privileges and the reviewed structure', async () => {
    const migrator = await connect(MIGRATOR_USER, migratorPassword);

    try {
      await createHistoryTable(migrator.queryable, SCHEMA, RUNTIME_USER);

      expect(
        await validateHistoryTableStructure(migrator.queryable, SCHEMA),
      ).toEqual({ ok: true });
      expect(
        await verifyHistoryProtection(
          migrator.queryable,
          SCHEMA,
          MIGRATOR_USER,
          RUNTIME_USER,
        ),
      ).toEqual({ ok: true });

      const effective = await migrator.client.query(
        `SELECT p.privilege,
                has_table_privilege($2, $1, p.privilege) AS runtime
           FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)`,
        [TABLE, RUNTIME_USER],
      );

      for (const row of effective.rows) {
        expect({ privilege: row.privilege, runtime: row.runtime }).toEqual({
          privilege: row.privilege,
          runtime: false,
        });
      }
    } finally {
      await migrator.client.end();
    }

    expect(
      await attempt(
        RUNTIME_USER,
        runtimePassword,
        `INSERT INTO ${TABLE} (migration_id, checksum_sha256, commit_sha, run_id, application_mode) VALUES ('000001', '${'a'.repeat(64)}', '${'b'.repeat(40)}', 'run-1', 'applied')`,
      ),
    ).toBe('denied:42501');
    expect(
      await attempt(RUNTIME_USER, runtimePassword, `DELETE FROM ${TABLE}`),
    ).toBe('denied:42501');
    expect(
      await attempt(RUNTIME_USER, runtimePassword, `TRUNCATE ${TABLE}`),
    ).toBe('denied:42501');
    expect(
      await attempt(
        RUNTIME_USER,
        runtimePassword,
        `ALTER TABLE ${TABLE} ADD COLUMN extra text`,
      ),
    ).toBe('denied:42501');
  });

  it('rejects a history table that drifted from the reviewed structure', async () => {
    const migrator = await connect(MIGRATOR_USER, migratorPassword);

    try {
      await migrator.client.query(`
        CREATE TABLE ${SCHEMA}.drifted_history (
          migration_id text PRIMARY KEY,
          checksum_sha256 text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now(),
          commit_sha text NOT NULL,
          run_id text NOT NULL,
          application_mode text NOT NULL,
          approval_reference text,
          schema_fingerprint text
        )
      `);

      expect(
        await validateHistoryTableStructure(
          migrator.queryable,
          SCHEMA,
          'drifted_history',
        ),
      ).toMatchObject({
        ok: false,
        reason: 'the history column checksum_sha256 has an unexpected type',
      });
    } finally {
      await migrator.client.query(
        `DROP TABLE IF EXISTS ${SCHEMA}.drifted_history`,
      );
      await migrator.client.end();
    }
  });

  it('rejects a permissive application_mode check on a real table', async () => {
    const migrator = await connect(MIGRATOR_USER, migratorPassword);

    try {
      await migrator.client.query(`
        CREATE TABLE ${SCHEMA}.permissive_history (
          migration_id text NOT NULL PRIMARY KEY,
          checksum_sha256 char(64) NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now(),
          commit_sha text NOT NULL,
          run_id text NOT NULL,
          application_mode text NOT NULL,
          approval_reference text,
          schema_fingerprint text,
          CONSTRAINT permissive_history_mode CHECK (
            application_mode IN ('applied', 'baseline_verified')
            OR application_mode LIKE '%'
          )
        )
      `);

      expect(
        await validateHistoryTableStructure(
          migrator.queryable,
          SCHEMA,
          'permissive_history',
        ),
      ).toMatchObject({
        ok: false,
        reason:
          'the history table application_mode check does not match the reviewed values',
      });
    } finally {
      await migrator.client.query(
        `DROP TABLE IF EXISTS ${SCHEMA}.permissive_history`,
      );
      await migrator.client.end();
    }
  });

  it('cancels a real statement at the operation deadline', async () => {
    const config: MigrationConfig = {
      database: {
        host: new URL(adminUrl).hostname,
        port: Number(new URL(adminUrl).port),
        name: new URL(adminUrl).pathname.replace(/^\//, ''),
        sslMode: 'disable',
        caPath: null,
      },
      user: MIGRATOR_USER,
      runtimeUser: RUNTIME_USER,
      schema: SCHEMA,
      credentialSecretArn: 'arn:not-used',
      timeouts: {
        connectSeconds: 5,
        lockSeconds: 7,
        statementSeconds: 120,
        operationSeconds: 300,
        lambdaSeconds: 600,
      },
    };
    const budget = createOperationBudget({
      now: () => Date.now(),
      configuredMs: 1_200,
      invocationRemainingMs: null,
      cleanupMarginMs: 0,
    });
    const connected = await connectToDatabase(
      config,
      { username: MIGRATOR_USER, password: migratorPassword },
      budget,
    );

    expect(connected.ok).toBe(true);

    if (!connected.ok) {
      return;
    }

    try {
      const bounded = budgetedConnection(connected.connection, budget, {
        statementTimeoutMs: 120_000,
      });
      const started = Date.now();

      await expect(bounded.query('SELECT pg_sleep(5)')).rejects.toBeInstanceOf(
        OperationBudgetExhaustedError,
      );

      const elapsed = Date.now() - started;
      const remaining = Number(
        (
          await connected.connection.query(
            `SELECT EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000
                    AS statement_timeout_ms`,
          )
        ).rows[0]?.statement_timeout_ms,
      );

      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      expect(elapsed).toBeLessThan(4_000);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(120_000);
    } finally {
      await connected.connection.close();
    }
  });

  it('accepts valid rows, rejects malformed ones, and digests deterministically', async () => {
    const migrator = await connect(MIGRATOR_USER, migratorPassword);
    const manifest = manifestFixture(['000001', '000002']);
    const first = manifest.migrations[0]?.sha256 as string;

    try {
      await migrator.client.query(
        `INSERT INTO ${TABLE} (migration_id, checksum_sha256, commit_sha, run_id, application_mode) VALUES ($1, $2, $3, $4, $5)`,
        ['000001', first, 'b'.repeat(40), 'run-1', 'applied'],
      );

      const rows = await readHistory(migrator.queryable, SCHEMA);
      const digest = historyDigest(rows);

      expect(rows).toHaveLength(1);
      expect(verifyHistory(rows, manifest)).toEqual({
        ok: true,
        appliedIds: ['000001'],
        pendingIds: ['000002'],
      });
      expect(historyDigest(await readHistory(migrator.queryable, SCHEMA))).toBe(
        digest,
      );

      await migrator.client.query(`SET TIME ZONE 'America/New_York'`);
      expect(historyDigest(await readHistory(migrator.queryable, SCHEMA))).toBe(
        digest,
      );
      await migrator.client.query(`SET TIME ZONE 'UTC'`);

      // An adopted row without approval evidence is stored happily by the
      // database and must be rejected by the reader.
      await migrator.client.query(
        `INSERT INTO ${TABLE} (migration_id, checksum_sha256, commit_sha, run_id, application_mode) VALUES ($1, $2, $3, $4, 'baseline_verified')`,
        [
          '000002',
          manifest.migrations[1]?.sha256 as string,
          'b'.repeat(40),
          'run-2',
        ],
      );

      expect(
        verifyHistory(await readHistory(migrator.queryable, SCHEMA), manifest),
      ).toMatchObject({
        ok: false,
        reason: 'history contains a malformed row',
      });

      await expect(
        migrator.client.query(
          `UPDATE ${TABLE} SET application_mode = 'unsupported' WHERE migration_id = '000001'`,
        ),
      ).rejects.toMatchObject({ code: '23514' });

      await migrator.client.query(
        `DELETE FROM ${TABLE} WHERE migration_id IN ('000001', '000002')`,
      );
    } finally {
      await migrator.client.end();
    }
  });

  it('bounds lock contention and recovers the lock when a connection dies', async () => {
    const key = advisoryLockKey('gootip_migrations', SCHEMA);
    const holder = await connect(MIGRATOR_USER, migratorPassword);
    const waiter = await connect(MIGRATOR_USER, migratorPassword);

    // The killed backend surfaces as a socket error; it must not become an
    // uncaught exception in the test run.
    holder.client.on('error', () => undefined);

    try {
      expect(
        await acquireSessionLock(holder.queryable, key, { timeoutMs: 5000 }),
      ).toEqual({ ok: true });

      expect(
        await acquireSessionLock(waiter.queryable, key, { timeoutMs: 1000 }),
      ).toEqual({ ok: false, errorCode: 'lock_timeout' });

      expect(await releaseSessionLock(holder.queryable, key)).toBe(true);
      expect(
        await acquireSessionLock(waiter.queryable, key, { timeoutMs: 5000 }),
      ).toEqual({ ok: true });
      expect(await releaseSessionLock(waiter.queryable, key)).toBe(true);

      expect(
        await acquireSessionLock(holder.queryable, key, { timeoutMs: 5000 }),
      ).toEqual({ ok: true });

      // A terminated Lambda cannot be assumed to run `finally`: PostgreSQL must
      // drop the session lock when the backend disappears.
      const holderPid = Number(
        (await holder.client.query('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid,
      );

      await admin.query('SELECT pg_terminate_backend($1)', [holderPid]);
      await expect(
        acquireSessionLock(waiter.queryable, key, {
          timeoutMs: 5000,
          pollIntervalMs: 100,
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await holder.client.end().catch(() => undefined);
      await waiter.client.end().catch(() => undefined);
    }
  });

  it('applies the reviewed session timeouts to a real connection', async () => {
    const config: MigrationConfig = {
      database: {
        host: new URL(adminUrl).hostname,
        port: Number(new URL(adminUrl).port),
        name: new URL(adminUrl).pathname.replace(/^\//, ''),
        sslMode: 'disable',
        caPath: null,
      },
      user: MIGRATOR_USER,
      runtimeUser: RUNTIME_USER,
      schema: SCHEMA,
      credentialSecretArn: 'arn:not-used',
      timeouts: {
        connectSeconds: 5,
        lockSeconds: 7,
        statementSeconds: 11,
        operationSeconds: 300,
        lambdaSeconds: 600,
      },
    };

    const connected = await connectToDatabase(
      config,
      {
        username: MIGRATOR_USER,
        password: migratorPassword,
      },
      createOperationBudget({
        now: () => Date.now(),
        configuredMs: 300_000,
        invocationRemainingMs: null,
        cleanupMarginMs: 0,
      }),
    );

    expect(connected.ok).toBe(true);

    if (!connected.ok) {
      return;
    }

    try {
      const row = (
        await connected.connection.query(
          `SELECT current_setting('statement_timeout') AS statement_timeout,
                  current_setting('lock_timeout') AS lock_timeout`,
        )
      ).rows[0];

      expect(String(row?.statement_timeout)).toBe('11s');
      expect(String(row?.lock_timeout)).toBe('7s');
    } finally {
      await connected.connection.close();
    }
  });

  describe('reviewed application', () => {
    const migrationsDirectory = fileURLToPath(
      new URL('../migrations', import.meta.url),
    );
    const loaded = loadMigrationBundle(migrationsDirectory);

    if (!loaded.ok) {
      throw new Error('the committed migrations directory must be valid');
    }

    const bundle = loaded.bundle;
    const initialEntry = bundle.manifest.migrations[0] as {
      id: string;
      file: string;
      sha256: string;
    };

    const sessionConnection = (
      client: Client,
      budget: OperationBudget,
    ): MigrationConnection =>
      budgetedConnection(
        {
          query: async (text, values) => {
            const result = await client.query(
              text,
              values ? [...values] : undefined,
            );

            return { rows: result.rows as Record<string, unknown>[] };
          },
          close: async () => undefined,
        },
        budget,
        { statementTimeoutMs: 120_000 },
      );

    const context = (budget: OperationBudget): MigrationSessionContext => ({
      schema: SCHEMA,
      migratorUser: MIGRATOR_USER,
      runtimeUser: RUNTIME_USER,
      lockKey: advisoryLockKey(
        new URL(adminUrl).pathname.replace(/^\//, ''),
        SCHEMA,
      ),
      lockTimeoutMs: 2_000,
      budget,
    });

    const request = {
      operation: 'apply' as const,
      run_id: 'run-9',
      commit_sha: 'b'.repeat(40),
      expected_manifest_sha256: 'c'.repeat(64),
    };

    const budget = (): OperationBudget =>
      createOperationBudget({
        now: () => Date.now(),
        configuredMs: 300_000,
        invocationRemainingMs: null,
        cleanupMarginMs: 0,
      });

    const relationNames = async (client: Client): Promise<string[]> => {
      const result = await client.query(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'r'
          ORDER BY c.relname`,
        [SCHEMA],
      );

      return result.rows.map((row) => String(row.relname));
    };

    const resetTables = async (
      client: Client,
      tables: string[],
    ): Promise<void> => {
      await client.query(
        `DROP TABLE IF EXISTS ${tables.map((table) => `${SCHEMA}.${table}`).join(', ')} CASCADE`,
      );
    };

    /**
     * Drops every relation in the schema so a baseline test starts from the
     * administrative bootstrap state regardless of what ran before it.
     */
    const resetSchema = async (client: Client): Promise<void> => {
      const result = await client.query(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'v', 'm', 'f')`,
        [SCHEMA],
      );

      if (result.rows.length === 0) {
        return;
      }

      await client.query(
        `DROP TABLE ${result.rows
          .map((row) => `${SCHEMA}."${String(row.relname)}"`)
          .join(', ')} CASCADE`,
      );
    };

    const applyReviewedStructure = async (client: Client): Promise<void> => {
      const sql = bundle.sql.get(initialEntry.file);

      if (sql === undefined) {
        throw new Error('the reviewed initial SQL must be bundled');
      }

      await client.query(sql);
    };

    const baselineRequest = (
      overrides: Partial<MigrationRequest> = {},
    ): MigrationRequest => ({
      ...request,
      operation: 'baseline_adopt',
      approval_reference: 'OPS-2026-04',
      expected_schema_fingerprint: bundle.manifest.initial_schema_fingerprint,
      expected_history_sha256: historyDigest([]),
      ...overrides,
    });

    it('applies the reviewed migration, records it once, and then reports no_changes', async () => {
      await resetTables(admin, [
        'gootip_schema_migrations',
        '"user"',
        'session',
        'account',
        'verification',
        'jwks',
      ]);

      const migrator = await connect(MIGRATOR_USER, migratorPassword);
      const operationBudget = budget();
      const connection = sessionConnection(migrator.client, operationBudget);

      try {
        const first = await runMigrationSession(
          connection,
          request,
          { manifest: bundle.manifest, sql: bundle.sql },
          context(operationBudget),
        );

        expect(first).toMatchObject({
          status: 'succeeded',
          errorCode: null,
          appliedIds: bundle.manifest.migrations.map(
            (migration) => migration.id,
          ),
          pendingIds: [],
        });

        const rows = await readHistory(migrator.queryable, SCHEMA);

        expect(rows).toHaveLength(bundle.manifest.migrations.length);
        expect(rows[0]).toMatchObject({
          migration_id: initialEntry.id,
          checksum_sha256: initialEntry.sha256,
          commit_sha: request.commit_sha,
          run_id: request.run_id,
          application_mode: 'applied',
          approval_reference: null,
          schema_fingerprint: null,
        });
        expect(rows.map((row) => row.migration_id)).toEqual(
          bundle.manifest.migrations.map((migration) => migration.id),
        );
        expect(await relationNames(migrator.client)).toEqual([
          'account',
          'gootip_schema_migrations',
          'jwks',
          'rateLimit',
          'session',
          'user',
          'verification',
        ]);

        const second = await runMigrationSession(
          connection,
          request,
          { manifest: bundle.manifest, sql: bundle.sql },
          context(operationBudget),
        );

        expect(second).toMatchObject({
          status: 'no_changes',
          errorCode: null,
          appliedIds: bundle.manifest.migrations.map(
            (migration) => migration.id,
          ),
          pendingIds: [],
        });
        expect(await readHistory(migrator.queryable, SCHEMA)).toHaveLength(
          bundle.manifest.migrations.length,
        );
      } finally {
        await migrator.client.end();
      }
    });

    it('requires reviewed baseline approval and revalidates it before adoption', async () => {
      await resetSchema(admin);
      const migrator = await connect(MIGRATOR_USER, migratorPassword);
      const operationBudget = budget();
      const connection = sessionConnection(migrator.client, operationBudget);

      try {
        // This represents the existing reviewed Better Auth structure before
        // migration history was introduced; normal apply must not re-run it.
        await applyReviewedStructure(migrator.client);

        const apply = await runMigrationSession(
          connection,
          request,
          { manifest: bundle.manifest, sql: bundle.sql },
          context(operationBudget),
        );
        expect(apply).toMatchObject({
          status: 'baseline_approval_required',
          errorCode: null,
          pendingIds: bundle.manifest.migrations.map(
            (migration) => migration.id,
          ),
        });
        expect(await relationNames(migrator.client)).not.toContain(
          'gootip_schema_migrations',
        );

        const check = await runMigrationSession(
          connection,
          { ...request, operation: 'baseline_check' },
          { manifest: bundle.manifest, sql: bundle.sql },
          context(operationBudget),
        );
        expect(check).toMatchObject({
          status: 'succeeded',
          pendingIds: bundle.manifest.migrations.map(
            (migration) => migration.id,
          ),
        });

        // A structural change after a successful check simulates a race with
        // the operator review; adoption must re-check under the held lock.
        await migrator.client.query(
          `ALTER TABLE ${SCHEMA}."user" ADD COLUMN raced_after_review text`,
        );
        const raced = await runMigrationSession(
          connection,
          baselineRequest(),
          { manifest: bundle.manifest, sql: bundle.sql },
          context(operationBudget),
        );
        expect(raced).toMatchObject({
          status: 'failed',
          errorCode: 'baseline_mismatch',
        });
        expect(await relationNames(migrator.client)).not.toContain(
          'gootip_schema_migrations',
        );

        await migrator.client.query(
          `ALTER TABLE ${SCHEMA}."user" DROP COLUMN raced_after_review`,
        );
        const adopted = await runMigrationSession(
          connection,
          baselineRequest(),
          { manifest: bundle.manifest, sql: bundle.sql },
          context(operationBudget),
        );
        expect(adopted).toMatchObject({
          status: 'succeeded',
          appliedIds: [initialEntry.id],
          pendingIds: bundle.manifest.migrations
            .slice(1)
            .map((migration) => migration.id),
        });
        expect(await readHistory(migrator.queryable, SCHEMA)).toMatchObject([
          {
            migration_id: initialEntry.id,
            application_mode: 'baseline_verified',
            approval_reference: 'OPS-2026-04',
            schema_fingerprint: bundle.manifest.initial_schema_fingerprint,
          },
        ]);

        const repeated = await runMigrationSession(
          connection,
          baselineRequest(),
          { manifest: bundle.manifest, sql: bundle.sql },
          context(operationBudget),
        );
        expect(repeated).toMatchObject({
          status: 'failed',
          errorCode: 'history_invalid',
        });
      } finally {
        await migrator.client.end();
      }
    });

    it('rolls back a partially executed file, keeps earlier commits, and retries from the committed prefix', async () => {
      await resetSchema(admin);

      const firstSql = `create table ${SCHEMA}.partial_one (id int primary key);\n`;
      const secondSql = `create table ${SCHEMA}.partial_two (id int primary key);\ninsert into ${SCHEMA}.missing_table values (1);\n`;
      const manifest = manifestFixture(
        ['000001', '000002'],
        [sha256Hex(firstSql), sha256Hex(secondSql)],
      );
      const source = {
        manifest,
        sql: new Map([
          [manifest.migrations[0]?.file as string, firstSql],
          [manifest.migrations[1]?.file as string, secondSql],
        ]),
      };
      const migrator = await connect(MIGRATOR_USER, migratorPassword);
      const operationBudget = budget();
      const connection = sessionConnection(migrator.client, operationBudget);

      try {
        const outcome = await runMigrationSession(
          connection,
          request,
          source,
          context(operationBudget),
        );

        expect(outcome).toMatchObject({
          status: 'failed',
          errorCode: 'sql_failed',
          appliedIds: ['000001'],
          pendingIds: ['000002'],
        });

        const rows = await readHistory(migrator.queryable, SCHEMA);

        expect(rows.map((row) => row.migration_id)).toEqual(['000001']);

        const relations = await relationNames(migrator.client);

        expect(relations).toContain('partial_one');
        expect(relations).not.toContain('partial_two');

        const retry = await runMigrationSession(
          connection,
          request,
          source,
          context(operationBudget),
        );

        expect(retry).toMatchObject({
          status: 'failed',
          errorCode: 'sql_failed',
          appliedIds: [],
          pendingIds: ['000002'],
        });
        expect(await readHistory(migrator.queryable, SCHEMA)).toHaveLength(1);
      } finally {
        await migrator.client.end();
      }
    });

    it('rejects transaction-control and concurrent SQL without applying it', async () => {
      await resetSchema(admin);

      const sql = `create table ${SCHEMA}.policy_denied (id int);\nbegin;\ncreate index concurrently policy_denied_idx on ${SCHEMA}.policy_denied (id);\n`;
      const manifest = manifestFixture(['000001'], [sha256Hex(sql)]);
      const source = {
        manifest,
        sql: new Map([[manifest.migrations[0]?.file as string, sql]]),
      };
      const migrator = await connect(MIGRATOR_USER, migratorPassword);
      const operationBudget = budget();
      const connection = sessionConnection(migrator.client, operationBudget);

      try {
        const outcome = await runMigrationSession(
          connection,
          request,
          source,
          context(operationBudget),
        );

        expect(outcome).toMatchObject({
          status: 'failed',
          errorCode: 'sql_policy_violation',
          appliedIds: [],
          pendingIds: ['000001'],
        });
        expect(await readHistory(migrator.queryable, SCHEMA)).toEqual([]);
        expect(await relationNames(migrator.client)).not.toContain(
          'policy_denied',
        );
      } finally {
        await migrator.client.end();
      }
    });
  });

  it('reads an empty history as nothing applied', async () => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`,
    );
    await admin.query(
      `GRANT USAGE, CREATE ON SCHEMA ${SCHEMA} TO ${MIGRATOR_USER};`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${RUNTIME_USER};`);
    const migrator = await connect(MIGRATOR_USER, migratorPassword);

    try {
      await createHistoryTable(migrator.queryable, SCHEMA, RUNTIME_USER);
      expect(await readHistory(migrator.queryable, SCHEMA)).toEqual([]);
      expect(verifyHistory([], manifestFixture(['000001']))).toEqual({
        ok: true,
        appliedIds: [],
        pendingIds: ['000001'],
      });
      expect(historyDigest([])).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await migrator.client.end();
    }
  });
});
