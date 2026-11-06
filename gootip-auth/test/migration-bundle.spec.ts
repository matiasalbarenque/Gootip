import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMigrationBundle } from '../src/migration-runner/bundle.js';
import { sha256Hex } from '../src/migration-runner/digest.js';

const committedDirectory = fileURLToPath(
  new URL('../migrations', import.meta.url),
);

const temporaryDirectories: string[] = [];

const makeBundleDirectory = (
  sqlFiles: Record<string, string>,
  manifest: Record<string, unknown>,
): string => {
  const directory = mkdtempSync(join(tmpdir(), 'gootip-migrations-'));
  temporaryDirectories.push(directory);

  for (const [name, contents] of Object.entries(sqlFiles)) {
    writeFileSync(join(directory, name), contents);
  }

  writeFileSync(
    join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadMigrationBundle', () => {
  it('loads and verifies the committed migrations directory', () => {
    const result = loadMigrationBundle(committedDirectory);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.bundle.manifest.migrations).toHaveLength(3);
    expect(result.bundle.manifestSha256).toBe(
      sha256Hex(readFileSync(join(committedDirectory, 'manifest.json'))),
    );
    expect(result.bundle.files.map((file) => file.name)).toEqual([
      '000001-initial-auth.sql',
      '000002-auth-rate-limit.sql',
      '000003-auth-admin-roles.sql',
    ]);
    expect(result.bundle.sql.get('000001-initial-auth.sql')).toContain(
      'create table "auth"."user"',
    );
  });

  it('rejects a missing migrations directory', () => {
    const result = loadMigrationBundle(
      join(tmpdir(), 'gootip-missing-migrations'),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects SQL whose bytes no longer match the manifest', () => {
    const directory = makeBundleDirectory(
      { '000001-initial-auth.sql': 'create table "auth"."user" ();\n' },
      {
        manifest_version: 1,
        service: 'auth',
        schema: 'auth',
        commit_sha: 'a'.repeat(40),
        better_auth_version: '1.7.7',
        generator_version: '1.7.7',
        configuration_sha256: 'b'.repeat(64),
        migrations: [
          {
            id: '000001',
            file: '000001-initial-auth.sql',
            sha256: 'c'.repeat(64),
          },
        ],
        initial_schema_fingerprint: 'd'.repeat(64),
        initial_schema: { schema: 'auth', tables: [], sequences: [] },
      },
    );

    const result = loadMigrationBundle(directory);

    expect(result.ok).toBe(false);
  });
});
