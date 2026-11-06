import { describe, expect, it } from 'vitest';

import {
  assertArtifactIdentity,
  parseMigrationRequest,
} from '../src/migration-runner/contract.js';
import {
  assertManifestMatchesRegistry,
  migrationManifestSha256,
  validateMigrationManifest,
  type MigrationManifest,
} from '../src/migration-runner/manifest.js';

const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const manifest: MigrationManifest = {
  format_version: 1,
  commit_sha: commit,
  migrations: [
    {
      name: 'First1782086400000',
      timestamp: 1782086400000,
      source_sha256: digest,
    },
    {
      name: 'Second1793059200000',
      timestamp: 1793059200000,
      source_sha256: digest,
    },
  ],
};

describe('migration request contract', () => {
  it('accepts valid requests and checks packaged artifact identity', () => {
    const request = parseMigrationRequest({
      operation: 'apply',
      run_id: 'manual-run_1',
      commit_sha: commit,
      expected_manifest_sha256: digest,
      expected_history_sha256: digest,
    });
    expect(() => assertArtifactIdentity(request, commit, digest)).not.toThrow();
    expect(() =>
      assertArtifactIdentity(request, 'c'.repeat(40), digest),
    ).toThrow('Migration artifact identity mismatch');
  });

  it.each([
    null,
    [],
    { operation: 'revert' },
    {
      operation: 'validate',
      run_id: 'bad id',
      commit_sha: commit,
      expected_manifest_sha256: digest,
    },
    {
      operation: 'validate',
      run_id: 'ok',
      commit_sha: commit.toUpperCase(),
      expected_manifest_sha256: digest,
    },
    {
      operation: 'validate',
      run_id: 'ok',
      commit_sha: commit,
      expected_manifest_sha256: digest,
      extra: true,
    },
  ])('rejects invalid requests before use (%j)', (value) => {
    expect(() => parseMigrationRequest(value)).toThrow(
      'Invalid migration request',
    );
  });
});

describe('migration manifest', () => {
  it('validates shape, ordered unique migrations, and registry identity', () => {
    expect(validateMigrationManifest(manifest)).toEqual(manifest);
    class First1782086400000 {
      name = 'First1782086400000';
    }
    class Second1793059200000 {
      name = 'Second1793059200000';
    }
    expect(() =>
      assertManifestMatchesRegistry(manifest, [
        First1782086400000,
        Second1793059200000,
      ]),
    ).not.toThrow();
    expect(migrationManifestSha256('{"format_version":1}')).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it.each([
    { ...manifest, format_version: 2 },
    { ...manifest, commit_sha: 'A'.repeat(40) },
    {
      ...manifest,
      migrations: [manifest.migrations[0], manifest.migrations[0]],
    },
    {
      ...manifest,
      migrations: [...manifest.migrations].reverse(),
    },
  ])('rejects malformed or inconsistent manifests (%j)', (value) => {
    expect(() => validateMigrationManifest(value)).toThrow(
      'Invalid migration manifest',
    );
  });
});
