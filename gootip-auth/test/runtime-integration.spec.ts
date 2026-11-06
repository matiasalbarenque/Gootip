/**
 * Focused SPEC 05 runtime proof against disposable PostgreSQL.
 *
 * Set `AUTH_RUNTIME_TEST_DATABASE_URL` to the admin URL for the shared server's
 * `gootip_test_auth_runtime` database. The
 * suite provisions the SPEC 03 role/schema contract, applies the reviewed auth
 * migration as a namespaced migrator, creates the migration history table, and
 * exercises Better Auth using the namespaced test runtime role. The production
 * loader is separately checked against its fixed `auth_runtime` identity.
 *
 * Without the variable every case skips cleanly, so the ordinary unit run needs
 * no database. It only drops and recreates its own `test_auth_runtime_*` roles
 * and the `auth` schema inside its exact isolated database.
 */
import { readFile } from 'node:fs/promises';

import type { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createAuth, createPostgresPool } from '../src/auth/auth.js';
import { readEnv } from '../src/config/env.js';
import { loadSecretsToEnv, RUNTIME_DB_USERNAME } from '../src/lambda.js';
import {
  createHistoryTable,
  historyTableName,
} from '../src/migration-runner/history.js';
import type { Queryable } from '../src/migration-runner/schema-descriptor.js';
import {
  requiredTestPassword,
  sqlLiteral,
  suiteDatabaseUrl,
} from './local-postgres.js';

const TEST_DATABASE = 'gootip_test_auth_runtime';
const MIGRATOR_USER = 'test_auth_runtime_migrator';
const TEST_RUNTIME_USER = 'test_auth_runtime_runtime';
const adminUrl = suiteDatabaseUrl(
  'AUTH_RUNTIME_TEST_DATABASE_URL',
  TEST_DATABASE,
);
const MIGRATOR_PASSWORD = adminUrl
  ? requiredTestPassword('TEST_AUTH_RUNTIME_MIGRATOR_PASSWORD')
  : '';
const RUNTIME_PASSWORD = adminUrl
  ? requiredTestPassword('TEST_AUTH_RUNTIME_RUNTIME_PASSWORD')
  : '';
const SCHEMA = 'auth';
const AUTH_SECRET = 'r'.repeat(48);
const APP_SECRET_ID = 'app-secret';
const RUNTIME_SECRET_ID = 'runtime-secret';

/** The stub answers both ARNs the Lambda loader reads, and nothing else. */
const secretsFor =
  (username: string) => async (command: GetSecretValueCommand) => ({
    SecretString:
      command.input.SecretId === APP_SECRET_ID
        ? JSON.stringify({ BETTER_AUTH_SECRET: AUTH_SECRET })
        : JSON.stringify({ username, password: RUNTIME_PASSWORD }),
    VersionId:
      command.input.SecretId === APP_SECRET_ID ? 'signing-v1' : 'db-v1',
  });

const send = secretsFor(RUNTIME_DB_USERNAME);

const readTestEnv = () =>
  readEnv({
    ...process.env,
    POSTGRES_DB_USER: TEST_RUNTIME_USER,
    POSTGRES_DB_PASSWORD: RUNTIME_PASSWORD,
  });

const databaseParts = () => {
  const url = new URL(adminUrl);

  return {
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.replace(/^\//, ''),
  };
};

const asRole = async (user: string, password?: string): Promise<Client> => {
  const client = new Client({ ...databaseParts(), user, password });

  await client.connect();

  return client;
};

const queryableFrom = (client: Client): Queryable => ({
  query: async (text, values) => {
    const result = await client.query(text, values ? [...values] : undefined);

    return { rows: result.rows as Record<string, unknown>[] };
  },
});

/** Returns `allowed` or the PostgreSQL SQLSTATE that refused the statement. */
const attempt = async (client: Client, sql: string): Promise<string> => {
  try {
    await client.query(sql);

    return 'allowed';
  } catch (error) {
    return `denied:${(error as { code?: string }).code}`;
  }
};

describe.skipIf(adminUrl === '')(
  'runtime integration against disposable PostgreSQL',
  () => {
    let admin: Client;
    let runtime: Client;
    const pools: Pool[] = [];

    beforeAll(async () => {
      admin = new Client({ connectionString: adminUrl });
      await admin.connect();

      await admin.query(`
        DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
        DROP TABLE IF EXISTS public.master_only;
        DROP ROLE IF EXISTS ${MIGRATOR_USER};
        DROP ROLE IF EXISTS ${TEST_RUNTIME_USER};
        CREATE ROLE ${MIGRATOR_USER} LOGIN PASSWORD ${sqlLiteral(MIGRATOR_PASSWORD)};
        CREATE ROLE ${TEST_RUNTIME_USER} LOGIN PASSWORD ${sqlLiteral(RUNTIME_PASSWORD)};
        CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${MIGRATOR_USER};
        GRANT USAGE, CREATE ON SCHEMA ${SCHEMA} TO ${MIGRATOR_USER};
        GRANT USAGE ON SCHEMA ${SCHEMA} TO ${TEST_RUNTIME_USER};
        CREATE TABLE public.master_only (id integer);
      `);

      // The SPEC 03 contract: tables the migrator creates inherit runtime DML,
      // which is why the history table has to strip those grants explicitly.
      await admin.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_USER} IN SCHEMA ${SCHEMA}
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${TEST_RUNTIME_USER};
      `);

      const migrator = await asRole(MIGRATOR_USER, MIGRATOR_PASSWORD);

      try {
        await migrator.query(
          await readFile(
            new URL('../migrations/000001-initial-auth.sql', import.meta.url),
            'utf8',
          ),
        );
        await migrator.query(
          await readFile(
            new URL(
              '../migrations/000002-auth-rate-limit.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        );
        await migrator.query(
          await readFile(
            new URL(
              '../migrations/000003-auth-admin-roles.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        );
        await createHistoryTable(
          queryableFrom(migrator),
          SCHEMA,
          TEST_RUNTIME_USER,
        );
      } finally {
        await migrator.end();
      }

      const { host, port, database } = databaseParts();
      process.env.SECRET_ARN = APP_SECRET_ID;
      process.env.DB_RUNTIME_SECRET_ARN = RUNTIME_SECRET_ID;
      process.env.POSTGRES_DB_HOST = host;
      process.env.POSTGRES_DB_PORT = String(port);
      process.env.POSTGRES_DB_NAME = database;
      process.env.POSTGRES_SSL_MODE = 'disable';
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      process.env.JWT_AUDIENCE = 'gootip-auth-dev';
      process.env.FRONTEND_URL = 'http://localhost:3000';
      delete process.env.POSTGRES_DB_USER;
      delete process.env.POSTGRES_DB_PASSWORD;
    });

    afterAll(async () => {
      await Promise.allSettled([
        ...pools.map((pool) => pool.end()),
        ...(runtime ? [runtime.end()] : []),
      ]);
      try {
        await admin.query(`
          DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
          DROP TABLE IF EXISTS public.master_only;
          DROP ROLE IF EXISTS ${MIGRATOR_USER};
          DROP ROLE IF EXISTS ${TEST_RUNTIME_USER};
        `);
      } finally {
        await admin.end();
      }
    });

    it('issues trusted catalog roles and restricts role assignment to admins', async () => {
      await loadSecretsToEnv({ send });
      const pool = createPostgresPool(readTestEnv());
      pools.push(pool);
      const auth = createAuth(readTestEnv(), pool);
      const password = 'isolated-role-test-password';
      const identities = new Map<string, { id: string; token: string }>();
      for (const role of ['user', 'editor', 'admin'] as const) {
        const email = `${role}-role-proof@example.com`;
        const { user } = await auth.api.createUser({
          body: { email, password, name: role, role },
        });
        const session = await auth.api.signInEmail({
          body: { email, password },
        });
        identities.set(role, { id: user.id, token: session.token! });
        const { token } = await auth.api.getToken({
          headers: new Headers({ authorization: `Bearer ${session.token}` }),
        });
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1]!, 'base64url').toString(),
        );
        expect(payload).toMatchObject({ sub: user.id, role });
        expect(payload).not.toHaveProperty('email');
      }
      const forgedSignup = await auth.handler(
        new Request('http://localhost:3000/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'signup-role-proof@example.com',
            password,
            name: 'Public signup',
            role: 'admin',
          }),
        }),
      );
      expect(forgedSignup.status).toBe(400);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM auth."user" WHERE email = $1',
            ['signup-role-proof@example.com'],
          )
        ).rows[0].count,
      ).toBe(0);
      const signup = await auth.api.signUpEmail({
        body: {
          email: 'signup-role-proof@example.com',
          password,
          name: 'Public signup',
        },
      });
      const signupRole = await pool.query<{ role: string }>(
        'SELECT role FROM auth."user" WHERE id = $1',
        [signup.user.id],
      );
      expect(signupRole.rows[0]?.role).toBe('user');
      const target = identities.get('user')!;
      for (const role of ['user', 'editor', 'admin']) {
        const response = await auth.handler(
          new Request('http://localhost:3000/api/auth/admin/set-role', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${identities.get(role)!.token}`,
            },
            body: JSON.stringify({ userId: target.id, role: 'editor' }),
          }),
        );
        expect(response.status).toBe(role === 'admin' ? 200 : 403);
      }
      expect(
        (
          await pool.query('SELECT role FROM auth."user" WHERE id = $1', [
            target.id,
          ])
        ).rows[0].role,
      ).toBe('editor');
    });

    it('lets the loader overwrite any configured credential with auth_runtime', async () => {
      process.env.POSTGRES_DB_USER = 'master-like-role';
      process.env.POSTGRES_DB_PASSWORD = 'stale-password';

      await loadSecretsToEnv({ send });

      expect(process.env.POSTGRES_DB_USER).toBe(RUNTIME_DB_USERNAME);
      expect(process.env.POSTGRES_DB_PASSWORD).toBe(RUNTIME_PASSWORD);
    });

    it('rejects a namespaced test identity in the production loader', async () => {
      await expect(
        loadSecretsToEnv({ send: secretsFor(TEST_RUNTIME_USER) }),
      ).rejects.toThrow('username must be auth_runtime');
    });

    it('inserts, updates, and deletes real auth rows as auth_runtime', async () => {
      const env = readTestEnv();
      const pool = createPostgresPool(env);
      pools.push(pool);

      const auth = createAuth(env, pool);
      const created = await auth.api.signUpEmail({
        body: {
          email: 'runtime-probe@example.com',
          password: 'a-sufficiently-long-password',
          name: 'Runtime Probe',
        },
      });

      expect(created.user.id).toBeTruthy();

      runtime = await asRole(TEST_RUNTIME_USER, RUNTIME_PASSWORD);

      const read = await runtime.query(
        'select "email" from auth."user" where "id" = $1',
        [created.user.id],
      );
      expect(read.rows).toEqual([{ email: 'runtime-probe@example.com' }]);

      const updated = await runtime.query(
        'update auth."user" set "name" = $1 where "id" = $2',
        ['Runtime Probe Updated', created.user.id],
      );
      expect(updated.rowCount).toBe(1);

      const deleted = await runtime.query(
        'delete from auth."user" where "id" = $1',
        [created.user.id],
      );
      expect(deleted.rowCount).toBe(1);
    });

    it('requires browser sign-in again after signing-secret rotation without deleting the persisted session', async () => {
      const env = readTestEnv();
      const previousSecret = env.BETTER_AUTH_SECRET;
      const currentSecret = `${previousSecret}-rotated`;
      const pool = createPostgresPool(env);
      pools.push(pool);
      const previousApp = createApp({
        auth: createAuth(env, pool),
        frontendURL: env.FRONTEND_URL,
        issuer: env.BETTER_AUTH_URL,
      });
      const email = `secret-rotation-${crypto.randomUUID()}@example.com`;
      const signUp = await previousApp.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          origin: env.BETTER_AUTH_URL,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password: 'a-sufficiently-long-password',
          name: 'Secret Rotation Probe',
        }),
      });
      expect(signUp.status).toBe(200);
      const cookieHeader = signUp.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';', 1)[0])
        .join('; ');
      expect(cookieHeader).not.toBe('');
      const created = (await signUp.json()) as { user: { id: string } };

      const previousSession = await previousApp.request(
        '/api/auth/get-session',
        { headers: { cookie: cookieHeader } },
      );
      expect(await previousSession.json()).toMatchObject({
        user: { id: created.user.id },
      });

      const currentApp = createApp({
        auth: createAuth({ ...env, BETTER_AUTH_SECRET: currentSecret }, pool, [
          { version: 2, value: currentSecret },
          { version: 1, value: previousSecret },
        ]),
        frontendURL: env.FRONTEND_URL,
        issuer: env.BETTER_AUTH_URL,
      });
      const rotatedSession = await currentApp.request('/api/auth/get-session', {
        headers: { cookie: cookieHeader },
      });
      expect(rotatedSession.status).toBe(200);
      expect(await rotatedSession.json()).toBeNull();
      const persistedSession = await admin.query(
        'select 1 from auth."session" where "userId" = $1 limit 1',
        [created.user.id],
      );
      expect(persistedSession.rowCount).toBe(1);
    });

    it('shares atomic sign-in admission and 429 responses across independent pools', async () => {
      const env = {
        ...readTestEnv(),
        AUTH_RATE_LIMIT_ENABLED: 'true' as const,
        AUTH_RATE_LIMIT_RULES: '/sign-in/email:300:3,/sign-up/email:300:3',
      };
      const poolA = createPostgresPool(env);
      const poolB = createPostgresPool(env);
      pools.push(poolA, poolB);
      const appA = createApp({
        auth: createAuth(env, poolA),
        frontendURL: env.FRONTEND_URL,
        issuer: env.BETTER_AUTH_URL,
      });
      const appB = createApp({
        auth: createAuth(env, poolB),
        frontendURL: env.FRONTEND_URL,
        issuer: env.BETTER_AUTH_URL,
      });
      const clientIp = '192.0.2.88';
      await admin.query('delete from auth."rateLimit" where key like $1', [
        `%${clientIp}%`,
      ]);

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) => {
          const app = index % 2 === 0 ? appA : appB;
          return app.request('/api/auth/sign-in/email', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-gootip-client-ip': clientIp,
            },
            body: JSON.stringify({
              email: 'atomic-probe@example.com',
              password: 'invalid',
            }),
          });
        }),
      );
      const denied = responses.filter((response) => response.status === 429);
      const admitted = responses.filter((response) => response.status !== 429);

      expect(admitted).toHaveLength(3);
      expect(denied).toHaveLength(7);
      for (const response of denied) {
        const retryAfter =
          response.headers.get('x-retry-after') ??
          response.headers.get('retry-after');
        expect(retryAfter).not.toBeNull();
        expect(Number(retryAfter)).toBeGreaterThan(0);
      }

      const differentIp = await appA.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gootip-client-ip': '192.0.2.91',
        },
        body: JSON.stringify({
          email: 'ip-isolation@example.com',
          password: 'invalid',
        }),
      });
      const differentPath = await appB.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gootip-client-ip': clientIp,
        },
        body: JSON.stringify({
          email: 'path-isolation@example.com',
          password: 'invalid',
          name: 'Probe',
        }),
      });
      expect(differentIp.status).not.toBe(429);
      expect(differentPath.status).not.toBe(429);
    });

    it('resets an expired counter and opportunistically removes older rows', async () => {
      const env = {
        ...readTestEnv(),
        AUTH_RATE_LIMIT_ENABLED: 'true' as const,
        AUTH_RATE_LIMIT_RULES: '/sign-in/email:2:1',
      };
      const pool = createPostgresPool(env);
      pools.push(pool);
      const app = createApp({
        auth: createAuth(env, pool),
        frontendURL: env.FRONTEND_URL,
        issuer: env.BETTER_AUTH_URL,
      });
      const clientIp = '192.0.2.89';
      const request = () =>
        app.request('/api/auth/sign-in/email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-gootip-client-ip': clientIp,
          },
          body: JSON.stringify({
            email: 'expiry-probe@example.com',
            password: 'invalid',
          }),
        });

      await admin.query('delete from auth."rateLimit" where key like $1', [
        `%${clientIp}%`,
      ]);
      const first = await request();
      expect(first.status).not.toBe(429);

      const counter = await admin.query<{ id: string; key: string }>(
        'select id, key from auth."rateLimit" where key like $1',
        [`%${clientIp}%`],
      );
      expect(counter.rowCount).toBe(1);
      const counterRow = counter.rows[0];
      const previousRequest = Date.now() - 3_000;
      await admin.query(
        'update auth."rateLimit" set count = 1, "lastRequest" = $1 where id = $2',
        [previousRequest, counterRow!.id],
      );
      await admin.query(
        'insert into auth."rateLimit" (id, key, count, "lastRequest") values ($1, $2, 1, $3)',
        [
          `expired-${clientIp}`,
          `expired-cleanup-${clientIp}`,
          Date.now() - 120_000,
        ],
      );

      const second = await request();
      expect(second.status).not.toBe(429);
      const reset = await admin.query<{ count: number; lastRequest: string }>(
        'select count, "lastRequest" from auth."rateLimit" where id = $1',
        [counterRow!.id],
      );
      expect(Number(reset.rows[0]?.count)).toBe(1);
      expect(Number(reset.rows[0]?.lastRequest)).toBeGreaterThan(
        previousRequest,
      );

      const deadline = Date.now() + 1_000;
      let cleaned = false;
      while (Date.now() < deadline) {
        const remaining = await admin.query(
          'select 1 from auth."rateLimit" where id = $1',
          [`expired-${clientIp}`],
        );
        if (remaining.rowCount === 0) {
          cleaned = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(cleaned).toBe(true);
    });

    it('returns sanitized 503 when PostgreSQL rate-limit storage is unavailable', async () => {
      const env = {
        ...readTestEnv(),
        AUTH_RATE_LIMIT_ENABLED: 'true' as const,
        AUTH_RATE_LIMIT_RULES: '/sign-in/email:300:3',
      };
      const pool = createPostgresPool(env);
      pools.push(pool);
      const app = createApp({
        auth: createAuth(env, pool),
        frontendURL: env.FRONTEND_URL,
        issuer: env.BETTER_AUTH_URL,
      });
      await pool.end();
      const health = await app.request('/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      const responses = await Promise.all(
        Array.from({ length: 2 }, () =>
          app.request('/api/auth/sign-in/email', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-gootip-client-ip': '192.0.2.90',
            },
            body: JSON.stringify({
              email: 'storage-failure@example.com',
              password: 'invalid',
            }),
          }),
        ),
      );

      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: 'service_unavailable',
        });
      }
    });

    it('denies DDL, cross-schema, public-boundary, and history access', async () => {
      const history = historyTableName(SCHEMA);

      expect(
        await attempt(runtime, `create table ${SCHEMA}.evil (id integer)`),
      ).toBe('denied:42501');
      expect(
        await attempt(runtime, 'create table public.evil (id integer)'),
      ).toBe('denied:42501');
      expect(await attempt(runtime, 'create schema elsewhere')).toBe(
        'denied:42501',
      );
      expect(await attempt(runtime, 'select * from public.master_only')).toBe(
        'denied:42501',
      );
      expect(await attempt(runtime, `select * from ${history}`)).toBe(
        'denied:42501',
      );
      expect(
        await attempt(
          runtime,
          `insert into ${history} (migration_id, checksum_sha256, commit_sha, run_id, application_mode) values ('probe', repeat('a', 64), repeat('b', 40), 'probe', 'applied')`,
        ),
      ).toBe('denied:42501');
      expect(await attempt(runtime, `delete from ${history}`)).toBe(
        'denied:42501',
      );
    });
  },
);
