import { canonicalJson, sha256Hex } from './digest.js';
import { COMMIT_SHA_PATTERN, SHA256_PATTERN } from './patterns.js';
import {
  isSchemaDescriptor,
  type SchemaDescriptor,
} from './schema-descriptor.js';

export const MANIFEST_VERSION = 1;
export const MANIFEST_SERVICE = 'auth';
export const MANIFEST_SCHEMA = 'auth';
export const MANIFEST_FILE_NAME = 'manifest.json';
export const MIGRATIONS_DIRECTORY = 'migrations';

/** `<fixed-width-id>-<kebab-case-description>.sql` */
export const MIGRATION_FILE_PATTERN =
  /^(\d{6})-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;

export interface MigrationFileDigest {
  name: string;
  sha256: string;
}

export interface ManifestMigrationEntry {
  id: string;
  file: string;
  sha256: string;
}

export interface MigrationManifest {
  manifest_version: number;
  service: string;
  schema: string;
  commit_sha: string;
  better_auth_version: string;
  generator_version: string;
  configuration_sha256: string;
  migrations: ManifestMigrationEntry[];
  initial_schema_fingerprint: string;
  initial_schema: SchemaDescriptor;
}

export type ManifestValidation =
  | { ok: true; manifest: MigrationManifest }
  | { ok: false; problems: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Validates ordered SQL file names: fixed-width ids, kebab-case descriptions,
 * unique and strictly increasing ids.
 */
export const validateMigrationFileNames = (
  fileNames: readonly string[],
): string[] => {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  let previousId: string | null = null;

  for (const fileName of fileNames) {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);

    if (!match) {
      problems.push(`Invalid migration file name: ${fileName}`);
      continue;
    }

    const id = match[1] as string;

    if (seenIds.has(id)) {
      problems.push(`Duplicate migration id: ${id}`);
      continue;
    }

    if (previousId !== null && id <= previousId) {
      problems.push(`Migration id ${id} is not after ${previousId}`);
    }

    seenIds.add(id);
    previousId = id;
  }

  return problems;
};

const validateMigrationEntries = (
  raw: unknown,
  files: readonly MigrationFileDigest[],
  problems: string[],
): void => {
  if (!Array.isArray(raw)) {
    problems.push('migrations must be an array');
    return;
  }

  const digestByName = new Map(files.map((file) => [file.name, file.sha256]));
  const ids: string[] = [];
  const manifestFiles = new Set<string>();

  for (const entry of raw) {
    if (!isRecord(entry)) {
      problems.push('each migration entry must be an object');
      continue;
    }

    const { id, file, sha256 } = entry;

    if (typeof id !== 'string' || !/^\d{6}$/.test(id)) {
      problems.push(`invalid migration id: ${String(id)}`);
    } else {
      ids.push(id);
    }

    if (typeof file !== 'string' || !MIGRATION_FILE_PATTERN.test(file)) {
      problems.push(`invalid migration file: ${String(file)}`);
    } else {
      manifestFiles.add(file);

      if (typeof id === 'string' && !file.startsWith(`${id}-`)) {
        problems.push(`migration file ${file} does not match id ${id}`);
      }

      const expected = digestByName.get(file);

      if (expected === undefined) {
        problems.push(`manifest references a missing SQL file: ${file}`);
      } else if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
        problems.push(`invalid migration checksum for ${file}`);
      } else if (sha256 !== expected) {
        problems.push(
          `migration checksum does not match the SQL bytes: ${file}`,
        );
      }
    }
  }

  if (new Set(ids).size !== ids.length) {
    problems.push('migration ids must be unique');
  }

  const sortedIds = [...ids].sort();

  if (ids.join(',') !== sortedIds.join(',')) {
    problems.push('migration ids must be ordered');
  }

  for (const file of files) {
    if (!manifestFiles.has(file.name)) {
      problems.push(`bundled SQL file is not in the manifest: ${file.name}`);
    }
  }
};

export const validateManifest = (
  raw: unknown,
  files: readonly MigrationFileDigest[],
): ManifestValidation => {
  const problems: string[] = validateMigrationFileNames(
    files.map((file) => file.name),
  );

  if (!isRecord(raw)) {
    return { ok: false, problems: ['manifest must be a JSON object'] };
  }

  if (raw.manifest_version !== MANIFEST_VERSION) {
    problems.push(`manifest_version must be ${MANIFEST_VERSION}`);
  }

  if (raw.service !== MANIFEST_SERVICE) {
    problems.push(`service must be ${MANIFEST_SERVICE}`);
  }

  if (raw.schema !== MANIFEST_SCHEMA) {
    problems.push(`schema must be ${MANIFEST_SCHEMA}`);
  }

  if (
    typeof raw.commit_sha !== 'string' ||
    !COMMIT_SHA_PATTERN.test(raw.commit_sha)
  ) {
    problems.push('commit_sha must be a full commit hash');
  }

  for (const key of ['better_auth_version', 'generator_version'] as const) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0) {
      problems.push(`${key} must be a non-empty string`);
    }
  }

  if (
    typeof raw.configuration_sha256 !== 'string' ||
    !SHA256_PATTERN.test(raw.configuration_sha256)
  ) {
    problems.push('configuration_sha256 must be a sha256 hex digest');
  }

  validateMigrationEntries(raw.migrations, files, problems);

  if (
    typeof raw.initial_schema_fingerprint !== 'string' ||
    !SHA256_PATTERN.test(raw.initial_schema_fingerprint)
  ) {
    problems.push('initial_schema_fingerprint must be a sha256 hex digest');
  } else if (!isSchemaDescriptor(raw.initial_schema)) {
    problems.push('initial_schema must be a schema descriptor');
  } else if (
    sha256Hex(canonicalJson(raw.initial_schema)) !==
    raw.initial_schema_fingerprint
  ) {
    problems.push('initial_schema_fingerprint does not match initial_schema');
  }

  if (
    isSchemaDescriptor(raw.initial_schema) &&
    raw.initial_schema.schema !== MANIFEST_SCHEMA
  ) {
    problems.push(`initial_schema.schema must be ${MANIFEST_SCHEMA}`);
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return { ok: true, manifest: raw as unknown as MigrationManifest };
};
