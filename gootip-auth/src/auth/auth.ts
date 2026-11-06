import { readFileSync } from 'node:fs';

import { betterAuth } from 'better-auth';
import { admin, bearer, jwt } from 'better-auth/plugins';
import { adminAc, userAc } from 'better-auth/plugins/admin/access';
import { PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { AppEnv } from '../config/env.js';
import { parseRateLimitRules } from '../config/env.js';

const THIRTY_DAYS_IN_SECONDS = 60 * 60 * 24 * 30;

const createPostgresSSL = (env: AppEnv) => {
  if (env.POSTGRES_SSL_MODE === 'disable') {
    return false;
  }

  if (!env.POSTGRES_CA_PATH) {
    throw new Error('POSTGRES_CA_PATH is required for verified TLS.');
  }

  return {
    ca: readFileSync(env.POSTGRES_CA_PATH, 'utf8'),
    rejectUnauthorized: true,
  };
};

/**
 * The PostgreSQL pool Better Auth uses. Exported so focused runtime checks can
 * close it deterministically instead of leaving an idle connection behind.
 */
export const createPostgresPool = (
  env: AppEnv,
  connectionTimeoutMillis?: number,
): Pool =>
  new Pool({
    host: env.POSTGRES_DB_HOST,
    port: env.POSTGRES_DB_PORT,
    // Validated `auth_runtime` credential applied by the Lambda loader
    // (or the local environment). Better Auth is the only database client.
    user: env.POSTGRES_DB_USER,
    password: env.POSTGRES_DB_PASSWORD,
    database: env.POSTGRES_DB_NAME,
    max: env.AUTH_PG_POOL_MAX,
    ...(connectionTimeoutMillis === undefined
      ? {}
      : {
          connectionTimeoutMillis: Math.max(
            1,
            Math.floor(connectionTimeoutMillis / 2),
          ),
          query_timeout: Math.max(1, Math.floor(connectionTimeoutMillis / 2)),
        }),
    idleTimeoutMillis: 10_000,
    ssl: createPostgresSSL(env),
  });

export interface AuthSigningSecret {
  version: number;
  value: string;
}

export const createAuthOptions = (env: AppEnv) => ({
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.FRONTEND_URL],
  rateLimit: {
    enabled: env.AUTH_RATE_LIMIT_ENABLED === 'true',
    storage: 'database' as const,
    customRules: parseRateLimitRules(env.AUTH_RATE_LIMIT_RULES),
  },
  advanced: { ipAddress: { ipAddressHeaders: ['x-gootip-client-ip'] } },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  plugins: [
    bearer(),
    admin({
      defaultRole: 'user',
      roles: { user: userAc, editor: userAc, admin: adminAc },
    }),
    jwt({
      jwt: {
        issuer: env.BETTER_AUTH_URL,
        audience: env.JWT_AUDIENCE,
        expirationTime: '15m',
        definePayload: ({ user }) => ({ role: user.role ?? 'user' }),
      },
      jwks: {
        keyPairConfig: {
          alg: 'RS256',
          modulusLength: 2048,
        },
        rotationInterval: THIRTY_DAYS_IN_SECONDS,
        gracePeriod: THIRTY_DAYS_IN_SECONDS,
      },
    }),
  ],
});

export const createAuth = (
  env: AppEnv,
  pool: Pool = createPostgresPool(env),
  signingSecrets: AuthSigningSecret[] = [
    { version: 1, value: env.BETTER_AUTH_SECRET },
  ],
) =>
  betterAuth({
    ...createAuthOptions(env),
    // Keep database initialization outside the metadata-only config factory.
    database: {
      dialect: new PostgresDialect({ pool }),
      type: 'postgres',
      schemaName: 'auth',
    },
    secret: signingSecrets.at(-1)?.value ?? env.BETTER_AUTH_SECRET,
    secrets: signingSecrets,
  });

export type AppAuth = ReturnType<typeof createAuth>;
