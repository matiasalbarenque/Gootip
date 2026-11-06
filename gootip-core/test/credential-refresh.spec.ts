import { describe, expect, it, vi } from 'vitest';

import {
  createCoreCredentialRefreshCoordinator,
  readCredentialRefreshTiming,
} from '../src/config/database/credential-refresh.js';

const timing = {
  refreshIntervalMs: 300,
  retryMs: 30,
  maxStaleMs: 900,
  drainTimeoutMs: 5,
};

describe('Core credential refresh coordinator', () => {
  it('validates timing inputs and defaults', () => {
    expect(readCredentialRefreshTiming({})).toEqual({
      refreshIntervalMs: 300_000,
      retryMs: 30_000,
      maxStaleMs: 900_000,
      drainTimeoutMs: 5_000,
    });
    expect(() =>
      readCredentialRefreshTiming({
        DB_CREDENTIAL_REFRESH_INTERVAL_SECONDS: '0',
      }),
    ).toThrow(
      'DB_CREDENTIAL_REFRESH_INTERVAL_SECONDS must be a positive integer.',
    );
  });

  it('refreshes only when due and shares concurrent refresh triggers', async () => {
    let clock = 0;
    let finish!: (credential: {
      versionId: string;
      username: string;
      password: string;
    }) => void;
    const loadCurrent = vi.fn(
      () =>
        new Promise<{ versionId: string; username: string; password: string }>(
          (resolve) => (finish = resolve),
        ),
    );
    const coordinator = createCoreCredentialRefreshCoordinator({
      activeVersionId: 'db-v1',
      timing,
      loadCurrent,
      now: () => clock,
    });

    await coordinator.ensureFresh();
    expect(loadCurrent).not.toHaveBeenCalled();
    clock = 300;
    const first = coordinator.ensureFresh();
    const second = coordinator.ensureFresh();
    expect(loadCurrent).toHaveBeenCalledTimes(1);
    finish({ versionId: 'db-v1', username: 'core_runtime', password: 'p' });
    await Promise.all([first, second]);
  });

  it('backs off on invalid/changed versions and fails closed after frozen stale time', async () => {
    let clock = 0;
    const loadCurrent = vi.fn().mockResolvedValue({
      versionId: 'db-v2',
      username: 'core_runtime',
      password: 'p',
    });
    const coordinator = createCoreCredentialRefreshCoordinator({
      activeVersionId: 'db-v1',
      timing,
      loadCurrent,
      now: () => clock,
    });

    clock = 300;
    await coordinator.ensureFresh();
    expect(loadCurrent).toHaveBeenCalledTimes(1);
    clock = 901;
    await expect(coordinator.ensureFresh()).rejects.toThrow(
      'Credential state is stale.',
    );
  });

  it('keeps refresh bounded by the invocation time remaining after drain reserve', async () => {
    let clock = 0;
    const loadCurrent = vi.fn(async () => ({
      versionId: 'db-v1',
      username: 'core_runtime',
      password: 'p',
    }));
    const coordinator = createCoreCredentialRefreshCoordinator({
      activeVersionId: 'db-v1',
      timing,
      loadCurrent,
      now: () => clock,
    });
    clock = 300;

    await coordinator.ensureFresh(5);
    expect(loadCurrent).not.toHaveBeenCalled();
  });

  it('activates a changed generation only through the validation callback', async () => {
    let clock = 0;
    const candidate = {
      versionId: 'db-v2',
      username: 'core_runtime',
      password: 'candidate-password',
    };
    const activateCandidate = vi.fn(async () => undefined);
    const coordinator = createCoreCredentialRefreshCoordinator({
      activeVersionId: 'db-v1',
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
