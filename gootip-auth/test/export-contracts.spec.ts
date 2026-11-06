import { describe, expect, it } from 'vitest';

import { exportAuthContracts } from '../scripts/export-contracts.js';

describe('Auth contract exporter', () => {
  it('enumerates Better Auth endpoints without creating a runtime or database pool', () => {
    const contracts = exportAuthContracts();
    const signIn = contracts.find(
      (contract) => contract.path === '/api/auth/sign-in/email',
    );
    const jwt = contracts.find(
      (contract) => contract.path === '/api/auth/token',
    );
    const discovery = contracts.find(
      (contract) => contract.path === '/.well-known/openid-configuration',
    );
    const callback = contracts.find(
      (contract) => contract.path === '/api/auth/callback/:id',
    );

    expect(contracts.length).toBeGreaterThan(22);
    expect(signIn).toMatchObject({
      service: 'auth',
      method: 'POST',
      body: {
        email: { type: 'string', required: true },
        password: { type: 'string', required: true },
      },
    });
    expect(jwt).toBeDefined();
    expect(discovery).toMatchObject({ method: 'GET', service: 'auth' });
    expect(callback?.parameters).toMatchObject({
      id: { example: 'example-provider' },
    });
  });
});
