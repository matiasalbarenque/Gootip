import { describe, expect, it } from 'vitest';

import {
  initialAdminAction,
  safeAdminBootstrapErrorCode,
} from '../src/auth/admin-bootstrap.js';

describe('safeAdminBootstrapErrorCode', () => {
  it('reports only recognized diagnostic codes without error details', () => {
    expect(
      safeAdminBootstrapErrorCode({ code: '42501', detail: 'private data' }),
    ).toBe('42501');
    for (const error of [
      null,
      'private data',
      new Error('private data'),
      { code: 'private data', message: 'private data' },
    ]) {
      expect(safeAdminBootstrapErrorCode(error)).toBe('UNCLASSIFIED');
    }
  });
});

describe('initialAdminAction', () => {
  it('creates only when there are no admins and no matching email', () => {
    expect(initialAdminAction([], 'admin@example.com')).toBe('create');
  });

  it('does not reset the existing requested administrator', () => {
    expect(
      initialAdminAction(
        [{ email: 'Admin@example.com', role: 'admin' }],
        'admin@example.com',
      ),
    ).toBe('no_changes');
  });

  it('stops for another administrator or a non-admin account using the email', () => {
    expect(
      initialAdminAction(
        [{ email: 'other@example.com', role: 'admin' }],
        'admin@example.com',
      ),
    ).toBe('stop');
    expect(
      initialAdminAction(
        [{ email: 'admin@example.com', role: 'user' }],
        'admin@example.com',
      ),
    ).toBe('stop');
  });
});
