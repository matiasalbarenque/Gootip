import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';

describe('createApp', () => {
  it('reports service health without invoking Better Auth', async () => {
    const authHandler = vi.fn();
    const app = createApp({
      auth: { handler: authHandler },
      frontendURL: 'http://localhost:5173',
      issuer: 'https://auth.example.test',
    });

    const response = await app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(authHandler).not.toHaveBeenCalled();
  });

  it('delegates auth requests to the Better Auth web handler', async () => {
    const authHandler = vi.fn(async () =>
      Response.json({ status: 'delegated' }),
    );
    const app = createApp({
      auth: { handler: authHandler },
      frontendURL: 'http://localhost:5173',
      issuer: 'https://auth.example.test',
    });

    const response = await app.request('/api/auth/ok', {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'delegated' });
    expect(authHandler).toHaveBeenCalledOnce();
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173',
    );
    expect(response.headers.get('access-control-expose-headers')).toContain(
      'set-auth-token',
    );
  });

  it('sanitizes auth handler exceptions without rewriting normal error responses', async () => {
    const app = createApp({
      auth: {
        handler: async (request) => {
          if (new URL(request.url).pathname.endsWith('/throws')) {
            throw new Error('postgres://private-host:5432/internal SQL');
          }
          return new Response('limited', { status: 429 });
        },
      },
      frontendURL: 'http://localhost:5173',
      issuer: 'https://auth.example.test',
    });

    const thrown = await app.request('/api/auth/throws');
    expect(thrown.status).toBe(503);
    expect(await thrown.json()).toEqual({ error: 'service_unavailable' });

    const normal429 = await app.request('/api/auth/rate-limited');
    expect(normal429.status).toBe(429);
    expect(await normal429.text()).toBe('limited');
  });

  it('handles CORS preflight before Better Auth', async () => {
    const authHandler = vi.fn();
    const app = createApp({
      auth: { handler: authHandler },
      frontendURL: 'http://localhost:5173',
      issuer: 'https://auth.example.test',
    });

    const response = await app.request('/api/auth/sign-in/email', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-credentials')).toBe(
      'true',
    );
    expect(authHandler).not.toHaveBeenCalled();
  });

  it('publishes the configured issuer and Better Auth JWKS URL', async () => {
    const app = createApp({
      auth: { handler: vi.fn() },
      frontendURL: 'https://app.example.test',
      issuer: 'https://auth.example.test',
    });

    const response = await app.request('/.well-known/openid-configuration');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer: 'https://auth.example.test',
      jwks_uri: 'https://auth.example.test/api/auth/jwks',
    });
  });
});
