import { describe, expect, it, vi } from 'vitest';

import {
  createAuthCredentialRefreshCoordinator,
  readCredentialRefreshTiming,
} from '../src/config/credential-refresh.js';

const versions = {
  databaseVersionId: 'db-v1',
  signingSecretVersionId: 'signing-v1',
};
const timing = {
  refreshIntervalMs: 300,
  retryMs: 30,
  maxStaleMs: 900,
  drainTimeoutMs: 5,
};

describe('Auth credential refresh coordinator', () => {
  it('validates timing inputs and defaults', () => {
    expect(readCredentialRefreshTiming({})).toEqual({
      refreshIntervalMs: 300_000,
      retryMs: 30_000,
      maxStaleMs: 900_000,
      drainTimeoutMs: 5_000,
    });
    expect(() =>
      readCredentialRefreshTiming({
        DB_CREDENTIAL_REFRESH_RETRY_SECONDS: '300',
      }),
    ).toThrow(
      'DB_CREDENTIAL_REFRESH_RETRY_SECONDS must be below the refresh interval.',
    );
    expect(() =>
      readCredentialRefreshTiming({ DB_CREDENTIAL_MAX_STALE_SECONDS: '300' }),
    ).toThrow(
      'DB_CREDENTIAL_MAX_STALE_SECONDS must exceed the refresh interval.',
    );
    expect(() =>
      readCredentialRefreshTiming({
        DB_CREDENTIAL_DRAIN_TIMEOUT_SECONDS: 'NaN',
      }),
    ).toThrow(
      'DB_CREDENTIAL_DRAIN_TIMEOUT_SECONDS must be a positive integer.',
    );
  });

  it('does not poll before due and renews freshness for an unchanged version', async () => {
    let clock = 1_000;
    const loadCurrent = vi.fn(async () => versions);
    const coordinator = createAuthCredentialRefreshCoordinator({
      activeVersions: versions,
      timing,
      loadCurrent,
      now: () => clock,
    });

    clock += 299;
    await coordinator.ensureFresh();
    expect(loadCurrent).not.toHaveBeenCalled();
    clock += 1;
    await coordinator.ensureFresh();
    expect(loadCurrent).toHaveBeenCalledTimes(1);
    clock += 300;
    await coordinator.ensureFresh();
    expect(loadCurrent).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight refresh and applies the retry cooldown on failure', async () => {
    let clock = 0;
    let finish!: (value: typeof versions) => void;
    const loadCurrent = vi.fn(
      () => new Promise<typeof versions>((resolve) => (finish = resolve)),
    );
    const coordinator = createAuthCredentialRefreshCoordinator({
      activeVersions: versions,
      timing,
      loadCurrent,
      now: () => clock,
    });
    clock = 300;

    const first = coordinator.ensureFresh();
    const second = coordinator.ensureFresh();
    expect(loadCurrent).toHaveBeenCalledTimes(1);
    finish(versions);
    await Promise.all([first, second]);

    const failedLoad = vi
      .fn()
      .mockRejectedValue(new Error('sensitive SDK detail'));
    const failed = createAuthCredentialRefreshCoordinator({
      activeVersions: versions,
      timing,
      loadCurrent: failedLoad,
      now: () => clock,
    });
    clock += 300;
    await failed.ensureFresh();
    clock += 29;
    await failed.ensureFresh();
    expect(failedLoad).toHaveBeenCalledTimes(1);
    clock += 1;
    await failed.ensureFresh();
    expect(failedLoad).toHaveBeenCalledTimes(2);
  });

  it('keeps old credentials only through max stale age, including frozen time', async () => {
    let clock = 0;
    const changed = {
      databaseVersionId: 'db-v2',
      signingSecretVersionId: 'signing-v1',
    };
    const coordinator = createAuthCredentialRefreshCoordinator({
      activeVersions: versions,
      timing,
      loadCurrent: async () => changed,
      now: () => clock,
    });

    clock = 300;
    await coordinator.ensureFresh();
    clock = 901;
    await expect(coordinator.ensureFresh()).rejects.toThrow(
      'Credential state is stale.',
    );
  });

  it('does not start a refresh without enough invocation time for cleanup', async () => {
    let clock = 0;
    const loadCurrent = vi.fn(async () => versions);
    const coordinator = createAuthCredentialRefreshCoordinator({
      activeVersions: versions,
      timing,
      loadCurrent,
      now: () => clock,
    });
    clock = 300;

    await coordinator.ensureFresh(5);
    expect(loadCurrent).not.toHaveBeenCalled();
  });

  it('activates a changed database generation once after validation callback succeeds', async () => {
    let clock = 0;
    const candidate = {
      databaseVersionId: 'db-v2',
      signingSecretVersionId: 'signing-v1',
      username: 'auth_runtime',
      password: 'candidate-password',
      signingSecret: 'existing-signing-secret',
    };
    const activateCandidate = vi.fn(async () => undefined);
    const coordinator = createAuthCredentialRefreshCoordinator({
      activeVersions: versions,
      timing,
      loadCurrent: async () => candidate,
      activateCandidate,
      now: () => clock,
    });
    clock = 300;

    await coordinator.ensureFresh();
    clock = 600;
    await coordinator.ensureFresh();

    expect(activateCandidate).toHaveBeenCalledTimes(1);
    expect(activateCandidate).toHaveBeenCalledWith(candidate, 5_000);
  });
});
