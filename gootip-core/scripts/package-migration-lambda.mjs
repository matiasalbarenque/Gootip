import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, utimesSync } from 'node:fs';

const archive = 'migration-lambda.zip';
const files = ['dist/migrations/lambda.mjs', 'dist/migrations/manifest.json'];
if (files.some((file) => !existsSync(file))) {
  throw new Error(
    'Migration bundle is missing. Run "pnpm build:migration-lambda" first.',
  );
}

rmSync(archive, { force: true });
const normalizedTimestamp = new Date('1980-01-01T00:00:00.000Z');
for (const file of files)
  utimesSync(file, normalizedTimestamp, normalizedTimestamp);
execFileSync('zip', ['-X', '-q', archive, ...files], { stdio: 'inherit' });

const sha256 = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
console.log(
  JSON.stringify({
    archive,
    zip_sha256: sha256(archive),
    manifest_sha256: sha256(files[1]),
  }),
);
