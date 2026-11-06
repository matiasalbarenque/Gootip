import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    fileParallelism: false,
    include: ['test/**/*.spec.ts'],
    env: {
      POSTGRES_DB_HOST: process.env.POSTGRES_DB_HOST ?? '127.0.0.1',
      POSTGRES_DB_PORT: process.env.POSTGRES_DB_PORT ?? '5433',
      POSTGRES_DB_NAME: process.env.POSTGRES_DB_NAME ?? 'gootip_test_core',
      POSTGRES_DB_USER: process.env.POSTGRES_DB_USER ?? 'test_core_runtime',
      POSTGRES_DB_PASSWORD:
        process.env.POSTGRES_DB_PASSWORD ?? 'unit-test-only-password',
      POSTGRES_SSL_MODE: process.env.POSTGRES_SSL_MODE ?? 'disable',
    },
  },
});
