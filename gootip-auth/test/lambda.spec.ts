import type { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadSecretsToEnv, RUNTIME_DB_USERNAME } from '../src/lambda.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const runtimeSecret = (
  overrides: Record<string, unknown> = {},
): { SecretString: string; VersionId: string } => ({
  SecretString: JSON.stringify({
    username: RUNTIME_DB_USERNAME,
    password: 'loaded-db-password',
    ...overrides,
  }),
  VersionId: 'db-version-1',
});

/** Answers the app secret for any non-runtime ARN and the runtime secret. */
const sendFor = (
  runtime: { SecretString?: string; VersionId?: string },
  appSecret = '{"BETTER_AUTH_SECRET":"loaded-auth-secret"}',
) =>
  vi.fn(async (command: GetSecretValueCommand) => {
    if (command.input.SecretId === 'app-secret') {
      return { SecretString: appSecret, VersionId: 'signing-version-1' };
    }

    return runtime;
  });

describe('loadSecretsToEnv', () => {
  it('requires the application secret reference for the AWS runtime', async () => {
    delete process.env.SECRET_ARN;
    const send = vi.fn();

    await expect(loadSecretsToEnv({ send })).rejects.toThrow(
      'SECRET_ARN must be set for the AWS API runtime.',
    );

    expect(send).not.toHaveBeenCalled();
  });

  it('loads the auth secret and runtime credential in parallel', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.POSTGRES_DB_USER;
    delete process.env.POSTGRES_DB_PASSWORD;

    const send = sendFor(runtimeSecret());

    const versions = await loadSecretsToEnv({ send });

    expect(send).toHaveBeenCalledTimes(3);
    expect(versions).toMatchObject({
      databaseVersionId: 'db-version-1',
      signingSecretVersionId: 'signing-version-1',
      username: RUNTIME_DB_USERNAME,
      password: 'loaded-db-password',
      signingSecret: 'loaded-auth-secret',
      signingSecrets: [{ version: 1, value: 'loaded-auth-secret' }],
    });
    expect(
      send.mock.calls.map(([command]) => command.input.VersionStage),
    ).toEqual(['AWSCURRENT', 'AWSPREVIOUS', 'AWSCURRENT']);
    expect(process.env.BETTER_AUTH_SECRET).toBe('loaded-auth-secret');
    expect(process.env.POSTGRES_DB_USER).toBe(RUNTIME_DB_USERNAME);
    expect(process.env.POSTGRES_DB_PASSWORD).toBe('loaded-db-password');
  });

  it('uses the current signing-secret value and runtime credential', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';
    process.env.BETTER_AUTH_SECRET = 'stale-auth-secret';
    process.env.POSTGRES_DB_PASSWORD = 'existing-db-password';

    await loadSecretsToEnv({ send: sendFor(runtimeSecret()) });

    expect(process.env.BETTER_AUTH_SECRET).toBe('loaded-auth-secret');
    expect(process.env.POSTGRES_DB_PASSWORD).toBe('loaded-db-password');
  });

  it('does not accept a username other than the runtime role', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';

    await expect(
      loadSecretsToEnv({
        send: sendFor(runtimeSecret({ username: 'master-like-role' })),
      }),
    ).rejects.toThrow(
      `DB_RUNTIME_SECRET_ARN username must be ${RUNTIME_DB_USERNAME}.`,
    );
  });

  it('rejects a runtime credential without a username', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';

    await expect(
      loadSecretsToEnv({
        send: sendFor(runtimeSecret({ username: undefined })),
      }),
    ).rejects.toThrow('DB_RUNTIME_SECRET_ARN is missing the runtime username.');
  });

  it('rejects a runtime credential without a password', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';

    await expect(
      loadSecretsToEnv({
        send: sendFor(runtimeSecret({ password: '' })),
      }),
    ).rejects.toThrow('DB_RUNTIME_SECRET_ARN is missing the runtime password.');
  });

  it('fails when a secret contains invalid JSON', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';

    const send = vi.fn().mockResolvedValue({ SecretString: 'not-json' });

    await expect(loadSecretsToEnv({ send })).rejects.toThrow(
      'SECRET_ARN is not valid JSON.',
    );
  });

  it('requires the runtime secret ARN', async () => {
    process.env.SECRET_ARN = 'app-secret';
    delete process.env.DB_RUNTIME_SECRET_ARN;

    await expect(loadSecretsToEnv({ send: vi.fn() })).rejects.toThrow(
      'DB_RUNTIME_SECRET_ARN must be set for the AWS API runtime.',
    );
  });

  it('rejects a secret without a string value', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';

    const send = vi.fn().mockResolvedValue({});

    await expect(loadSecretsToEnv({ send })).rejects.toThrow(
      'SECRET_ARN holds no string value.',
    );
  });

  it('rejects a secret whose JSON value is not an object', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';

    const send = vi.fn().mockResolvedValue({ SecretString: '[]' });

    await expect(loadSecretsToEnv({ send })).rejects.toThrow(
      'SECRET_ARN is not a JSON object.',
    );
  });

  it('rejects a secret with a missing required key', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';
    delete process.env.BETTER_AUTH_SECRET;

    const send = sendFor(runtimeSecret(), '{}');

    await expect(loadSecretsToEnv({ send })).rejects.toThrow(
      'Required key BETTER_AUTH_SECRET is missing or empty.',
    );
  });

  it('replaces a Secrets Manager failure with a sanitized message', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';

    const send = vi.fn(async (command: GetSecretValueCommand) => {
      if (command.input.SecretId === 'app-secret') {
        return {
          SecretString: '{"BETTER_AUTH_SECRET":"loaded-auth-secret"}',
          VersionId: 'signing-version-1',
        };
      }

      throw new Error(
        `AccessDeniedException for ${String(command.input.SecretId)} with payload {"password":"leaked-password"}`,
      );
    });

    const caught = await loadSecretsToEnv({ send }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'DB_RUNTIME_SECRET_ARN could not be retrieved from Secrets Manager.',
    );
    expect((caught as Error).message).not.toContain('runtime-secret');
    expect((caught as Error).message).not.toContain('leaked-password');
    expect((caught as Error).cause).toBeUndefined();
  });

  it('sanitizes an application-secret failure the same way', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';

    const send = vi.fn(async (command: GetSecretValueCommand) => {
      if (command.input.SecretId === 'app-secret') {
        throw new Error(
          'ResourceNotFoundException for app-secret with payload {"BETTER_AUTH_SECRET":"leaked-secret"}',
        );
      }

      return runtimeSecret();
    });

    const caught = await loadSecretsToEnv({ send }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((caught as Error).message).toBe(
      'SECRET_ARN could not be retrieved from Secrets Manager.',
    );
    expect((caught as Error).message).not.toContain('leaked-secret');
  });

  it('loads current and previous Better Auth keys by explicit version', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';
    const send = vi.fn(async (command: GetSecretValueCommand) => {
      if (command.input.SecretId === 'runtime-secret') return runtimeSecret();
      return command.input.VersionStage === 'AWSPREVIOUS'
        ? {
            SecretString: JSON.stringify({
              BETTER_AUTH_SECRET: 'second-secret',
              BETTER_AUTH_SECRET_VERSION: 2,
              BETTER_AUTH_PREVIOUS_SECRETS: [
                { version: 1, value: 'old-secret' },
              ],
            }),
            VersionId: 'signing-v2',
          }
        : {
            SecretString: JSON.stringify({
              BETTER_AUTH_SECRET: 'new-secret',
              BETTER_AUTH_SECRET_VERSION: 3,
              BETTER_AUTH_PREVIOUS_SECRETS: [
                { version: 1, value: 'old-secret' },
              ],
            }),
            VersionId: 'signing-v3',
          };
    });

    const result = await loadSecretsToEnv({ send });

    expect(result.signingSecrets).toEqual([
      { version: 3, value: 'new-secret' },
      { version: 2, value: 'second-secret' },
      { version: 1, value: 'old-secret' },
    ]);
    expect(process.env.BETTER_AUTH_SECRET).toBe('new-secret');
  });

  it('fails closed when a rotated signing secret has no previous key', async () => {
    process.env.SECRET_ARN = 'app-secret';
    process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';
    const send = vi.fn(async (command: GetSecretValueCommand) => {
      if (command.input.SecretId === 'runtime-secret') return runtimeSecret();
      if (command.input.VersionStage === 'AWSPREVIOUS') {
        const error = new Error('not found');
        error.name = 'ResourceNotFoundException';
        throw error;
      }
      return {
        SecretString: JSON.stringify({
          BETTER_AUTH_SECRET: 'new-secret',
          BETTER_AUTH_SECRET_VERSION: 2,
        }),
        VersionId: 'signing-v2',
      };
    });

    await expect(loadSecretsToEnv({ send })).rejects.toThrow(
      'SECRET_ARN previous signing-secret version is unavailable.',
    );
  });
});
