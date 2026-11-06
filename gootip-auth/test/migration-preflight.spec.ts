import { describe, expect, it } from 'vitest';

import {
  verifyMigrationIdentity,
  type MigrationIdentity,
} from '../src/migration-runner/preflight.js';
import type { Queryable } from '../src/migration-runner/schema-descriptor.js';

const identity: MigrationIdentity = {
  user: 'auth_migrator',
  database: 'gootip',
  schema: 'auth',
};

const identityRow = (overrides: Record<string, unknown> = {}) => ({
  current_user: 'auth_migrator',
  session_user: 'auth_migrator',
  current_database: 'gootip',
  is_superuser: false,
  can_create_role: false,
  can_create_db: false,
  bypass_rls: false,
  can_replicate: false,
  ...overrides,
});

const schemaRow = (overrides: Record<string, unknown> = {}) => ({
  can_create_schema: true,
  can_use_schema: true,
  can_create_database_objects: false,
  ...overrides,
});

const scriptedQueryable = (
  rows: readonly (readonly Record<string, unknown>[])[],
): { queryable: Queryable; issued: () => number } => {
  const queue = [...rows];
  let count = 0;

  return {
    issued: () => count,
    queryable: {
      query: async () => {
        count += 1;
        const next = queue.shift();

        if (!next) {
          throw new Error('unexpected query');
        }

        return { rows: next };
      },
    },
  };
};

const run = async (
  rows: readonly (readonly Record<string, unknown>[])[],
  overrides: Partial<MigrationIdentity> = {},
) => {
  const scripted = scriptedQueryable(rows);

  return {
    issued: scripted.issued,
    outcome: await verifyMigrationIdentity(scripted.queryable, {
      ...identity,
      ...overrides,
    }),
  };
};

describe('verifyMigrationIdentity', () => {
  it('accepts the reviewed migrator identity and grants', async () => {
    const { outcome } = await run([[identityRow()], [], [schemaRow()], []]);

    expect(outcome).toEqual({ ok: true });
  });

  it('rejects a connection made with the runtime role', async () => {
    const { outcome, issued } = await run([
      [
        identityRow({
          current_user: 'auth_runtime',
          session_user: 'auth_runtime',
        }),
      ],
    ]);

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'database_identity_mismatch',
    });
    expect(issued()).toBe(1);
  });

  it('rejects a master-like privileged role', async () => {
    const { outcome } = await run([[identityRow({ is_superuser: true })]]);

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'database_identity_mismatch',
    });
  });

  it('rejects administration-role membership', async () => {
    const { outcome } = await run([
      [identityRow()],
      [{ name: 'rds_superuser' }],
    ]);

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'database_identity_mismatch',
    });
  });

  it('rejects a switched session role and a wrong database', async () => {
    expect(
      (await run([[identityRow({ session_user: 'postgres' })]])).outcome,
    ).toMatchObject({ ok: false, errorCode: 'database_identity_mismatch' });
    expect(
      (await run([[identityRow({ current_database: 'other' })]])).outcome,
    ).toMatchObject({ ok: false, errorCode: 'database_identity_mismatch' });
  });

  it('rejects a migrator without schema DDL privileges', async () => {
    const { outcome } = await run([
      [identityRow()],
      [],
      [schemaRow({ can_create_schema: false })],
    ]);

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'privilege_mismatch',
    });
  });

  it('rejects a migrator that can create schemas in the database', async () => {
    const { outcome } = await run([
      [identityRow()],
      [],
      [schemaRow({ can_create_database_objects: true })],
    ]);

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'privilege_mismatch',
    });
  });

  it('rejects cross-schema grants on another schema', async () => {
    const { outcome } = await run([
      [identityRow()],
      [],
      [schemaRow()],
      [{ name: 'public' }],
    ]);

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'privilege_mismatch',
    });
  });
});
