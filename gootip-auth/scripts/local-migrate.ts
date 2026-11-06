import { loadMigrationBundle } from '../src/migration-runner/bundle.js';
import { runMigration } from '../src/migration-runner/handler.js';

const main = async (): Promise<void> => {
  const bundle = loadMigrationBundle();

  if (!bundle.ok) {
    throw new Error('local auth migration: the committed bundle is invalid');
  }

  const password = process.env.LOCAL_AUTH_MIGRATOR_PASSWORD;

  if (typeof password !== 'string' || password.length === 0) {
    throw new Error(
      'local auth migration: LOCAL_AUTH_MIGRATOR_PASSWORD is required',
    );
  }

  const result = await runMigration(
    {
      operation: 'apply',
      run_id: `local-${Date.now()}`,
      commit_sha: bundle.bundle.manifest.commit_sha,
      expected_manifest_sha256: bundle.bundle.manifestSha256,
    },
    {
      loadCredential: async () => ({
        ok: true,
        credential: { username: 'auth_migrator', password },
      }),
      // This local-only entry point reuses the runner without changing Lambda authorization.
      invokedFunctionArn: () =>
        'arn:aws:lambda:local:000000000000:function:gootip-auth:deployment',
    },
  );

  console.log(JSON.stringify(result));

  if (
    result.status === 'failed' ||
    result.status === 'baseline_approval_required'
  ) {
    process.exitCode = 1;
  }
};

await main();
