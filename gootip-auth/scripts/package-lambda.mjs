import { execFileSync } from 'node:child_process';
import { rmSync, utimesSync } from 'node:fs';

const archive = 'lambda.zip';
const bundle = 'dist/lambda.mjs';

rmSync(archive, { force: true });
const normalizedTimestamp = new Date('1980-01-01T00:00:00.000Z');
utimesSync(bundle, normalizedTimestamp, normalizedTimestamp);
execFileSync('zip', ['-X', '-q', archive, bundle], { stdio: 'inherit' });
execFileSync('unzip', ['-l', archive], { stdio: 'inherit' });
