import { handle } from '@hono/aws-lambda';
import type { LambdaEvent } from '@hono/aws-lambda';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { invokeWithTrustedClientIp, trustedClientIp } from '../src/lambda.js';

describe('trustedClientIp', () => {
  it('accepts IPv4 and IPv6 source addresses', () => {
    expect(trustedClientIp('192.0.2.1')).toBe('192.0.2.1');
    expect(trustedClientIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(trustedClientIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
  });

  it('rejects malformed and absent source addresses', () => {
    expect(trustedClientIp('forged')).toBeUndefined();
    expect(trustedClientIp(undefined)).toBeUndefined();
  });

  it('passes only API Gateway source IP to the auth adapter', async () => {
    let authHeaders: Headers | undefined;
    const app = createApp({
      frontendURL: 'https://app.example.test',
      issuer: 'https://auth.example.test',
      auth: {
        handler: async (request) => {
          authHeaders = request.headers;
          return Response.json({ ok: true });
        },
      },
    });
    const adapter = handle(app);
    const eventHeaders: Record<string, string> = {
      'X-Forwarded-For': '203.0.113.99',
      'x-forwarded-for': '198.51.100.8',
      'X-Real-IP': '203.0.113.77',
      'x-gootip-client-ip': '203.0.113.66',
      'X-Gootip-Client-IP': '203.0.113.55',
      origin: 'https://app.example.test',
      'content-type': 'application/json',
    };
    const event = {
      version: '2.0',
      routeKey: 'POST /api/auth/sign-in/email',
      rawPath: '/api/auth/sign-in/email',
      rawQueryString: '',
      headers: eventHeaders,
      requestContext: {
        accountId: '123456789012',
        apiId: 'api123',
        domainName: 'api.example.test',
        domainPrefix: 'api',
        http: {
          method: 'POST',
          path: '/api/auth/sign-in/email',
          protocol: 'HTTP/1.1',
          sourceIp: '192.0.2.23',
          userAgent: 'test-agent',
        },
        requestId: 'request-1',
        routeKey: 'POST /api/auth/sign-in/email',
        stage: '$default',
        time: '21/Oct/2026:00:00:00 +0000',
        timeEpoch: 1792540800000,
      },
      isBase64Encoded: false,
    } as unknown as LambdaEvent;

    const result = await invokeWithTrustedClientIp(event, (trustedEvent) =>
      adapter(trustedEvent),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(authHeaders?.get('x-gootip-client-ip')).toBe('192.0.2.23');
    expect(authHeaders?.get('x-forwarded-for')).toBeNull();
    expect(authHeaders?.get('x-real-ip')).toBeNull();
    expect(
      Object.entries(eventHeaders)
        .filter(([key]) =>
          ['x-forwarded-for', 'x-real-ip', 'x-gootip-client-ip'].includes(
            key.toLowerCase(),
          ),
        )
        .map(([key, value]) => [key.toLowerCase(), value]),
    ).toEqual([['x-gootip-client-ip', '192.0.2.23']]);
  });

  it('returns sanitized 503 for auth path without a valid source IP', async () => {
    for (const sourceIp of [undefined, 'not-an-ip']) {
      const event = {
        version: '2.0',
        routeKey: 'POST /api/auth/sign-in/email',
        rawPath: '/api/auth/sign-in/email',
        rawQueryString: '',
        headers: { 'x-forwarded-for': '203.0.113.10' },
        requestContext: {
          http: {
            sourceIp,
            method: 'POST',
            path: '/api/auth/sign-in/email',
            protocol: 'HTTP/1.1',
            userAgent: 'test',
          },
        },
        isBase64Encoded: false,
      } as unknown as LambdaEvent;
      let called = false;

      const result = await invokeWithTrustedClientIp(event, async () => {
        called = true;
        return { statusCode: 200 };
      });

      expect(result).toEqual({
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: '{"error":"service_unavailable"}',
      });
      expect(called).toBe(false);
    }
  });
});
