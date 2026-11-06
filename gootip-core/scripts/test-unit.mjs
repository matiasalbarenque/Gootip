import { execFileSync } from 'node:child_process';

execFileSync(
  'vitest',
  [
    'run',
    '--exclude',
    'test/health.spec.ts',
    '--exclude',
    'test/categories.integration.spec.ts',
    '--exclude',
    'test/products.integration.spec.ts',
    '--exclude',
    'test/migration-integration.spec.ts',
    '--exclude',
    'test/lambda.spec.ts',
    '--exclude',
    'test/package-lambda.spec.ts',
  ],
  { stdio: 'inherit' },
);
