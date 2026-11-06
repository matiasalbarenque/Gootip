import { execFileSync } from 'node:child_process';

execFileSync('vitest', ['run', 'test/migration-integration.spec.ts'], {
  stdio: 'inherit',
});

execFileSync(
  'vitest',
  [
    'run',
    'test/health.spec.ts',
    'test/categories.integration.spec.ts',
    'test/products.integration.spec.ts',
    'test/lambda.spec.ts',
    'test/package-lambda.spec.ts',
  ],
  { stdio: 'inherit' },
);
