export const assertCoreTestDatabase = (
  env: NodeJS.ProcessEnv = process.env,
): void => {
  const expected = {
    POSTGRES_DB_HOST: '127.0.0.1',
    POSTGRES_DB_PORT: env.LOCAL_POSTGRES_PORT ?? '5433',
    POSTGRES_DB_NAME: 'gootip_test_core',
    POSTGRES_DB_USER: 'test_core_runtime',
    POSTGRES_SSL_MODE: 'disable',
  };
  if (Object.entries(expected).some(([name, value]) => env[name] !== value)) {
    throw new Error(
      'Core integration requires the allowlisted local test database',
    );
  }
  for (const name of ['POSTGRES_DB_PASSWORD', 'CORE_TEST_MIGRATOR_PASSWORD']) {
    if (!env[name] || env[name] === 'unit-test-only-password') {
      throw new Error(
        `${name} is required; run the shared PostgreSQL integration command`,
      );
    }
  }
};
