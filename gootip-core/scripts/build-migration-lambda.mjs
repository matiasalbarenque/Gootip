import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { build } from 'esbuild';

const compileDir = 'dist/migration-build';
const outputDir = 'dist/migrations';
const migrationSourceDir = 'src/config/database/migrations';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const commitSha =
  process.env.MIGRATION_COMMIT_SHA ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(commitSha)) {
  throw new Error('MIGRATION_COMMIT_SHA must be a lowercase 40-character SHA');
}

rmSync(compileDir, { recursive: true, force: true });
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

// Compile first so esbuild preserves TypeScript decorator metadata.
execFileSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.build.json',
    '--outDir',
    compileDir,
  ],
  { stdio: 'inherit' },
);

const { migrations } = await import(
  new URL(
    `../${compileDir}/config/database/migrations/index.js`,
    import.meta.url,
  )
);
const entries = migrations.map((Migration) => {
  const instance = new Migration();
  const name = instance.name ?? Migration.name;
  const timestamp = Number(name.match(/(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error('Registered migration has no valid timestamp');
  }
  const sourceName = name.slice(0, -String(timestamp).length);
  const sourcePath = `${migrationSourceDir}/${timestamp}-${sourceName}.ts`;
  return {
    name,
    timestamp,
    source_sha256: sha256(readFileSync(sourcePath)),
  };
});

const manifest = {
  format_version: 1,
  commit_sha: commitSha,
  migrations: entries,
};
writeFileSync(
  `${outputDir}/manifest.json`,
  `${JSON.stringify(manifest, null, 2)}\n`,
);

await build({
  entryPoints: [`${compileDir}/migration-runner/lambda.js`],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: `${outputDir}/lambda.mjs`,
  minify: true,
  keepNames: true,
  sourcemap: false,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

rmSync(compileDir, { recursive: true, force: true });
console.log(
  JSON.stringify({
    commit_sha: commitSha,
    manifest_sha256: sha256(readFileSync(`${outputDir}/manifest.json`)),
    migrations: entries.map(({ name }) => name),
  }),
);
