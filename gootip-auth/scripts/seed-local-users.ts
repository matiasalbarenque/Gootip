import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { createAuth, createPostgresPool } from '../src/auth/auth.js';
import { readEnv } from '../src/config/env.js';

const env = readEnv();
if (
  !['localhost', '127.0.0.1'].includes(env.POSTGRES_DB_HOST) ||
  env.POSTGRES_DB_PORT !== 5433 ||
  env.POSTGRES_DB_NAME !== 'gootip' ||
  env.POSTGRES_DB_USER !== 'auth_runtime' ||
  env.POSTGRES_SSL_MODE !== 'disable' ||
  env.SECRET_ARN ||
  env.DB_RUNTIME_SECRET_ARN ||
  process.env.AWS_LAMBDA_FUNCTION_NAME
) {
  throw new Error(
    'User seeding is restricted to shared local development PostgreSQL on port 5433.',
  );
}

const roles = ['user', 'editor', 'admin'] as const;
const credentialsPath = fileURLToPath(
  new URL('../.env.local-users.json', import.meta.url),
);
const credentialSchema = z
  .array(
    z.object({
      role: z.enum(roles),
      email: z.email(),
      password: z.string().min(16),
    }),
  )
  .length(3);
const credentialsExist = existsSync(credentialsPath);
const credentials = credentialSchema.parse(
  credentialsExist
    ? JSON.parse(readFileSync(credentialsPath, 'utf8'))
    : roles.map((role) => ({
        role,
        email: `${role}@gootip.local`,
        password: randomBytes(24).toString('base64url'),
      })),
);
if (
  roles.some(
    (role) =>
      credentials.filter(
        (entry) =>
          entry.role === role && entry.email === `${role}@gootip.local`,
      ).length !== 1,
  )
) {
  throw new Error(
    'Local fixture identities must contain exactly one fixed email for each role.',
  );
}

const pool = createPostgresPool(env);
try {
  const existing = await pool.query<{ email: string; role: string }>(
    'SELECT email, role FROM auth."user" WHERE email = ANY($1::text[])',
    [credentials.map((entry) => entry.email)],
  );
  if (
    (!credentialsExist && existing.rowCount) ||
    existing.rows.some(
      (user) =>
        credentials.find((entry) => entry.email === user.email)?.role !==
        user.role,
    )
  ) {
    throw new Error(
      'Existing local fixture credentials or roles differ; refusing to overwrite users.',
    );
  }
  // Persist before writes so a partially completed run can resume without resets.
  if (!credentialsExist) {
    writeFileSync(
      credentialsPath,
      `${JSON.stringify(credentials, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  }
  const auth = createAuth(env, pool);
  for (const entry of credentials) {
    if (!existing.rows.some((user) => user.email === entry.email)) {
      // Trusted server API: Better Auth hashes passwords and runs its user hooks.
      await auth.api.createUser({
        body: { ...entry, name: `Local ${entry.role}` },
      });
    }
    const session = await auth.api.signInEmail({
      body: { email: entry.email, password: entry.password },
    });
    try {
      const headers = new Headers({ authorization: `Bearer ${session.token}` });
      const { token } = await auth.api.getToken({ headers });
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1]!, 'base64url').toString(),
      ) as { role?: string; sub?: string };
      if (payload.role !== entry.role || payload.sub !== session.user.id) {
        throw new Error('Local JWT role/subject verification failed.');
      }
    } finally {
      await auth.api.signOut({
        headers: new Headers({ authorization: `Bearer ${session.token}` }),
      });
    }
    console.log(
      `${entry.email}: ${entry.role}; sign-in and JWT claims verified`,
    );
  }
  console.log(
    'Credentials saved in ignored .env.local-users.json (owner-only permissions). Existing passwords are never reset.',
  );
} catch {
  // Never forward raw adapter/API errors that might contain credential inputs.
  console.error(
    'Local user seed failed; check local configuration, migrations and fixture ownership. No existing credentials were reset.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
