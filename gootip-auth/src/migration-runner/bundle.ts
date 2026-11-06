import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Hex } from './digest.js';
import {
  MANIFEST_FILE_NAME,
  MIGRATIONS_DIRECTORY,
  validateManifest,
  type MigrationFileDigest,
  type MigrationManifest,
} from './manifest.js';

/**
 * The reviewed SQL and manifest are bundled in the deployment package. They are
 * never downloaded at runtime and never regenerated while packaging.
 */

export interface MigrationBundle {
  directory: string;
  manifest: MigrationManifest;
  manifestSha256: string;
  files: MigrationFileDigest[];
  sql: Map<string, string>;
}

export type BundleLoadResult =
  | { ok: true; bundle: MigrationBundle }
  | { ok: false; problems: string[] };

export const defaultMigrationsDirectory = (): string =>
  join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), MIGRATIONS_DIRECTORY);

export const loadMigrationBundle = (
  directory: string = defaultMigrationsDirectory(),
): BundleLoadResult => {
  let entries: string[];

  try {
    entries = readdirSync(directory);
  } catch {
    return { ok: false, problems: [`cannot read ${MIGRATIONS_DIRECTORY}/`] };
  }

  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();
  const allowed = new Set<string>([...sqlFiles, MANIFEST_FILE_NAME]);
  const unexpected = entries.filter((name) => !allowed.has(name));

  if (unexpected.length > 0) {
    return {
      ok: false,
      problems: [
        `unexpected files in ${MIGRATIONS_DIRECTORY}/: ${unexpected.join(', ')}`,
      ],
    };
  }

  let manifestBytes: Buffer;
  const files: MigrationFileDigest[] = [];
  const sql = new Map<string, string>();

  try {
    manifestBytes = readFileSync(join(directory, MANIFEST_FILE_NAME));

    for (const name of sqlFiles) {
      const bytes = readFileSync(join(directory, name));
      files.push({ name, sha256: sha256Hex(bytes) });
      sql.set(name, bytes.toString('utf8'));
    }
  } catch {
    return {
      ok: false,
      problems: [`cannot read ${MIGRATIONS_DIRECTORY}/ contents`],
    };
  }

  let raw: unknown;

  try {
    raw = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return { ok: false, problems: ['the bundled manifest is not valid JSON'] };
  }

  const validation = validateManifest(raw, files);

  if (!validation.ok) {
    return { ok: false, problems: validation.problems };
  }

  return {
    ok: true,
    bundle: {
      directory,
      manifest: validation.manifest,
      manifestSha256: sha256Hex(manifestBytes),
      files,
      sql,
    },
  };
};
