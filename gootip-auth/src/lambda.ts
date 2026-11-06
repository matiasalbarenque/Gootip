import { isIP } from 'node:net';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import { handle, type LambdaContext, type LambdaEvent } from '@hono/aws-lambda';
import type { Pool } from 'pg';

import { createApp } from './app.js';
import { createAuth, createPostgresPool } from './auth/auth.js';
import {
  createAuthCredentialRefreshCoordinator,
  readCredentialRefreshTiming,
  type AuthCredentialCandidate,
  type AuthCredentialRefreshCoordinator,
} from './config/credential-refresh.js';
import { readEnv } from './config/env.js';

interface SecretClient {
  send(
    command: GetSecretValueCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<
    Pick<GetSecretValueCommandOutput, 'SecretString' | 'VersionId'> | undefined
  >;
}

const fetchSecretJson = async (
  client: SecretClient,
  secretArn: string,
  source: string,
  timeoutMs: number,
  stage = 'AWSCURRENT',
  optional = false,
): Promise<
  { value: Record<string, unknown>; versionId: string } | undefined
> => {
  let output:
    | Pick<GetSecretValueCommandOutput, 'SecretString' | 'VersionId'>
    | undefined;

  try {
    output = await client.send(
      new GetSecretValueCommand({
        SecretId: secretArn,
        VersionStage: stage,
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (error) {
    if (
      optional &&
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'ResourceNotFoundException'
    ) {
      return undefined;
    }
    // The SDK error can echo the secret ARN, the request payload, and other
    // request internals into Lambda logs, so it is replaced with one stable
    // message that names only the environment variable being loaded.
    throw new Error(`${source} could not be retrieved from Secrets Manager.`);
  }

  if (!output?.SecretString) {
    throw new Error(`${source} holds no string value.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.SecretString);
  } catch {
    throw new Error(`${source} is not valid JSON.`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} is not a JSON object.`);
  }

  if (typeof output.VersionId !== 'string' || output.VersionId.length === 0) {
    throw new Error(`${source} has no version identifier.`);
  }

  return {
    value: parsed as Record<string, unknown>,
    versionId: output.VersionId,
  };
};

const assignRequired = (name: string, value: unknown): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Required key ${name} is missing or empty.`);
  }

  process.env[name] = value;
};

/** The only PostgreSQL role the runtime credential may authenticate as. */
export const RUNTIME_DB_USERNAME = 'auth_runtime';

const assignRuntimeCredential = (secret: Record<string, unknown>): void => {
  const username = secret.username;
  if (typeof username !== 'string' || username.length === 0) {
    throw new Error('DB_RUNTIME_SECRET_ARN is missing the runtime username.');
  }

  if (username !== RUNTIME_DB_USERNAME) {
    throw new Error(
      `DB_RUNTIME_SECRET_ARN username must be ${RUNTIME_DB_USERNAME}.`,
    );
  }

  const password = secret.password;
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('DB_RUNTIME_SECRET_ARN is missing the runtime password.');
  }

  // The runtime secret is authoritative: Better Auth must never connect with a
  // master-like user or password carried by the function configuration.
  process.env.POSTGRES_DB_USER = username;
  process.env.POSTGRES_DB_PASSWORD = password;
};

export interface LoadedSecretVersions {
  databaseVersionId: string;
  signingSecretVersionId: string;
  username: string;
  password: string;
  signingSecret: string;
  signingSecrets: Array<{ version: number; value: string }>;
}

export const loadSecretsToEnv = async (
  client: SecretClient = new SecretsManagerClient({}),
  timeoutMs = 5_000,
): Promise<LoadedSecretVersions> => {
  const appSecretArn = process.env.SECRET_ARN;
  if (!appSecretArn) {
    throw new Error('SECRET_ARN must be set for the AWS API runtime.');
  }

  const runtimeSecretArn = process.env.DB_RUNTIME_SECRET_ARN;
  if (!runtimeSecretArn) {
    throw new Error(
      'DB_RUNTIME_SECRET_ARN must be set for the AWS API runtime.',
    );
  }

  const [appSecret, previousAppSecret, runtimeSecret] = await Promise.all([
    fetchSecretJson(client, appSecretArn, 'SECRET_ARN', timeoutMs),
    fetchSecretJson(
      client,
      appSecretArn,
      'SECRET_ARN',
      timeoutMs,
      'AWSPREVIOUS',
      true,
    ),
    fetchSecretJson(
      client,
      runtimeSecretArn,
      'DB_RUNTIME_SECRET_ARN',
      timeoutMs,
    ),
  ]);

  if (!appSecret) throw new Error('SECRET_ARN holds no current version.');
  if (!runtimeSecret) {
    throw new Error('DB_RUNTIME_SECRET_ARN holds no current version.');
  }
  const signingSecret = appSecret.value.BETTER_AUTH_SECRET;
  const signingVersion = appSecret.value.BETTER_AUTH_SECRET_VERSION ?? 1;
  if (
    typeof signingVersion !== 'number' ||
    !Number.isSafeInteger(signingVersion) ||
    signingVersion < 1
  ) {
    throw new Error('SECRET_ARN has an invalid BETTER_AUTH_SECRET_VERSION.');
  }
  const signingSecrets = [
    { version: signingVersion, value: signingSecret as string },
  ];
  const addPreviousKeys = (raw: unknown, defaultVersion: number): void => {
    if (raw === undefined) return;
    if (!Array.isArray(raw)) {
      throw new Error(
        'SECRET_ARN has an invalid previous signing-secret list.',
      );
    }
    const seenVersions = new Set<number>();
    for (const [index, entry] of raw.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(
          'SECRET_ARN has an invalid previous signing-secret list.',
        );
      }
      const item = entry as Record<string, unknown>;
      const value = item.value;
      const version = item.version ?? defaultVersion - index;
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        typeof version !== 'number' ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version >= signingVersion
      ) {
        throw new Error(
          'SECRET_ARN has an invalid previous signing-secret list.',
        );
      }
      if (seenVersions.has(version)) {
        throw new Error(
          'SECRET_ARN has an invalid previous signing-secret list.',
        );
      }
      seenVersions.add(version);
      const existing = signingSecrets.find((key) => key.version === version);
      if (existing) {
        if (existing.value !== value) {
          throw new Error(
            'SECRET_ARN has conflicting signing-secret versions.',
          );
        }
        continue;
      }
      signingSecrets.push({ version, value });
    }
  };
  addPreviousKeys(
    appSecret.value.BETTER_AUTH_PREVIOUS_SECRETS,
    signingVersion - 1,
  );
  if (
    previousAppSecret &&
    previousAppSecret.versionId !== appSecret.versionId
  ) {
    const previousValue = previousAppSecret.value.BETTER_AUTH_SECRET;
    const previousVersion =
      previousAppSecret.value.BETTER_AUTH_SECRET_VERSION ?? signingVersion - 1;
    if (
      typeof previousValue !== 'string' ||
      previousValue.length === 0 ||
      typeof previousVersion !== 'number' ||
      !Number.isSafeInteger(previousVersion) ||
      previousVersion < 1 ||
      previousVersion >= signingVersion
    ) {
      throw new Error(
        'SECRET_ARN has an invalid previous signing-secret version.',
      );
    }
    addPreviousKeys(
      [{ version: previousVersion, value: previousValue }],
      previousVersion,
    );
    addPreviousKeys(
      previousAppSecret.value.BETTER_AUTH_PREVIOUS_SECRETS,
      previousVersion - 1,
    );
  }
  if (signingVersion > 1 && signingSecrets.length === 1) {
    throw new Error(
      'SECRET_ARN previous signing-secret version is unavailable.',
    );
  }
  signingSecrets.sort((left, right) => right.version - left.version);
  assignRequired('BETTER_AUTH_SECRET', signingSecret);
  assignRuntimeCredential(runtimeSecret.value);

  return {
    databaseVersionId: runtimeSecret.versionId,
    signingSecretVersionId: appSecret.versionId,
    username: runtimeSecret.value.username as string,
    password: runtimeSecret.value.password as string,
    signingSecret: signingSecret as string,
    signingSecrets,
  };
};

type LambdaHandler = ReturnType<typeof handle>;

export const trustedClientIp = (sourceIp: unknown): string | undefined => {
  if (typeof sourceIp !== 'string' || isIP(sourceIp) === 0) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(sourceIp);
  return mapped?.[1] ?? sourceIp;
};

export const invokeWithTrustedClientIp = async <T>(
  event: LambdaEvent,
  invoke: (event: LambdaEvent) => Promise<T>,
): Promise<
  T | { statusCode: number; headers: Record<string, string>; body: string }
> => {
  if (
    !('version' in event) ||
    event.version !== '2.0' ||
    !('http' in event.requestContext)
  ) {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"invalid_request"}',
    };
  }
  const clientIp = trustedClientIp(event.requestContext.http.sourceIp);
  const authRequest =
    'rawPath' in event && event.rawPath.startsWith('/api/auth/');
  if (authRequest && !clientIp) {
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"service_unavailable"}',
    };
  }
  for (const key of Object.keys(event.headers)) {
    if (
      ['x-forwarded-for', 'x-real-ip', 'x-gootip-client-ip'].includes(
        key.toLowerCase(),
      )
    ) {
      delete event.headers[key];
    }
  }
  if (clientIp) event.headers['x-gootip-client-ip'] = clientIp;
  return invoke(event);
};

interface AuthGeneration {
  handler: LambdaHandler;
  pool: Pool;
  close(): Promise<void>;
  closePromise?: Promise<void>;
  activeRequests: number;
  drainWaiters: Array<() => void>;
}

let cachedGeneration: Promise<AuthGeneration> | undefined;
let credentialRefresh: AuthCredentialRefreshCoordinator | undefined;
let activeGeneration: AuthGeneration | undefined;
let retiringGeneration: AuthGeneration | undefined;
let admissionBlocked = false;
let failedCandidateCleanup: Promise<void> | undefined;
let configuredDrainTimeoutMs = 5_000;

const createGeneration = async (
  credential: AuthCredentialCandidate,
  timeoutMs: number | undefined,
  validateConnection: boolean,
): Promise<AuthGeneration> => {
  if (
    !credential.username ||
    !credential.password ||
    !credential.signingSecret
  ) {
    throw new Error('Runtime credential candidate is incomplete.');
  }
  const env = readEnv({
    ...process.env,
    POSTGRES_DB_USER: credential.username,
    POSTGRES_DB_PASSWORD: credential.password,
    BETTER_AUTH_SECRET: credential.signingSecret,
  });
  if (validateConnection && env.POSTGRES_SSL_MODE !== 'verify-full') {
    throw new Error('Database credential validation requires verified TLS.');
  }
  const pool = createPostgresPool(env, timeoutMs);
  try {
    if (validateConnection) {
      const connection = await pool.connect();
      try {
        const result = await connection.query<{
          username: string;
          backend_pid: number;
          tls: boolean;
          tls_version: string | null;
        }>(
          `SELECT current_user AS username,
                  pg_backend_pid() AS backend_pid,
                  ssl.ssl AS tls,
                  ssl.version AS tls_version
             FROM pg_stat_ssl AS ssl
            WHERE ssl.pid = pg_backend_pid()`,
        );
        const identity = result.rows[0];
        if (
          identity?.username !== RUNTIME_DB_USERNAME ||
          identity.tls !== true ||
          typeof identity.tls_version !== 'string' ||
          identity.tls_version.length === 0
        ) {
          throw new Error('Database identity validation failed.');
        }
        console.info(
          JSON.stringify({
            event: 'runtime_database_connection_validated',
            service: 'auth',
            username: identity.username,
            backend_pid: identity.backend_pid,
            tls: identity.tls,
            tls_version: identity.tls_version,
          }),
        );
      } finally {
        connection.release();
      }
    }
    const auth = createAuth(
      env,
      pool,
      credential.signingSecrets ?? [
        { version: 1, value: credential.signingSecret },
      ],
    );
    const app = createApp({
      auth,
      frontendURL: env.FRONTEND_URL,
      issuer: env.BETTER_AUTH_URL,
    });
    return {
      handler: handle(app),
      pool,
      close: () => pool.end(),
      activeRequests: 0,
      drainWaiters: [],
    };
  } catch {
    const cleanup = pool.end();
    if (!(await waitFor(cleanup, timeoutMs ?? 5_000))) {
      failedCandidateCleanup = cleanup;
      admissionBlocked = true;
    }
    throw new Error('Database credential candidate validation failed.');
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

const bootstrap = async (remainingTimeMs: number): Promise<AuthGeneration> => {
  const timing = readCredentialRefreshTiming();
  configuredDrainTimeoutMs = timing.drainTimeoutMs;
  const initialLoadTimeoutMs = Math.min(
    5_000,
    remainingTimeMs - timing.drainTimeoutMs,
  );
  if (initialLoadTimeoutMs <= 0) {
    throw new Error('Insufficient invocation time to initialize credentials.');
  }
  if (failedCandidateCleanup) {
    if (!(await waitFor(failedCandidateCleanup, initialLoadTimeoutMs))) {
      throw new Error('Prior candidate cleanup is incomplete.');
    }
    failedCandidateCleanup = undefined;
  }
  const startedAt = Date.now();
  const activeVersions = await loadSecretsToEnv(
    undefined,
    initialLoadTimeoutMs,
  );
  const generationTimeoutMs = Math.min(
    5_000,
    remainingTimeMs - (Date.now() - startedAt) - timing.drainTimeoutMs,
  );
  if (generationTimeoutMs <= 0) {
    throw new Error('Insufficient invocation time to initialize the client.');
  }
  const generation = await createGeneration(
    activeVersions,
    generationTimeoutMs,
    true,
  );
  activeGeneration = generation;
  credentialRefresh = createAuthCredentialRefreshCoordinator({
    activeVersions,
    timing,
    loadCurrent: async (timeoutMs) => {
      const previous = {
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
        POSTGRES_DB_USER: process.env.POSTGRES_DB_USER,
        POSTGRES_DB_PASSWORD: process.env.POSTGRES_DB_PASSWORD,
      };
      try {
        return await loadSecretsToEnv(undefined, timeoutMs);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    activateCandidate: async (candidate, timeoutMs) => {
      if (
        (retiringGeneration || failedCandidateCleanup) &&
        !(await drainAndCloseRetiring(timing.drainTimeoutMs))
      ) {
        admissionBlocked = true;
        throw new Error('Retiring client cleanup is incomplete.');
      }
      const next = await createGeneration(candidate, timeoutMs, true);
      const previous = activeGeneration;
      activeGeneration = next;
      if (previous) retiringGeneration = previous;
      if (!(await drainAndCloseRetiring(timing.drainTimeoutMs))) {
        admissionBlocked = true;
      }
    },
  });
  return generation;
};

const bootstrapLocal = async (): Promise<AuthGeneration> => {
  const env = readEnv();
  const pool = createPostgresPool(env);
  const auth = createAuth(env, pool);
  const app = createApp({
    auth,
    frontendURL: env.FRONTEND_URL,
    issuer: env.BETTER_AUTH_URL,
  });
  const generation = {
    handler: handle(app),
    pool,
    close: () => pool.end(),
    activeRequests: 0,
    drainWaiters: [],
  };
  activeGeneration = generation;
  return generation;
};

const checkPoolConnection = async (pool: Pool) => {
  const connection = await pool.connect();
  connection.release();
};

export const handler = async <Event extends LambdaEvent>(
  event: Event,
  context?: LambdaContext,
) => {
  const isLambda = Boolean(context?.invokedFunctionArn);
  cachedGeneration ??= isLambda
    ? bootstrap(context?.getRemainingTimeInMillis() ?? 0)
    : bootstrapLocal();
  let generation: AuthGeneration;
  try {
    generation = await cachedGeneration;
  } catch {
    cachedGeneration = undefined;
    credentialRefresh = undefined;
    activeGeneration = undefined;
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"service_unavailable"}',
    };
  }
  if (isLambda) {
    try {
      await credentialRefresh?.ensureFresh(context?.getRemainingTimeInMillis());
      const remainingTimeMs = context?.getRemainingTimeInMillis() ?? 0;
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
        'rawPath' in event &&
        event.rawPath.startsWith('/api/auth/') &&
        'http' in event.requestContext &&
        ['GET', 'POST'].includes(event.requestContext.http.method) &&
        trustedClientIp(event.requestContext.http.sourceIp)
      ) {
        // Probe before dispatch so a reconnect can recover without replaying SQL.
        try {
          await checkPoolConnection(generation.pool);
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
              context?.getRemainingTimeInMillis(),
              true,
            );
          }
          if (
            admissionBlocked ||
            !activeGeneration ||
            activeGeneration === generation
          ) {
            throw new Error(
              'No replacement database credential was activated.',
            );
          }
          generation = activeGeneration;
          await checkPoolConnection(generation.pool);
        }
        if (admissionBlocked || generation !== activeGeneration) {
          throw new Error(
            'Database admission changed during connection validation.',
          );
        }
      }
    } catch {
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: '{"error":"service_unavailable"}',
      };
    }
  }
  generation.activeRequests += 1;
  try {
    return await invokeWithTrustedClientIp(event, (trustedEvent) =>
      generation.handler(trustedEvent, context),
    );
  } finally {
    generation.activeRequests -= 1;
    if (generation.activeRequests === 0) {
      for (const resolve of generation.drainWaiters.splice(0)) resolve();
    }
  }
};
