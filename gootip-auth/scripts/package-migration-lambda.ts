import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '../src/migration-runner/digest.js';
import {
  MANIFEST_FILE_NAME,
  MIGRATIONS_DIRECTORY,
  validateManifest,
  validateMigrationFileNames,
  type MigrationFileDigest,
} from '../src/migration-runner/manifest.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = join(projectRoot, MIGRATIONS_DIRECTORY);
const bundle = 'dist/migrations/lambda.mjs';
const archive = 'migration-lambda.zip';
const MEBIBYTE = 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 250 * MEBIBYTE;
const DIRECT_UPLOAD_MAX_BYTES = 50 * MEBIBYTE;

const fail = (message: string): never => {
  console.error(`migration package: ${message}`);
  process.exit(1);
};

if (!existsSync(bundle)) {
  fail(`${bundle} is missing; run build:migration-lambda first`);
}

// Packaging only validates and copies the committed manifest and SQL. It never
// regenerates them.
const entries = readdirSync(migrationsDirectory);
const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();
const allowed = new Set([...sqlFiles, MANIFEST_FILE_NAME]);
const unexpected = entries.filter((name) => !allowed.has(name));

if (unexpected.length > 0) {
  fail(`unexpected files in ${MIGRATIONS_DIRECTORY}: ${unexpected.join(', ')}`);
}

const nameProblems = validateMigrationFileNames(sqlFiles);
if (nameProblems.length > 0) {
  fail(nameProblems.join('; '));
}

const raw = JSON.parse(
  readFileSync(join(migrationsDirectory, MANIFEST_FILE_NAME), 'utf8'),
) as unknown;

const migrationFiles: MigrationFileDigest[] = sqlFiles.map((name) => ({
  name,
  sha256: sha256Hex(readFileSync(join(migrationsDirectory, name))),
}));

const validation = validateManifest(raw, migrationFiles);

if (!validation.ok) {
  fail(validation.problems.join('; '));
}

const files = [
  bundle,
  ...sqlFiles.map((name) => `${MIGRATIONS_DIRECTORY}/${name}`),
  `${MIGRATIONS_DIRECTORY}/${MANIFEST_FILE_NAME}`,
];

rmSync(archive, { force: true });
const normalizedTimestamp = new Date('1980-01-01T00:00:00.000Z');
for (const file of files) {
  utimesSync(file, normalizedTimestamp, normalizedTimestamp);
}

execFileSync('zip', ['-X', '-q', archive, ...files], { stdio: 'inherit' });

const compressedBytes = statSync(archive).size;
const uncompressedBytes = files.reduce(
  (total, file) => total + statSync(file).size,
  0,
);

if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
  fail(
    `uncompressed deployment package is ${uncompressedBytes} bytes; Lambda allows at most ${MAX_UNCOMPRESSED_BYTES} bytes`,
  );
}

const deploymentPath =
  compressedBytes <= DIRECT_UPLOAD_MAX_BYTES
    ? 'direct_upload'
    : 's3_release_artifact_required';

// This native ZIP has no Lambda layers. Emit the complete deployment-size
// accounting that CI and the SPEC 11 release manifest consume.
console.log(
  JSON.stringify({
    event: 'auth_migration_package',
    compressed_bytes: compressedBytes,
    uncompressed_bytes: uncompressedBytes,
    layer_uncompressed_bytes: 0,
    total_uncompressed_bytes: uncompressedBytes,
    lambda_uncompressed_limit_bytes: MAX_UNCOMPRESSED_BYTES,
    direct_upload_limit_bytes: DIRECT_UPLOAD_MAX_BYTES,
    deployment_path: deploymentPath,
  }),
);
