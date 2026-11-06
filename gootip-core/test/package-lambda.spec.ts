import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertCoreTestDatabase } from './local-postgres.js';

assertCoreTestDatabase();

const archive = 'lambda.zip';
const bundle = 'dist/lambda.mjs';

beforeAll(() => {
  execFileSync('node', ['scripts/build-lambda.mjs'], { stdio: 'inherit' });
  execFileSync('node', ['scripts/package-lambda.mjs'], { stdio: 'inherit' });
}, 120_000);

afterAll(() => {
  rmSync(archive, { force: true });
  rmSync('dist', { recursive: true, force: true });
});

describe('lambda.zip', () => {
  it('contains only dist/lambda.mjs', () => {
    const entries = execFileSync('unzip', ['-Z1', archive], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');

    expect(entries).toEqual([bundle]);
  });

  it('serves repeated health events from the isolated ZIP with PostgreSQL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'core-lambda-test-'));
    try {
      execFileSync('unzip', ['-q', resolve(archive), '-d', directory]);
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import assert from 'node:assert/strict';
            import { handler } from './dist/lambda.mjs';
            const event = {
              version: '2.0', routeKey: 'GET /api/health',
              rawPath: '/api/health', rawQueryString: '',
              headers: { host: 'example.com' }, isBase64Encoded: false,
              requestContext: { http: {
                method: 'GET', path: '/api/health', protocol: 'HTTP/1.1',
                sourceIp: '127.0.0.1', userAgent: 'test'
              } }
            };
            for (let i = 0; i < 2; i++) {
              const response = await handler(event, {});
              assert.equal(response.statusCode, 200);
              assert.equal(response.body, '{"status":"ok"}');
            }
            console.log('isolated Lambda passed');
            process.exit(0);
          `,
        ],
        { cwd: directory, encoding: 'utf8', timeout: 15_000 },
      );
      expect(output).toContain('isolated Lambda passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
