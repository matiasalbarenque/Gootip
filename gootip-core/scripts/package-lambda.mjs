import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, utimesSync } from 'node:fs';

const archive = 'lambda.zip';
const bundle = 'dist/lambda.mjs';

if (!existsSync(bundle)) {
  throw new Error('dist/lambda.mjs is missing. Run "pnpm build:lambda" first.');
}

rmSync(archive, { force: true });

// Normalizing the timestamp keeps the archive reproducible across builds.
const normalizedTimestamp = new Date('1980-01-01T00:00:00.000Z');
utimesSync(bundle, normalizedTimestamp, normalizedTimestamp);

execFileSync('zip', ['-X', '-q', archive, bundle], { stdio: 'inherit' });
execFileSync('unzip', ['-l', archive], { stdio: 'inherit' });
