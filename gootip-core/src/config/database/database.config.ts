import { readFileSync } from 'node:fs';

import pg from 'pg';
import type { DataSourceOptions } from 'typeorm';

import { Category } from '../../modules/categories/category.entity.js';
import { Product } from '../../modules/products/product.entity.js';
import { migrations } from './migrations/index.js';

type PostgresOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value)
    throw new Error(`Missing required database configuration: ${name}`);
  return value;
};

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const createDatabasePort = (env: NodeJS.ProcessEnv): number => {
  const port = positiveInteger(
    required(env, 'POSTGRES_DB_PORT'),
    'POSTGRES_DB_PORT',
  );
  if (port > 65_535) {
    throw new Error('POSTGRES_DB_PORT must be between 1 and 65535');
  }
  return port;
};

const createDatabasePoolSize = (env: NodeJS.ProcessEnv): number =>
  positiveInteger(env.CORE_PG_POOL_MAX ?? '2', 'CORE_PG_POOL_MAX');

const createDatabaseSsl = (
  env: NodeJS.ProcessEnv,
): boolean | { ca: string; rejectUnauthorized: boolean } => {
  const sslMode = required(env, 'POSTGRES_SSL_MODE');
  if (sslMode === 'disable') return false;
  if (sslMode === 'verify-full') {
    const caPath = required(env, 'POSTGRES_CA_PATH');
    try {
      return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    } catch {
      throw new Error(
        'Unable to load PostgreSQL CA certificate from POSTGRES_CA_PATH',
      );
    }
  }
  throw new Error('POSTGRES_SSL_MODE must be either disable or verify-full');
};

export const createDatabaseOptions = (
  env: NodeJS.ProcessEnv = process.env,
): PostgresOptions => ({
  type: 'postgres',
  // TypeORM's dynamic driver lookup cannot be resolved in a standalone bundle.
  driver: pg,
  host: required(env, 'POSTGRES_DB_HOST'),
  port: createDatabasePort(env),
  database: required(env, 'POSTGRES_DB_NAME'),
  username: required(env, 'POSTGRES_DB_USER'),
  password: required(env, 'POSTGRES_DB_PASSWORD'),
  ...(env.POSTGRES_DB_CONNECT_TIMEOUT_MS
    ? {
        connectTimeoutMS: positiveInteger(
          env.POSTGRES_DB_CONNECT_TIMEOUT_MS,
          'POSTGRES_DB_CONNECT_TIMEOUT_MS',
        ),
      }
    : {}),
  ...(env.POSTGRES_DB_QUERY_TIMEOUT_MS
    ? {
        extra: {
          query_timeout: positiveInteger(
            env.POSTGRES_DB_QUERY_TIMEOUT_MS,
            'POSTGRES_DB_QUERY_TIMEOUT_MS',
          ),
        },
      }
    : {}),
  schema: 'core',
  poolSize: createDatabasePoolSize(env),
  ssl: createDatabaseSsl(env),
  synchronize: false,
  migrationsRun: false,
  entities: [Category, Product],
  migrations,
});
