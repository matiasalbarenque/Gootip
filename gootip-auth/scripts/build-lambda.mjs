import { rmSync } from 'node:fs';

import { build } from 'esbuild';

const outputFile = 'dist/lambda.mjs';

rmSync(outputFile, { force: true });

await build({
  entryPoints: ['src/lambda.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  outfile: outputFile,
  minify: true,
  keepNames: true,
  sourcemap: false,
  external: ['pg-native', 'pg-cloudflare'],
});
