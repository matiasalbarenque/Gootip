import type { LambdaContext, LambdaEvent } from '@hono/aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  generation: 0,
  runtimeVersionCalls: 0,
  requestsDispatched: 0,
  signingVersion: 1,
  rotateDatabaseOnRefresh: true,
  pools: [] as Array<{
    end: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }>,
  delayed: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}));

vi.mock('@aws-sdk/client-secrets-manager', () => {
  class GetSecretValueCommand {
    constructor(readonly input: { SecretId: string; VersionStage?: string }) {}
  }
  class SecretsManagerClient {
    async send(command: GetSecretValueCommand) {
      if (command.input.SecretId === 'signing-secret') {
        const previous =
          command.input.VersionStage === 'AWSPREVIOUS' &&
          state.signingVersion > 1;
        const version = previous
          ? state.signingVersion - 1
          : state.signingVersion;
        return {
          SecretString: JSON.stringify({
            BETTER_AUTH_SECRET: previous ? 's'.repeat(48) : 't'.repeat(48),
            BETTER_AUTH_SECRET_VERSION: version,
            ...(previous
              ? {}
              : {
                  BETTER_AUTH_PREVIOUS_SECRETS:
                    state.signingVersion > 1
                      ? [{ version: 1, value: 's'.repeat(48) }]
                      : [],
                }),
          }),
          VersionId: `signing-v${version}`,
        };
      }
      state.runtimeVersionCalls += 1;
      return {
        SecretString: JSON.stringify({
          username: 'auth_runtime',
          password: `password-${state.runtimeVersionCalls}`,
        }),
        VersionId:
          state.runtimeVersionCalls <= 1 || !state.rotateDatabaseOnRefresh
            ? 'db-v1'
            : 'db-v2',
      };
    }
  }
  return { GetSecretValueCommand, SecretsManagerClient };
});

vi.mock('../src/auth/auth.js', () => ({
  createAuth: vi.fn(() => ({ generation: state.generation })),
  createPostgresPool: vi.fn(() => {
    const pool = {
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({
          rows: [
            {
              username: 'auth_runtime',
              backend_pid: 123,
              tls: true,
              tls_version: 'TLSv1.3',
            },
          ],
        })),
        release: vi.fn(),
      })),
      end: vi.fn(async () => undefined),
    };
    state.pools.push(pool);
    return pool;
  }),
}));

vi.mock('../src/app.js', () => ({
  createApp: vi.fn(({ auth }: { auth: { generation: number } }) => auth),
}));

vi.mock('@hono/aws-lambda', () => ({
  handle: vi.fn((app: { generation: number }) =>
    vi.fn(async (event: LambdaEvent) => {
      state.requestsDispatched += 1;
      if ('headers' in event && event.headers?.['x-wait'] === 'yes') {
        state.entered?.();
        await state.delayed;
      }
      return { statusCode: 200, body: String(app.generation) };
    }),
  ),
}));

const event = (wait = false): LambdaEvent =>
  ({
    version: '2.0',
    routeKey: 'GET /api/auth/health',
    rawPath: '/api/auth/health',
    rawQueryString: '',
    headers: wait ? { 'x-wait': 'yes' } : {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: 'GET',
        path: '/api/auth/health',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-id',
      routeKey: 'GET /api/auth/health',
      stage: '$default',
      time: '21/Oct/2026:00:00:00 +0000',
      timeEpoch: 1_792_540_800_000,
    },
    isBase64Encoded: false,
  }) as LambdaEvent;

const context = {
  invokedFunctionArn: 'arn:aws:lambda:us-east-2:123456789012:function:auth',
  getRemainingTimeInMillis: () => 30_000,
} as LambdaContext;

const setup = async () => {
  vi.resetModules();
  state.generation = 0;
  state.runtimeVersionCalls = 0;
  state.requestsDispatched = 0;
  state.signingVersion = 1;
  state.rotateDatabaseOnRefresh = true;
  state.pools = [];
  state.delayed = undefined;
  state.entered = undefined;
  process.env.SECRET_ARN = 'signing-secret';
  process.env.DB_RUNTIME_SECRET_ARN = 'runtime-secret';
  process.env.POSTGRES_DB_HOST = 'localhost';
  process.env.POSTGRES_DB_PORT = '5433';
  process.env.POSTGRES_DB_NAME = 'gootip';
  process.env.POSTGRES_SSL_MODE = 'verify-full';
  process.env.POSTGRES_CA_PATH = 'unused-in-mock';
  process.env.AUTH_PG_POOL_MAX = '2';
  process.env.BETTER_AUTH_URL = 'https://auth.example.com';
  process.env.JWT_AUDIENCE = 'auth';
  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.DB_CREDENTIAL_REFRESH_INTERVAL_SECONDS = '2';
  process.env.DB_CREDENTIAL_REFRESH_RETRY_SECONDS = '1';
  process.env.DB_CREDENTIAL_MAX_STALE_SECONDS = '4';
  process.env.DB_CREDENTIAL_DRAIN_TIMEOUT_SECONDS = '1';
  const module = await import('../src/lambda.js');
  const authModule = await import('../src/auth/auth.js');
  vi.mocked(authModule.createAuth).mockImplementation((() => ({
    generation: state.generation++,
  })) as never);
  return { handler: module.handler, createAuth: authModule.createAuth };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Auth Lambda generation replacement', () => {
  it('validates the candidate identity, switches client and pool, and closes the old pool', async () => {
    const { handler, createAuth } = await setup();
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    expect(await handler(event(), context)).toMatchObject({ body: '0' });
    state.signingVersion = 2;
    now += 2_000;
    expect(await handler(event(), context)).toMatchObject({ body: '1' });

    expect(state.runtimeVersionCalls).toBe(2);
    expect(state.pools).toHaveLength(2);
    expect(state.pools[0]?.end).toHaveBeenCalledTimes(1);
    expect(state.pools[1]?.connect).toHaveBeenCalledTimes(2);
    const checkedConnection =
      await state.pools[1]?.connect.mock.results[0]?.value;
    expect(checkedConnection.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_backend_pid()'),
    );
    expect(checkedConnection.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_stat_ssl'),
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'runtime_database_connection_validated',
        service: 'auth',
        username: 'auth_runtime',
        backend_pid: 123,
        tls: true,
        tls_version: 'TLSv1.3',
      }),
    );
    expect(createAuth).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      [
        { version: 2, value: 't'.repeat(48) },
        { version: 1, value: 's'.repeat(48) },
      ],
    );
  });

  it('refreshes a rejected connection before dispatching the request once', async () => {
    const { handler } = await setup();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    expect(await handler(event(), context)).toMatchObject({ body: '0' });
    state.pools[0]?.connect.mockRejectedValueOnce(
      Object.assign(new Error('Rejected PostgreSQL connection'), {
        code: '28P01',
      }),
    );

    expect(await handler(event(), context)).toMatchObject({ body: '1' });
    expect(state.runtimeVersionCalls).toBe(2);
    expect(state.pools[0]?.end).toHaveBeenCalledOnce();
    expect(state.requestsDispatched).toBe(2);
  });

  it('backs off without dispatching when the rejected database version is still current', async () => {
    const { handler } = await setup();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    state.rotateDatabaseOnRefresh = false;
    expect(await handler(event(), context)).toMatchObject({ body: '0' });
    state.pools[0]?.connect.mockRejectedValue(
      Object.assign(new Error('Rejected PostgreSQL connection'), {
        code: '28P01',
      }),
    );

    expect(await handler(event(), context)).toMatchObject({ statusCode: 503 });
    expect(await handler(event(), context)).toMatchObject({ statusCode: 503 });
    expect(state.runtimeVersionCalls).toBe(2);
    expect(state.requestsDispatched).toBe(1);
    expect(state.pools).toHaveLength(1);
  });

  it('replaces the generation for a signing-secret-only rotation and retains the previous key', async () => {
    const { handler, createAuth } = await setup();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    expect(await handler(event(), context)).toMatchObject({ body: '0' });
    state.signingVersion = 2;
    state.rotateDatabaseOnRefresh = false;
    now += 2_000;
    expect(await handler(event(), context)).toMatchObject({ body: '1' });

    expect(state.runtimeVersionCalls).toBe(2);
    expect(state.pools).toHaveLength(2);
    expect(state.pools[0]?.end).toHaveBeenCalledOnce();
    expect(createAuth).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      [
        { version: 2, value: 't'.repeat(48) },
        { version: 1, value: 's'.repeat(48) },
      ],
    );
  });

  it('keeps an in-flight request on the retiring generation until it completes', async () => {
    const { handler } = await setup();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let release!: () => void;
    let entered!: () => void;
    state.delayed = new Promise<void>((resolve) => (release = resolve));
    const requestEntered = new Promise<void>((resolve) => (entered = resolve));
    state.entered = entered;

    const oldRequest = handler(event(true), context);
    await requestEntered;
    now += 2_000;
    const refreshedRequest = handler(event(), context);
    await vi.waitFor(() => expect(state.runtimeVersionCalls).toBe(2));
    release();

    expect(await oldRequest).toMatchObject({ body: '0' });
    expect(await refreshedRequest).toMatchObject({ body: '1' });
  });
});
