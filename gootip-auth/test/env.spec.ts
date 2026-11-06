import { describe, expect, it } from 'vitest';

import { readEnv } from '../src/config/env.js';
import { parseRateLimitRules } from '../src/config/env.js';
import { validEnv } from './fixtures.js';

const validSource = Object.fromEntries(
  Object.entries(validEnv).map(([key, value]) => [key, String(value)]),
);

describe('readEnv', () => {
  it('parses and normalizes a valid environment', () => {
    const env = readEnv({
      ...validSource,
      PORT: '4000',
      POSTGRES_DB_PORT: '5432',
      SECRET_ARN: '',
      DB_RUNTIME_SECRET_ARN: '',
    });

    expect(env.PORT).toBe(4000);
    expect(env.POSTGRES_DB_PORT).toBe(5432);
    expect(env.POSTGRES_SSL_MODE).toBe('disable');
    expect(env.SECRET_ARN).toBeUndefined();
  });

  it('rejects secrets shorter than 32 characters', () => {
    expect(() =>
      readEnv({ ...validSource, BETTER_AUTH_SECRET: 'too-short' }),
    ).toThrow();
  });

  it('requires the runtime secret ARN with an application secret ARN', () => {
    expect(() => readEnv({ ...validSource, SECRET_ARN: 'app-secret' })).toThrow(
      'DB_RUNTIME_SECRET_ARN must be set when SECRET_ARN is set.',
    );
  });

  it('requires a CA path when PostgreSQL TLS is enabled', () => {
    expect(() =>
      readEnv({ ...validSource, POSTGRES_SSL_MODE: 'verify-full' }),
    ).toThrow('POSTGRES_CA_PATH must be set when PostgreSQL TLS is enabled.');
  });

  it('rejects invalid rate-limit rules', () => {
    expect(() => parseRateLimitRules('/sign-in/*:0:3')).toThrow();
  });
});
