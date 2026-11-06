import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import { build } from 'esbuild';

const compileDir = 'dist/build';
const outputFile = 'dist/lambda.mjs';

rmSync(compileDir, { recursive: true, force: true });
rmSync(outputFile, { force: true });

// TypeScript emits decorator metadata first; esbuild only bundles that output.
execFileSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' },
);

await build({
  entryPoints: [`${compileDir}/lambda.js`],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: outputFile,
  minify: true,
  keepNames: true,
  sourcemap: false,
  banner: {
    // CJS dependencies bundled into ESM keep calling require() at runtime.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  // Nest loads these optional integrations lazily and ignores missing ones.
  external: [
    '@nestjs/microservices',
    '@nestjs/microservices/*',
    '@nestjs/websockets',
    '@nestjs/websockets/*',
    '@nestjs/platform-socket.io',
  ],
});

rmSync(compileDir, { recursive: true, force: true });
