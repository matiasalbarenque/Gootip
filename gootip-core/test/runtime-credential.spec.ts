import type { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadCoreRuntimeCredential,
  RUNTIME_DB_USERNAME,
} from '../src/config/database/runtime-credential.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const validOutput = (overrides: Record<string, unknown> = {}) => ({
  SecretString: JSON.stringify({
    username: RUNTIME_DB_USERNAME,
    password: 'runtime-password',
    ...overrides,
  }),
  VersionId: 'core-db-version-1',
});

describe('loadCoreRuntimeCredential', () => {
  it('loads AWSCURRENT and applies the exact runtime identity before app startup', async () => {
    process.env.CORE_RUNTIME_SECRET_ARN = 'core-runtime-secret-arn';
    process.env.POSTGRES_DB_USER = 'core_migrator';
    process.env.POSTGRES_DB_PASSWORD = 'stale-password';
    const send = vi.fn().mockResolvedValue(validOutput());

    await expect(loadCoreRuntimeCredential({ send })).resolves.toEqual({
      versionId: 'core-db-version-1',
      username: RUNTIME_DB_USERNAME,
      password: 'runtime-password',
    });

    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      SecretId: 'core-runtime-secret-arn',
      VersionStage: 'AWSCURRENT',
    });
    expect(process.env.POSTGRES_DB_USER).toBe(RUNTIME_DB_USERNAME);
    expect(process.env.POSTGRES_DB_PASSWORD).toBe('runtime-password');
  });

  it('requires the exact runtime secret reference', async () => {
    delete process.env.CORE_RUNTIME_SECRET_ARN;
    const send = vi.fn();

    await expect(loadCoreRuntimeCredential({ send })).rejects.toThrow(
      'CORE_RUNTIME_SECRET_ARN must be set for the AWS API runtime.',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a username other than core_runtime without exposing the payload', async () => {
    process.env.CORE_RUNTIME_SECRET_ARN = 'core-runtime-secret-arn';

    await expect(
      loadCoreRuntimeCredential({
        send: vi
          .fn()
          .mockResolvedValue(validOutput({ username: 'core_migrator' })),
      }),
    ).rejects.toThrow('CORE_RUNTIME_SECRET_ARN username must be core_runtime.');
  });

  it('sanitizes retrieval, JSON, and missing-password failures', async () => {
    process.env.CORE_RUNTIME_SECRET_ARN = 'core-runtime-secret-arn';
    const raw = new Error('secret payload leaked-password');

    const retrievalError = await loadCoreRuntimeCredential({
      send: vi.fn(async (_command: GetSecretValueCommand) => {
        throw raw;
      }),
    }).catch((error: unknown) => error);
    expect((retrievalError as Error).message).toBe(
      'CORE_RUNTIME_SECRET_ARN could not be retrieved from Secrets Manager.',
    );
    expect((retrievalError as Error).cause).toBeUndefined();

    await expect(
      loadCoreRuntimeCredential({
        send: vi.fn().mockResolvedValue({
          SecretString: 'not-json',
          VersionId: 'core-db-version-1',
        }),
      }),
    ).rejects.toThrow('CORE_RUNTIME_SECRET_ARN is not valid JSON.');

    await expect(
      loadCoreRuntimeCredential({
        send: vi.fn().mockResolvedValue(validOutput({ password: '' })),
      }),
    ).rejects.toThrow(
      'CORE_RUNTIME_SECRET_ARN is missing the runtime password.',
    );
  });
});
