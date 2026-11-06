import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { assertCoreTestDatabase } from './local-postgres.js';

assertCoreTestDatabase();

vi.mock('../src/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app.js')>();

  return { ...actual, createApp: vi.fn(actual.createApp) };
});

const context = {} as Context;

const healthEvent: APIGatewayProxyEventV2 = {
  version: '2.0',
  routeKey: 'GET /api/health',
  rawPath: '/api/health',
  rawQueryString: '',
  headers: { host: 'example.com' },
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
};

const loadHandler = async () => {
  vi.resetModules();

  const appModule = await import('../src/app.js');
  const lambdaModule = await import('../src/lambda.js');

  return {
    createApp: vi.mocked(appModule.createApp),
    handler: lambdaModule.handler,
  };
};

describe('Lambda handler', () => {
  it('answers an HTTP API payload v2 health event', async () => {
    const { handler } = await loadHandler();

    const response = await handler(healthEvent, context);

    expect(response).toMatchObject({
      statusCode: 200,
      body: '{"status":"ok"}',
    });
  });

  it('reuses one Nest initialization across sequential invocations', async () => {
    const { createApp, handler } = await loadHandler();

    await handler(healthEvent, context);
    await handler(healthEvent, context);

    expect(createApp).toHaveBeenCalledTimes(1);
  });
});
