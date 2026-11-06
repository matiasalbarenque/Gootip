import { describe, expect, it } from 'vitest';

import { normalizePrincipal } from '../src/config/auth/request-context.js';
import { ROLES } from '../src/helpers/app.js';

describe('normalizePrincipal', () => {
  it('accepts a non-empty subject and known role only', () => {
    expect(normalizePrincipal({ sub: 'member-1', role: ROLES.EDITOR })).toEqual(
      {
        subject: 'member-1',
        role: ROLES.EDITOR,
      },
    );
  });

  it('retains identity but omits a missing or unknown role', () => {
    expect(normalizePrincipal({ sub: 'member-1', role: 'owner' })).toEqual({
      subject: 'member-1',
    });
    expect(normalizePrincipal({ sub: 'member-1' })).toEqual({
      subject: 'member-1',
    });
  });

  it('rejects missing, non-string, and empty subjects', () => {
    expect(normalizePrincipal(undefined)).toBeUndefined();
    expect(normalizePrincipal({ sub: 42 })).toBeUndefined();
    expect(normalizePrincipal({ sub: '  ' })).toBeUndefined();
  });
});
