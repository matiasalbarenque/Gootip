import { rmSync } from 'node:fs';

import { build } from 'esbuild';

const outputFile = 'dist/migrations/lambda.mjs';

rmSync(outputFile, { force: true });

await build({
  entryPoints: ['src/migration-runner/lambda.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: outputFile,
  minify: true,
  keepNames: true,
  sourcemap: false,
  external: ['pg-native', 'pg-cloudflare'],
  // The ESM runtime has no global `require`. Some CommonJS dependencies use
  // dynamic requires for Node builtins, so provide a module-scoped require.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
