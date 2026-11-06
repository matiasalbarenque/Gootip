import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { DataSource } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app.js', () => ({ createApp: vi.fn() }));
vi.mock('../src/config/database/runtime-credential.js', () => ({
  RUNTIME_DB_USERNAME: 'core_runtime',
  loadCoreRuntimeCredential: vi.fn(),
}));
vi.mock('@codegenie/serverless-express', () => ({
  configure: vi.fn(({ app }: { app: { generation: number } }) =>
    vi.fn(async () => ({ statusCode: 200, body: String(app.generation) })),
  ),
}));

const event = (wait = false): APIGatewayProxyEventV2 => ({
  version: '2.0',
  routeKey: 'GET /api/health',
  rawPath: '/api/health',
  rawQueryString: '',
  headers: wait ? { 'x-wait': 'yes' } : {},
  requestContext: {
    accountId: '123456789012',
    apiId: 'api-id',
    domainName: 'example.com',
    domainPrefix: 'example',
    http: {
      method: 'GET',
      path: '/api/health',
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'vitest',
    },
    requestId: 'request-id',
    routeKey: 'GET /api/health',
    stage: '$default',
    time: '21/Oct/2026:00:00:00 +0000',
    timeEpoch: 1_792_540_800_000,
  },
  isBase64Encoded: false,
});

const makeApp = (generation: number) => {
  const connect = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  return {
    init: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    connect,
    release,
    get: vi.fn((_token: typeof DataSource) => ({
      query: vi.fn(async () => [
        {
          username: 'core_runtime',
          backend_pid: 456,
          tls: true,
          tls_version: 'TLSv1.3',
        },
      ]),
      createQueryRunner: () => ({ connect, release }),
    })),
    getHttpAdapter: () => ({ getInstance: () => ({ generation }) }),
  };
};

const context = {
  invokedFunctionArn: 'arn:aws:lambda:us-east-2:123456789012:function:core',
  getRemainingTimeInMillis: () => 30_000,
} as Context;

const setup = async () => {
  vi.resetModules();
  process.env.CORE_RUNTIME_SECRET_ARN = 'core-runtime-secret';
  process.env.POSTGRES_SSL_MODE = 'verify-full';
  process.env.DB_CREDENTIAL_REFRESH_INTERVAL_SECONDS = '2';
  process.env.DB_CREDENTIAL_REFRESH_RETRY_SECONDS = '1';
  process.env.DB_CREDENTIAL_MAX_STALE_SECONDS = '4';
  process.env.DB_CREDENTIAL_DRAIN_TIMEOUT_SECONDS = '1';
  const appModule = await import('../src/app.js');
  const credentialModule =
    await import('../src/config/database/runtime-credential.js');
  const lambdaModule = await import('../src/lambda.js');
  const apps = [makeApp(0), makeApp(1)];
  const pendingApps = [...apps];
  vi.mocked(appModule.createApp)
    .mockReset()
    .mockImplementation(async () => pendingApps.shift() as never);
  const configureModule = await import('@codegenie/serverless-express');
  vi.mocked(configureModule.configure)
    .mockReset()
    .mockImplementation(
      (params) =>
        vi.fn(async () => ({
          statusCode: 200,
          body: String(
            (params.app as unknown as { generation: number }).generation,
          ),
        })) as never,
    );
  const load = vi.mocked(credentialModule.loadCoreRuntimeCredential);
  load.mockReset();
  load
    .mockResolvedValueOnce({
      versionId: 'db-v1',
      username: 'core_runtime',
      password: 'first-password',
    })
    .mockResolvedValue({
      versionId: 'db-v2',
      username: 'core_runtime',
      password: 'second-password',
    });
  return { apps, handler: lambdaModule.handler, load, configureModule };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Core Lambda generation replacement', () => {
  it('refreshes a rejected catalog connection before invoking Nest once', async () => {
    const { apps, handler, load, configureModule } = await setup();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const catalogEvent = { ...event(), rawPath: '/api/products' };
    expect(await handler(catalogEvent, context)).toMatchObject({ body: '0' });
    apps[0]?.connect.mockRejectedValueOnce(
      Object.assign(new Error('Rejected PostgreSQL connection'), {
        code: '28P01',
      }),
    );

    expect(await handler(catalogEvent, context)).toMatchObject({ body: '1' });
    expect(load).toHaveBeenCalledTimes(2);
    expect(apps[0]?.release).toHaveBeenCalledTimes(2);
    expect(apps[0]?.close).toHaveBeenCalledOnce();
    expect(
      vi.mocked(configureModule.configure).mock.results[0]?.value,
    ).toHaveBeenCalledOnce();
    expect(
      vi.mocked(configureModule.configure).mock.results[1]?.value,
    ).toHaveBeenCalledOnce();
  });
  it('validates a new runtime identity, uses the new app, and closes the old app', async () => {
    const { apps, handler, load } = await setup();
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const originalNow = Date.now;
    let now = originalNow();
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    expect(await handler(event(), context)).toMatchObject({ body: '0' });
    expect(await handler(event(), context)).toMatchObject({ body: '0' });
    expect(log).toHaveBeenCalledTimes(1);
    now += 2_000;
    expect(await handler(event(), context)).toMatchObject({ body: '1' });

    expect(load).toHaveBeenCalledTimes(2);
    expect(apps[0]?.close).toHaveBeenCalledTimes(1);
    expect(apps[1]?.get).toHaveBeenCalledWith(expect.anything());
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'runtime_database_connection_validated',
        service: 'core',
        username: 'core_runtime',
        backend_pid: 456,
        tls: true,
        tls_version: 'TLSv1.3',
      }),
    );
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('keeps an overlapping request on its original generation until it finishes', async () => {
    const { handler, load, configureModule } = await setup();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let release!: () => void;
    let entered!: () => void;
    const delayed = new Promise<void>((resolve) => (release = resolve));
    const requestEntered = new Promise<void>((resolve) => (entered = resolve));
    vi.mocked(configureModule.configure).mockImplementation(
      (params) =>
        vi.fn(async (request: APIGatewayProxyEventV2) => {
          if (request.headers['x-wait'] === 'yes') {
            entered();
            await delayed;
          }
          return {
            statusCode: 200,
            body: String(
              (params.app as unknown as { generation: number }).generation,
            ),
          };
        }) as never,
    );

    const oldRequest = handler(event(true), context);
    await requestEntered;
    now += 2_000;
    const refreshedRequest = handler(event(), context);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    release();

    expect(await oldRequest).toMatchObject({ body: '0' });
    expect(await refreshedRequest).toMatchObject({ body: '1' });
  });
});
