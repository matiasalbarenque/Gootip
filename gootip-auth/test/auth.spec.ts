import { readFileSync } from 'node:fs';

import { betterAuth } from 'better-auth';
import { bearer, jwt } from 'better-auth/plugins';
import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuth } from '../src/auth/auth.js';
import { validEnv } from './fixtures.js';

vi.mock('better-auth', () => ({
  betterAuth: vi.fn(() => ({ handler: vi.fn() })),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => 'test-ca'),
}));

vi.mock('better-auth/plugins', () => ({
  bearer: vi.fn(() => ({ id: 'bearer' })),
  admin: vi.fn(() => ({ id: 'admin' })),
  jwt: vi.fn(() => ({ id: 'jwt' })),
}));

vi.mock('pg', () => ({
  Pool: vi.fn(),
}));

describe('createAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures PostgreSQL, email/password, Bearer and JWT', () => {
    createAuth(validEnv);

    expect(Pool).toHaveBeenCalledWith({
      host: 'localhost',
      port: 5433,
      user: 'user',
      password: 'password',
      database: 'gootip',
      max: 2,
      idleTimeoutMillis: 10_000,
      ssl: false,
    });
    expect(bearer).toHaveBeenCalledOnce();
    expect(jwt).toHaveBeenCalledWith({
      jwt: {
        issuer: 'http://localhost:3000',
        audience: 'api',
        expirationTime: '15m',
        definePayload: expect.any(Function),
      },
      jwks: {
        keyPairConfig: {
          alg: 'RS256',
          modulusLength: 2048,
        },
        rotationInterval: 2_592_000,
        gracePeriod: 2_592_000,
      },
    });
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:3000',
        secret: validEnv.BETTER_AUTH_SECRET,
        trustedOrigins: ['http://localhost:5173'],
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: false,
        },
      }),
    );
    expect(vi.mocked(betterAuth).mock.calls[0]?.[0].database).toMatchObject({
      type: 'postgres',
      schemaName: 'auth',
    });
  });

  it('configures verified PostgreSQL TLS with the configured CA', () => {
    createAuth({
      ...validEnv,
      POSTGRES_SSL_MODE: 'verify-full',
      POSTGRES_CA_PATH: '/opt/certs/rds-ca-bundle.pem',
    });

    expect(readFileSync).toHaveBeenCalledWith(
      '/opt/certs/rds-ca-bundle.pem',
      'utf8',
    );
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: { ca: 'test-ca', rejectUnauthorized: true },
      }),
    );
  });

  it('configures Better Auth with current and previous signing keys', () => {
    const previousSecret = 'previous-secret'.repeat(4);
    const currentSecret = 'current-secret'.repeat(4);
    createAuth(validEnv, new Pool(), [
      { version: 2, value: currentSecret },
      { version: 1, value: previousSecret },
    ]);

    expect(vi.mocked(betterAuth).mock.calls[0]?.[0]).toMatchObject({
      secret: previousSecret,
      secrets: [
        { version: 2, value: currentSecret },
        { version: 1, value: previousSecret },
      ],
    });
  });
});
