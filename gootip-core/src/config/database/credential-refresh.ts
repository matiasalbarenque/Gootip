export interface CredentialRefreshTiming {
  refreshIntervalMs: number;
  retryMs: number;
  maxStaleMs: number;
  drainTimeoutMs: number;
}

const readSeconds = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER / 1000
  ) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
};

export const readCredentialRefreshTiming = (
  env: NodeJS.ProcessEnv = process.env,
): CredentialRefreshTiming => {
  const refreshIntervalSeconds = readSeconds(
    env,
    'DB_CREDENTIAL_REFRESH_INTERVAL_SECONDS',
    300,
  );
  const retrySeconds = readSeconds(
    env,
    'DB_CREDENTIAL_REFRESH_RETRY_SECONDS',
    30,
  );
  const maxStaleSeconds = readSeconds(
    env,
    'DB_CREDENTIAL_MAX_STALE_SECONDS',
    900,
  );
  const drainTimeoutSeconds = readSeconds(
    env,
    'DB_CREDENTIAL_DRAIN_TIMEOUT_SECONDS',
    5,
  );

  if (retrySeconds >= refreshIntervalSeconds) {
    throw new Error(
      'DB_CREDENTIAL_REFRESH_RETRY_SECONDS must be below the refresh interval.',
    );
  }
  if (maxStaleSeconds <= refreshIntervalSeconds) {
    throw new Error(
      'DB_CREDENTIAL_MAX_STALE_SECONDS must exceed the refresh interval.',
    );
  }

  return {
    refreshIntervalMs: refreshIntervalSeconds * 1000,
    retryMs: retrySeconds * 1000,
    maxStaleMs: maxStaleSeconds * 1000,
    drainTimeoutMs: drainTimeoutSeconds * 1000,
  };
};

export interface CoreCredentialRefreshCoordinator {
  ensureFresh(
    remainingTimeMs?: number,
    databaseAuthenticationRejected?: boolean,
  ): Promise<void>;
}

export const createCoreCredentialRefreshCoordinator = (options: {
  activeVersionId: string;
  timing: CredentialRefreshTiming;
  loadCurrent: (timeoutMs: number) => Promise<{
    versionId: string;
    username: string;
    password: string;
  }>;
  activateCandidate?: (
    candidate: {
      versionId: string;
      username: string;
      password: string;
    },
    timeoutMs: number,
  ) => Promise<void>;
  now?: () => number;
}): CoreCredentialRefreshCoordinator => {
  const now = options.now ?? Date.now;
  let activeVersionId = options.activeVersionId;
  let lastSuccessAt = now();
  let nextRefreshAt = lastSuccessAt + options.timing.refreshIntervalMs;
  let nextRetryAt = 0;
  let inFlight: Promise<void> | undefined;

  const ensureFresh = async (
    remainingTimeMs = Number.MAX_SAFE_INTEGER,
    databaseAuthenticationRejected = false,
  ): Promise<void> => {
    const currentTime = now();
    if (currentTime - lastSuccessAt > options.timing.maxStaleMs) {
      throw new Error('Credential state is stale.');
    }
    if (inFlight) return inFlight;
    if (
      currentTime < nextRetryAt ||
      (!databaseAuthenticationRejected && currentTime < nextRefreshAt)
    )
      return;
    const timeoutMs = Math.min(
      5_000,
      (remainingTimeMs - options.timing.drainTimeoutMs) / 2,
    );
    if (timeoutMs <= 0) {
      nextRetryAt = currentTime + options.timing.retryMs;
      return;
    }

    inFlight = (async () => {
      const startedAt = now();
      try {
        const candidate = await options.loadCurrent(timeoutMs);
        if (
          databaseAuthenticationRejected &&
          candidate.versionId === activeVersionId
        ) {
          throw new Error('The rejected database credential is still current.');
        }
        if (candidate.versionId !== activeVersionId) {
          if (!options.activateCandidate) {
            throw new Error('Credential version changed.');
          }
          const activationTimeoutMs = Math.min(
            timeoutMs,
            remainingTimeMs -
              (now() - startedAt) -
              options.timing.drainTimeoutMs,
          );
          if (activationTimeoutMs <= 0) {
            throw new Error('Insufficient invocation time for replacement.');
          }
          await options.activateCandidate(candidate, activationTimeoutMs);
          activeVersionId = candidate.versionId;
        }
        lastSuccessAt = now();
        nextRefreshAt = lastSuccessAt + options.timing.refreshIntervalMs;
        nextRetryAt = 0;
      } catch {
        nextRetryAt = now() + options.timing.retryMs;
        if (now() - lastSuccessAt > options.timing.maxStaleMs) {
          throw new Error('Credential refresh unavailable.');
        }
      } finally {
        inFlight = undefined;
      }
    })();

    return inFlight;
  };

  return { ensureFresh };
};
