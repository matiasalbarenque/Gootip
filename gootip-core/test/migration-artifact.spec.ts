import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrations } from '../src/config/database/migrations/index.js';
import {
  migrationManifestSha256,
  validateMigrationManifest,
} from '../src/migration-runner/manifest.js';

const archive = 'migration-lambda.zip';

beforeAll(() => {
  execFileSync('node', ['scripts/build-migration-lambda.mjs'], {
    stdio: 'inherit',
  });
  execFileSync('node', ['scripts/package-migration-lambda.mjs'], {
    stdio: 'inherit',
  });
}, 120_000);

afterAll(() => {
  rmSync(archive, { force: true });
  rmSync('dist/migration-build', { recursive: true, force: true });
  rmSync('dist/migrations', { recursive: true, force: true });
});

describe('migration Lambda artifact', () => {
  it('contains only its handler bundle and generated manifest', () => {
    const entries = execFileSync('unzip', ['-Z1', archive], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort();
    expect(entries).toEqual([
      'dist/migrations/lambda.mjs',
      'dist/migrations/manifest.json',
    ]);

    const manifestBytes = readFileSync('dist/migrations/manifest.json');
    const manifest = validateMigrationManifest(
      JSON.parse(manifestBytes.toString('utf8')),
    );
    expect(manifest.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.migrations.map(({ name }) => name)).toEqual(
      migrations.map((Migration) => new Migration().name),
    );
    for (const entry of manifest.migrations) {
      const sourceName = entry.name.slice(0, -String(entry.timestamp).length);
      const sourcePath = `src/config/database/migrations/${entry.timestamp}-${sourceName}.ts`;
      expect(entry.source_sha256).toBe(
        createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
      );
    }
    expect(migrationManifestSha256(manifestBytes)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('imports the isolated handler without AWS or database access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'core-migration-lambda-'));
    try {
      execFileSync('unzip', ['-q', resolve(archive), '-d', directory]);
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import assert from 'node:assert/strict';
            import { handler } from './dist/migrations/lambda.mjs';
            const manifest = JSON.parse(await (await import('node:fs/promises')).readFile('./dist/migrations/manifest.json', 'utf8'));
            const { createHash } = await import('node:crypto');
            const manifestHash = createHash('sha256').update(JSON.stringify(manifest, null, 2) + '\\n').digest('hex');
            const result = await handler({
              operation: 'validate', run_id: 'artifact-test',
              commit_sha: manifest.commit_sha,
              expected_manifest_sha256: manifestHash
            }, { invokedFunctionArn: 'arn:aws:lambda:us-east-2:123456789012:function:test:4' });
            assert.equal(result.error_code, 'invalid_invocation');
            console.log('isolated migration handler imported');
          `,
        ],
        { cwd: directory, encoding: 'utf8', timeout: 15_000 },
      );
      expect(output).toContain('isolated migration handler imported');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
