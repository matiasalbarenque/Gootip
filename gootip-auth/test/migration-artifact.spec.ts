import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/migration-runner/digest.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const archive = join(projectRoot, 'migration-lambda.zip');
const manifest = join(projectRoot, 'migrations', 'manifest.json');

const runPnpm = (arguments_: string[]): string =>
  execFileSync('pnpm', arguments_, {
    cwd: projectRoot,
    encoding: 'utf8',
  });

const zipEntries = (): string[] =>
  execFileSync('unzip', ['-Z1', archive], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((entry) => entry.length > 0)
    .sort();

describe('migration Lambda artifact', () => {
  it('packages only the runner, reviewed SQL, and manifest within Lambda limits', () => {
    runPnpm(['build:migration-lambda']);
    const output = runPnpm(['migration-lambda:zip']);
    const report = JSON.parse(
      output
        .trim()
        .split('\n')
        .findLast((line) =>
          line.includes('"event":"auth_migration_package"'),
        ) as string,
    ) as Record<string, unknown>;

    expect(report).toMatchObject({
      event: 'auth_migration_package',
      layer_uncompressed_bytes: 0,
      deployment_path: 'direct_upload',
    });
    expect(Number(report.compressed_bytes)).toBeGreaterThan(0);
    expect(Number(report.uncompressed_bytes)).toBeGreaterThan(0);
    expect(Number(report.total_uncompressed_bytes)).toBeLessThanOrEqual(
      Number(report.lambda_uncompressed_limit_bytes),
    );
    expect(zipEntries()).toEqual([
      'dist/migrations/lambda.mjs',
      'migrations/000001-initial-auth.sql',
      'migrations/000002-auth-rate-limit.sql',
      'migrations/000003-auth-admin-roles.sql',
      'migrations/manifest.json',
    ]);
  });

  it('loads the actual ESM bundle and preserves its safe result contract', async () => {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const module = await import(${JSON.stringify(
          pathToFileURL(join(projectRoot, 'dist/migrations/lambda.mjs')).href,
        )}); if (typeof module.handler !== 'function') process.exit(1);`,
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );

    const module = (await import(
      `${pathToFileURL(join(projectRoot, 'dist/migrations/lambda.mjs')).href}?artifact-test`
    )) as { handler: (event: unknown) => Promise<Record<string, unknown>> };
    const result = await module.handler({ operation: 'not-allowed' });

    expect(typeof module.handler).toBe('function');
    expect(Object.keys(result).sort()).toEqual([
      'applied_ids',
      'commit_sha',
      'error_code',
      'history_sha256',
      'manifest_sha256',
      'operation',
      'pending_ids',
      'run_id',
      'status',
    ]);
    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'invalid_request',
    });
    expect(JSON.stringify(result)).not.toMatch(/password|secret|token/i);
  });

  it('binds the packaged manifest to its exact reviewed bytes', () => {
    const entries = zipEntries();
    const packaged = execFileSync(
      'unzip',
      ['-p', archive, 'migrations/manifest.json'],
      { cwd: projectRoot },
    );

    expect(entries).toContain('migrations/manifest.json');
    expect(packaged.equals(readFileSync(manifest))).toBe(true);
    expect(sha256Hex(readFileSync(manifest))).toMatch(/^[0-9a-f]{64}$/);
  });
});
