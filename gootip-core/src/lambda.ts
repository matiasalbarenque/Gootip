import { configure } from '@codegenie/serverless-express';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { DataSource } from 'typeorm';

import { createApp } from './app.js';
import { runWithInvocation } from './config/auth/request-context.js';
import {
  createCoreCredentialRefreshCoordinator,
  readCredentialRefreshTiming,
  type CoreCredentialRefreshCoordinator,
} from './config/database/credential-refresh.js';
import {
  loadCoreRuntimeCredential,
  RUNTIME_DB_USERNAME,
} from './config/database/runtime-credential.js';

type LambdaHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyResultV2>;

interface CoreGeneration {
  handler: LambdaHandler;
  dataSource?: DataSource;
  close(): Promise<void>;
  closePromise?: Promise<void>;
  activeRequests: number;
  drainWaiters: Array<() => void>;
  runtimeIdentity?: {
    username: string;
    backend_pid: number;
    tls: boolean;
    tls_version: string;
  };
  runtimeIdentityLogged?: boolean;
}

let cachedGeneration: Promise<CoreGeneration> | undefined;
let credentialRefresh: CoreCredentialRefreshCoordinator | undefined;
let activeGeneration: CoreGeneration | undefined;
let retiringGeneration: CoreGeneration | undefined;
let admissionBlocked = false;
let failedCandidateCleanup: Promise<void> | undefined;
let configuredDrainTimeoutMs = 5_000;

const createGeneration = async (
  credential: { username: string; password: string },
  timeoutMs: number | undefined,
  validateConnection: boolean,
): Promise<CoreGeneration> => {
  const previous = {
    POSTGRES_DB_USER: process.env.POSTGRES_DB_USER,
    POSTGRES_DB_PASSWORD: process.env.POSTGRES_DB_PASSWORD,
    POSTGRES_DB_CONNECT_TIMEOUT_MS: process.env.POSTGRES_DB_CONNECT_TIMEOUT_MS,
    POSTGRES_DB_QUERY_TIMEOUT_MS: process.env.POSTGRES_DB_QUERY_TIMEOUT_MS,
  };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let runtimeIdentity: CoreGeneration['runtimeIdentity'];
  try {
    process.env.POSTGRES_DB_USER = credential.username;
    process.env.POSTGRES_DB_PASSWORD = credential.password;
    if (timeoutMs !== undefined) {
      const phaseTimeoutMs = Math.max(1, Math.floor(timeoutMs / 2));
      process.env.POSTGRES_DB_CONNECT_TIMEOUT_MS = String(phaseTimeoutMs);
      process.env.POSTGRES_DB_QUERY_TIMEOUT_MS = String(phaseTimeoutMs);
    }
    if (validateConnection && process.env.POSTGRES_SSL_MODE !== 'verify-full') {
      throw new Error('Database credential validation requires verified TLS.');
    }
    app = await createApp();
    await app.init();
    const dataSource = validateConnection ? app.get(DataSource) : undefined;
    if (dataSource) {
      const rows = (await dataSource.query(
        `SELECT current_user AS username,
                pg_backend_pid() AS backend_pid,
                ssl.ssl AS tls,
                ssl.version AS tls_version
           FROM pg_stat_ssl AS ssl
          WHERE ssl.pid = pg_backend_pid()`,
      )) as Array<{
        username: string;
        backend_pid: number;
        tls: boolean;
        tls_version: string | null;
      }>;
      const identity = rows[0];
      if (
        identity?.username !== RUNTIME_DB_USERNAME ||
        identity.tls !== true ||
        typeof identity.tls_version !== 'string' ||
        identity.tls_version.length === 0
      ) {
        throw new Error('Database identity validation failed.');
      }
      runtimeIdentity = {
        username: identity.username,
        backend_pid: identity.backend_pid,
        tls: identity.tls,
        tls_version: identity.tls_version,
      };
    }
    const serverlessHandler = configure<
      APIGatewayProxyEventV2,
      APIGatewayProxyResultV2
    >({ app: app.getHttpAdapter().getInstance() });
    return {
      handler: serverlessHandler as unknown as LambdaHandler,
      dataSource,
      close: () => app!.close(),
      activeRequests: 0,
      drainWaiters: [],
      runtimeIdentity,
      runtimeIdentityLogged: false,
    };
  } catch {
    if (app) {
      const cleanup = app.close();
      if (!(await waitFor(cleanup, timeoutMs ?? 5_000))) {
        failedCandidateCleanup = cleanup;
        admissionBlocked = true;
      }
    }
    throw new Error('Database credential candidate validation failed.');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const waitFor = async (operation: Promise<unknown>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const drainAndCloseRetiring = async (timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  if (failedCandidateCleanup) {
    if (!(await waitFor(failedCandidateCleanup, remaining()))) return false;
    failedCandidateCleanup = undefined;
  }
  const retiring = retiringGeneration;
  if (!retiring) {
    admissionBlocked = false;
    return true;
  }
  if (retiring.activeRequests > 0) {
    const drained = await waitFor(
      new Promise<void>((resolve) => retiring.drainWaiters.push(resolve)),
      remaining(),
    );
    if (!drained) return false;
  }
  retiring.closePromise ??= retiring.close();
  if (!(await waitFor(retiring.closePromise, remaining()))) return false;
  if (retiringGeneration === retiring) retiringGeneration = undefined;
  admissionBlocked = false;
  return true;
};

const bootstrap = async (
  loadRuntimeSecret: boolean,
  remainingTimeMs: number,
): Promise<CoreGeneration> => {
  let activeCredential = {
    versionId: '',
    username: process.env.POSTGRES_DB_USER ?? '',
    password: process.env.POSTGRES_DB_PASSWORD ?? '',
  };
  const timing = loadRuntimeSecret ? readCredentialRefreshTiming() : undefined;
  const credentialLoadStartedAt = Date.now();
  if (loadRuntimeSecret) {
    configuredDrainTimeoutMs = timing!.drainTimeoutMs;
    const initialLoadTimeoutMs = Math.min(
      5_000,
      remainingTimeMs - timing!.drainTimeoutMs,
    );
    if (initialLoadTimeoutMs <= 0) {
      throw new Error(
        'Insufficient invocation time to initialize credentials.',
      );
    }
    if (failedCandidateCleanup) {
      if (!(await waitFor(failedCandidateCleanup, initialLoadTimeoutMs))) {
        throw new Error('Prior candidate cleanup is incomplete.');
      }
      failedCandidateCleanup = undefined;
    }
    activeCredential = await loadCoreRuntimeCredential(
      undefined,
      initialLoadTimeoutMs,
    );
  }

  const generationTimeoutMs = loadRuntimeSecret
    ? Math.min(
        5_000,
        remainingTimeMs -
          (Date.now() - credentialLoadStartedAt) -
          timing!.drainTimeoutMs,
      )
    : undefined;
  if (generationTimeoutMs !== undefined && generationTimeoutMs <= 0) {
    throw new Error('Insufficient invocation time to initialize the client.');
  }
  const generation = await createGeneration(
    activeCredential,
    generationTimeoutMs,
    loadRuntimeSecret,
  );
  activeGeneration = generation;

  if (loadRuntimeSecret) {
    credentialRefresh = createCoreCredentialRefreshCoordinator({
      activeVersionId: activeCredential.versionId,
      timing: timing!,
      loadCurrent: async (timeoutMs) => {
        const previousUser = process.env.POSTGRES_DB_USER;
        const previousPassword = process.env.POSTGRES_DB_PASSWORD;
        try {
          return await loadCoreRuntimeCredential(undefined, timeoutMs);
        } finally {
          if (previousUser === undefined) delete process.env.POSTGRES_DB_USER;
          else process.env.POSTGRES_DB_USER = previousUser;
          if (previousPassword === undefined)
            delete process.env.POSTGRES_DB_PASSWORD;
          else process.env.POSTGRES_DB_PASSWORD = previousPassword;
        }
      },
      activateCandidate: async (candidate, timeoutMs) => {
        if (
          (retiringGeneration || failedCandidateCleanup) &&
          !(await drainAndCloseRetiring(timing!.drainTimeoutMs))
        ) {
          admissionBlocked = true;
          throw new Error('Retiring client cleanup is incomplete.');
        }
        const next = await createGeneration(candidate, timeoutMs, true);
        const previous = activeGeneration;
        activeGeneration = next;
        if (previous) retiringGeneration = previous;
        if (!(await drainAndCloseRetiring(timing!.drainTimeoutMs))) {
          admissionBlocked = true;
        }
      },
    });
  }
  return generation;
};

const checkPoolConnection = async (dataSource: DataSource) => {
  const runner = dataSource.createQueryRunner();
  try {
    await runner.connect();
  } finally {
    await runner.release();
  }
};

/** Caches one complete Nest/DataSource generation per execution environment. */
export const handler: LambdaHandler = async (event, context) => {
  const isLambda = Boolean(context.invokedFunctionArn);
  cachedGeneration ??= bootstrap(
    isLambda,
    isLambda ? context.getRemainingTimeInMillis() : Number.MAX_SAFE_INTEGER,
  );

  let generation: CoreGeneration;
  try {
    generation = await cachedGeneration;
  } catch {
    cachedGeneration = undefined;
    credentialRefresh = undefined;
    activeGeneration = undefined;
    return { statusCode: 503, body: '{"error":"service_unavailable"}' };
  }

  if (isLambda) {
    try {
      await credentialRefresh?.ensureFresh(context.getRemainingTimeInMillis());
      const remainingTimeMs = context.getRemainingTimeInMillis();
      if (
        (retiringGeneration || failedCandidateCleanup) &&
        (remainingTimeMs < configuredDrainTimeoutMs ||
          !(await drainAndCloseRetiring(
            Math.min(configuredDrainTimeoutMs, remainingTimeMs),
          )))
      ) {
        admissionBlocked = true;
      }
      if (admissionBlocked || !activeGeneration) {
        throw new Error('Database admission is blocked.');
      }
      generation = activeGeneration;
      if (
        generation.dataSource &&
        /^\/api\/(?:admin\/)?(?:categories|products)(?:\/|$)/.test(
          event.rawPath,
        ) &&
        event.requestContext.http.method !== 'OPTIONS'
      ) {
        // Probe before dispatch so a reconnect can recover without replaying SQL.
        try {
          await checkPoolConnection(generation.dataSource);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== '28P01'
          ) {
            throw error;
          }
          if (activeGeneration === generation) {
            await credentialRefresh?.ensureFresh(
              context.getRemainingTimeInMillis(),
              true,
            );
          }
          if (
            admissionBlocked ||
            !activeGeneration?.dataSource ||
            activeGeneration === generation
          ) {
            throw new Error(
              'No replacement database credential was activated.',
            );
          }
          generation = activeGeneration;
          await checkPoolConnection(activeGeneration.dataSource);
        }
        if (admissionBlocked || generation !== activeGeneration) {
          throw new Error(
            'Database admission changed during connection validation.',
          );
        }
      }
    } catch {
      return { statusCode: 503, body: '{"error":"service_unavailable"}' };
    }
  }

  if (generation.runtimeIdentity && !generation.runtimeIdentityLogged) {
    console.info(
      JSON.stringify({
        event: 'runtime_database_connection_validated',
        service: 'core',
        ...generation.runtimeIdentity,
      }),
    );
    generation.runtimeIdentityLogged = true;
  }

  generation.activeRequests += 1;
  try {
    return await runWithInvocation(event, () =>
      generation.handler(event, context),
    );
  } finally {
    generation.activeRequests -= 1;
    if (generation.activeRequests === 0) {
      for (const resolve of generation.drainWaiters.splice(0)) resolve();
    }
  }
};
