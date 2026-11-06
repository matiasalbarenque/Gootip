import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSchema } from 'better-auth/db';
import { Client } from 'pg';

import { createAuth } from '../src/auth/auth.js';
import { readEnv, type AppEnv } from '../src/config/env.js';
import { canonicalJson, sha256Hex } from '../src/migration-runner/digest.js';
import {
  MANIFEST_FILE_NAME,
  MANIFEST_SCHEMA,
  MANIFEST_SERVICE,
  MANIFEST_VERSION,
  MIGRATIONS_DIRECTORY,
  validateManifest,
  validateMigrationFileNames,
  type ManifestMigrationEntry,
  type MigrationFileDigest,
  type MigrationManifest,
} from '../src/migration-runner/manifest.js';
import {
  describeSchema,
  fingerprintDescriptor,
  type Queryable,
  type SchemaDescriptor,
} from '../src/migration-runner/schema-descriptor.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = join(projectRoot, MIGRATIONS_DIRECTORY);

const fail = (message: string): never => {
  console.error(`migration manifest: ${message}`);
  process.exit(1);
};

const readPackageVersion = (packageName: string): string => {
  const file = join(projectRoot, 'node_modules', packageName, 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof (parsed as { version?: unknown }).version === 'string'
  ) {
    return (parsed as { version: string }).version;
  }

  return fail(`cannot read the installed version of ${packageName}`);
};

const sslFor = (env: AppEnv) => {
  if (env.POSTGRES_SSL_MODE === 'disable') {
    return false;
  }

  const caPath = env.POSTGRES_CA_PATH;

  if (!caPath) {
    return fail('POSTGRES_CA_PATH is required for verified TLS.');
  }

  return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
};

const configurationDigest = (env: AppEnv): string => {
  const schema = getSchema(
    createAuth(env).options as Parameters<typeof getSchema>[0],
  );
  const serialized = JSON.parse(
    JSON.stringify(schema, (key, value) =>
      typeof value === 'function' ? `[function:${key}]` : value,
    ),
  ) as unknown;

  return sha256Hex(canonicalJson(serialized));
};

const readCommitSha = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })
      .toString()
      .trim();
  } catch {
    return fail('git rev-parse HEAD failed');
  }
};

/**
 * Applies the initial migration inside a transaction and introspects the
 * result, then rolls back. The descriptor database is never modified.
 */
const describeInitialSchema = async (
  env: AppEnv,
  initialFile: string,
): Promise<SchemaDescriptor> => {
  const client = new Client({
    host: env.POSTGRES_DB_HOST,
    port: env.POSTGRES_DB_PORT,
    user: env.POSTGRES_DB_USER,
    password: env.POSTGRES_DB_PASSWORD,
    database: env.POSTGRES_DB_NAME,
    ssl: sslFor(env),
  });

  await client.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r'`,
      [MANIFEST_SCHEMA],
    );

    if (Number(existing.rows[0]?.count ?? '0') !== 0) {
      fail(
        `the "${MANIFEST_SCHEMA}" schema must be empty in the descriptor database`,
      );
    }

    await client.query(`CREATE SCHEMA IF NOT EXISTS "${MANIFEST_SCHEMA}"`);
    await client.query(
      readFileSync(join(migrationsDirectory, initialFile), 'utf8'),
    );

    const queryable: Queryable = {
      query: async (text, values) => {
        const result = await client.query(
          text,
          values ? [...values] : undefined,
        );
        return { rows: result.rows as Record<string, unknown>[] };
      },
    };

    return await describeSchema(queryable, MANIFEST_SCHEMA);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
};

const main = async (): Promise<void> => {
  const env = readEnv();
  const entries = readdirSync(migrationsDirectory);
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();

  const nameProblems = validateMigrationFileNames(sqlFiles);
  if (nameProblems.length > 0) {
    return fail(nameProblems.join('; '));
  }

  const allowed = new Set([...sqlFiles, MANIFEST_FILE_NAME]);
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    return fail(
      `unexpected files in ${MIGRATIONS_DIRECTORY}: ${unexpected.join(', ')}`,
    );
  }

  const initialFile = sqlFiles[0];
  if (!initialFile) {
    return fail(`no SQL files found in ${MIGRATIONS_DIRECTORY}`);
  }

  const descriptor = await describeInitialSchema(env, initialFile);

  const migrationFiles: MigrationFileDigest[] = sqlFiles.map((file) => ({
    name: file,
    sha256: sha256Hex(readFileSync(join(migrationsDirectory, file))),
  }));

  const migrations: ManifestMigrationEntry[] = migrationFiles.map((file) => ({
    id: file.name.slice(0, 6),
    file: file.name,
    sha256: file.sha256,
  }));

  const manifest: MigrationManifest = {
    manifest_version: MANIFEST_VERSION,
    service: MANIFEST_SERVICE,
    schema: MANIFEST_SCHEMA,
    commit_sha: readCommitSha(),
    better_auth_version: readPackageVersion('better-auth'),
    generator_version: readPackageVersion('auth'),
    configuration_sha256: configurationDigest(env),
    migrations,
    initial_schema_fingerprint: fingerprintDescriptor(descriptor),
    initial_schema: descriptor,
  };

  const validation = validateManifest(manifest, migrationFiles);
  if (!validation.ok) {
    return fail(validation.problems.join('; '));
  }

  writeFileSync(
    join(migrationsDirectory, MANIFEST_FILE_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(
    [
      `wrote ${MIGRATIONS_DIRECTORY}/${MANIFEST_FILE_NAME}`,
      `commit_sha=${manifest.commit_sha}`,
      `files=${migrations.map((entry) => entry.file).join(', ')}`,
      `initial_schema_fingerprint=${manifest.initial_schema_fingerprint}`,
      `configuration_sha256=${manifest.configuration_sha256}`,
    ].join('\n'),
  );
};

await main();
