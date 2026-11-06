import { z } from 'zod';

/**
 * Deployment configuration for the migration runner.
 *
 * Database, schema, role, and secret identities come from Terraform-managed
 * environment variables, never from the invocation event. The migrator password
 * is not part of this configuration: it is read from Secrets Manager per
 * invocation.
 */

const optionalNonEmptyString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const identifier = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z_][a-z0-9_]*$/);

/**
 * Roles that own or administer the instance. The migrator must never be one of
 * them, so a mistaken deployment fails during configuration validation instead
 * of connecting with a master-like credential.
 */
export const MIGRATION_RESERVED_DB_USERS = [
  'postgres',
  'rdsadmin',
  'rds_superuser',
  'admin',
  'root',
  'master',
  'awsuser',
] as const;

/**
 * Steps reserved inside the Lambda's execution limit for cleanup: releasing the
 * session lock, closing the connection, and building the result. A release
 * whose budgets do not leave this margin is rejected during configuration
 * validation rather than continued through blind retries.
 */
export const MIGRATION_LAMBDA_CLEANUP_MARGIN_SECONDS = 30;

/**
 * Hard service maximum for a Lambda invocation: 15 minutes.
 */
export const MIGRATION_MAX_LAMBDA_TIMEOUT_SECONDS = 900;

const boundedSeconds = z.coerce.number().int().min(1).max(900);

const migrationEnvSchema = z
  .object({
    POSTGRES_DB_HOST: z.string().min(1),
    POSTGRES_DB_PORT: z.coerce.number().int().min(1).max(65535),
    POSTGRES_DB_NAME: z.string().min(1).max(63),
    POSTGRES_SSL_MODE: z.enum(['disable', 'verify-full']).default('disable'),
    POSTGRES_CA_PATH: optionalNonEmptyString,
    MIGRATION_DB_USER: identifier,
    MIGRATION_DB_RUNTIME_USER: identifier.default('auth_runtime'),
    MIGRATION_DB_SCHEMA: identifier.default('auth'),
    MIGRATION_CREDENTIAL_SECRET_ARN: z.string().min(1).max(2048),
    MIGRATION_CONNECT_TIMEOUT_SECONDS: boundedSeconds.default(10),
    MIGRATION_LOCK_TIMEOUT_SECONDS: boundedSeconds.default(30),
    MIGRATION_STATEMENT_TIMEOUT_SECONDS: boundedSeconds.default(120),
    MIGRATION_OPERATION_TIMEOUT_SECONDS: boundedSeconds.default(300),
    MIGRATION_LAMBDA_TIMEOUT_SECONDS: boundedSeconds
      .max(MIGRATION_MAX_LAMBDA_TIMEOUT_SECONDS)
      .default(600),
  })
  .refine(
    (env) => env.POSTGRES_SSL_MODE !== 'verify-full' || env.POSTGRES_CA_PATH,
    {
      message: 'POSTGRES_CA_PATH must be set when PostgreSQL TLS is enabled.',
      path: ['POSTGRES_CA_PATH'],
    },
  )
  .refine(
    (env) =>
      !(MIGRATION_RESERVED_DB_USERS as readonly string[]).includes(
        env.MIGRATION_DB_USER,
      ),
    {
      message: 'MIGRATION_DB_USER must not be a master-like role.',
      path: ['MIGRATION_DB_USER'],
    },
  )
  .refine(
    (env) =>
      !(MIGRATION_RESERVED_DB_USERS as readonly string[]).includes(
        env.MIGRATION_DB_RUNTIME_USER,
      ),
    {
      message: 'MIGRATION_DB_RUNTIME_USER must not be a master-like role.',
      path: ['MIGRATION_DB_RUNTIME_USER'],
    },
  )
  .refine((env) => env.MIGRATION_DB_RUNTIME_USER !== env.MIGRATION_DB_USER, {
    message: 'MIGRATION_DB_RUNTIME_USER must differ from MIGRATION_DB_USER.',
    path: ['MIGRATION_DB_RUNTIME_USER'],
  })
  .superRefine((env, ctx) => {
    const innerTimeoutFields = [
      [
        'MIGRATION_CONNECT_TIMEOUT_SECONDS',
        env.MIGRATION_CONNECT_TIMEOUT_SECONDS,
      ],
      ['MIGRATION_LOCK_TIMEOUT_SECONDS', env.MIGRATION_LOCK_TIMEOUT_SECONDS],
      [
        'MIGRATION_STATEMENT_TIMEOUT_SECONDS',
        env.MIGRATION_STATEMENT_TIMEOUT_SECONDS,
      ],
    ] as const;

    for (const [field, seconds] of innerTimeoutFields) {
      if (seconds > env.MIGRATION_OPERATION_TIMEOUT_SECONDS) {
        ctx.addIssue({
          code: 'custom',
          message: `${field} must not exceed MIGRATION_OPERATION_TIMEOUT_SECONDS.`,
          path: [field],
        });
      }
    }

    if (
      env.MIGRATION_OPERATION_TIMEOUT_SECONDS +
        MIGRATION_LAMBDA_CLEANUP_MARGIN_SECONDS >
      env.MIGRATION_LAMBDA_TIMEOUT_SECONDS
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'MIGRATION_OPERATION_TIMEOUT_SECONDS must leave a cleanup margin inside MIGRATION_LAMBDA_TIMEOUT_SECONDS.',
        path: ['MIGRATION_OPERATION_TIMEOUT_SECONDS'],
      });
    }
  });

/**
 * Reviewed timeouts. The connect timeout bounds the TCP/TLS handshake, the lock
 * timeout bounds both advisory-lock acquisition and database lock waits, the
 * statement timeout bounds each statement, and the operation timeout bounds the
 * whole invocation.
 */
export interface MigrationTimeouts {
  connectSeconds: number;
  lockSeconds: number;
  statementSeconds: number;
  operationSeconds: number;
  lambdaSeconds: number;
}

export interface MigrationConfig {
  database: {
    host: string;
    port: number;
    name: string;
    sslMode: 'disable' | 'verify-full';
    caPath: string | null;
  };
  user: string;
  runtimeUser: string;
  schema: string;
  credentialSecretArn: string;
  timeouts: MigrationTimeouts;
}

export type ConfigValidation =
  | { ok: true; config: MigrationConfig }
  | { ok: false; problems: string[] };

/**
 * Reads deployment configuration without ever echoing a value, so a rejected
 * configuration cannot leak a host name, ARN, or credential into a result.
 */
export const readMigrationConfig = (
  source: Record<string, string | undefined> = process.env,
): ConfigValidation => {
  const parsed = migrationEnvSchema.safeParse(source);

  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) =>
          `${issue.path.join('.') || 'configuration'}: ${issue.message}`,
      ),
    };
  }

  const env = parsed.data;

  return {
    ok: true,
    config: {
      database: {
        host: env.POSTGRES_DB_HOST,
        port: env.POSTGRES_DB_PORT,
        name: env.POSTGRES_DB_NAME,
        sslMode: env.POSTGRES_SSL_MODE,
        caPath: env.POSTGRES_CA_PATH ?? null,
      },
      user: env.MIGRATION_DB_USER,
      runtimeUser: env.MIGRATION_DB_RUNTIME_USER,
      schema: env.MIGRATION_DB_SCHEMA,
      credentialSecretArn: env.MIGRATION_CREDENTIAL_SECRET_ARN,
      timeouts: {
        connectSeconds: env.MIGRATION_CONNECT_TIMEOUT_SECONDS,
        lockSeconds: env.MIGRATION_LOCK_TIMEOUT_SECONDS,
        statementSeconds: env.MIGRATION_STATEMENT_TIMEOUT_SECONDS,
        operationSeconds: env.MIGRATION_OPERATION_TIMEOUT_SECONDS,
        lambdaSeconds: env.MIGRATION_LAMBDA_TIMEOUT_SECONDS,
      },
    },
  };
};
