import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const adminUrl = process.env.SPEC09_ROTATION_ADMIN_URL ?? '';
const initialPassword = process.env.SPEC09_ROTATION_CORE_PASSWORD ?? '';
const otherPassword = process.env.SPEC09_ROTATION_AUTH_PASSWORD ?? '';
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const assertDisposableTarget = () => {
  const url = new URL(adminUrl);
  if (
    url.protocol !== 'postgres:' ||
    url.hostname !== '127.0.0.1' ||
    url.username !== 'spec09_admin' ||
    url.pathname !== '/postgres' ||
    !url.port ||
    !initialPassword ||
    !otherPassword
  ) {
    throw new Error(
      'SPEC 09 rotation tests require the disposable local PostgreSQL runner',
    );
  }
};

describe.skipIf(!adminUrl || !initialPassword || !otherPassword)(
  'Core runtime credential rotation against disposable PostgreSQL',
  () => {
    let admin: Client;
    const database = 'gootip_test_core_rotation';

    beforeAll(async () => {
      assertDisposableTarget();
      admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(
        'DROP DATABASE IF EXISTS gootip_test_auth_rotation WITH (FORCE)',
      );
      await admin.query('DROP ROLE IF EXISTS core_runtime');
      await admin.query('DROP ROLE IF EXISTS auth_runtime');
      await admin.query(
        `CREATE ROLE core_runtime LOGIN PASSWORD ${quoteLiteral(initialPassword)}`,
      );
      await admin.query(`CREATE DATABASE ${database}`);
      await admin.query('CREATE DATABASE gootip_test_auth_rotation');
      await admin.query(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`);
      await admin.query(
        'REVOKE CONNECT ON DATABASE gootip_test_auth_rotation FROM PUBLIC',
      );
      await admin.query(
        `GRANT CONNECT ON DATABASE ${database} TO core_runtime`,
      );
      await admin.query(
        `CREATE ROLE auth_runtime LOGIN PASSWORD ${quoteLiteral(otherPassword)}`,
      );
      await admin.query(
        'GRANT CONNECT ON DATABASE gootip_test_auth_rotation TO auth_runtime',
      );
    });

    afterAll(async () => {
      if (!admin) return;
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(
        'DROP DATABASE IF EXISTS gootip_test_auth_rotation WITH (FORCE)',
      );
      await admin.query('DROP ROLE IF EXISTS core_runtime');
      await admin.query('DROP ROLE IF EXISTS auth_runtime');
      await admin.end();
    });

    it('requires a fresh connection to validate a changed password and recovers from a mismatch', async () => {
      const connect = (password: string) => {
        const url = new URL(adminUrl);
        return new Client({
          host: url.hostname,
          port: Number(url.port),
          database,
          user: 'core_runtime',
          password,
        });
      };
      const oldConnection = connect(initialPassword);
      await oldConnection.connect();
      expect(
        (await oldConnection.query('SELECT current_user AS identity')).rows[0]
          ?.identity,
      ).toBe('core_runtime');

      const crossService = new Client({
        host: new URL(adminUrl).hostname,
        port: Number(new URL(adminUrl).port),
        database: 'gootip_test_auth_rotation',
        user: 'core_runtime',
        password: initialPassword,
      });
      await expect(crossService.connect()).rejects.toBeDefined();
      await crossService.end().catch(() => undefined);

      const nextPassword = `${initialPassword}-next`;
      await admin.query(
        `ALTER ROLE core_runtime PASSWORD ${quoteLiteral(nextPassword)}`,
      );

      const stale = connect(initialPassword);
      await expect(stale.connect()).rejects.toBeDefined();
      await stale.end().catch(() => undefined);
      expect(
        (await oldConnection.query('SELECT 1 AS existing_session')).rows[0]
          ?.existing_session,
      ).toBe(1);

      const mismatch = connect(`${nextPassword}-wrong`);
      await expect(mismatch.connect()).rejects.toBeDefined();
      await mismatch.end().catch(() => undefined);

      const recovered = connect(nextPassword);
      await recovered.connect();
      expect(
        (await recovered.query('SELECT current_user AS identity')).rows[0]
          ?.identity,
      ).toBe('core_runtime');

      const activity = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE usename = 'core_runtime' AND datname = $1",
        [database],
      );
      expect(Number(activity.rows[0]?.count)).toBe(2);
      const authPeer = new Client({
        host: new URL(adminUrl).hostname,
        port: Number(new URL(adminUrl).port),
        database: 'gootip_test_auth_rotation',
        user: 'auth_runtime',
        password: otherPassword,
      });
      await authPeer.connect();
      const peak = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE usename IN ('auth_runtime', 'core_runtime')",
      );
      expect(Number(peak.rows[0]?.count)).toBe(3);
      await Promise.all([oldConnection.end(), recovered.end(), authPeer.end()]);
      const afterClose = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE usename IN ('auth_runtime', 'core_runtime')",
      );
      expect(Number(afterClose.rows[0]?.count)).toBe(0);
    });
  },
);
