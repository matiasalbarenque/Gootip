import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { AuthGuard } from '../src/config/auth/auth.guard.js';
import {
  PUBLIC_ROUTE,
  REQUIRED_ROLES,
  type CatalogPrincipal,
} from '../src/config/auth/auth.js';
import { ROLES } from '../src/helpers/app.js';

const createContext = (principal?: CatalogPrincipal): ExecutionContext => {
  const handler = () => undefined;
  const controller = class {};
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({ catalogPrincipal: principal }),
    }),
  } as unknown as ExecutionContext;
};

const createReflector = (isPublic = false, roles?: string[]) =>
  ({
    getAllAndOverride: vi.fn((key: string) =>
      key === PUBLIC_ROUTE
        ? isPublic
        : key === REQUIRED_ROLES
          ? roles
          : undefined,
    ),
  }) as unknown as Reflector;

describe('AuthGuard', () => {
  it('allows public routes without a principal', () => {
    const guard = new AuthGuard(createReflector(true));

    expect(guard.canActivate(createContext())).toBe(true);
  });

  it('returns 401 when a protected route has no principal', () => {
    const guard = new AuthGuard(
      createReflector(false, [ROLES.EDITOR, ROLES.ADMIN]),
    );

    expect(() => guard.canActivate(createContext())).toThrow(
      UnauthorizedException,
    );
  });

  it('returns 403 when the principal role is not allowed or no roles are declared', () => {
    const principal = { subject: 'member-1', role: ROLES.USER } as const;
    const guard = new AuthGuard(
      createReflector(false, [ROLES.EDITOR, ROLES.ADMIN]),
    );
    const unclassifiedGuard = new AuthGuard(createReflector());

    expect(() => guard.canActivate(createContext(principal))).toThrow(
      ForbiddenException,
    );
    expect(() =>
      unclassifiedGuard.canActivate(createContext(principal)),
    ).toThrow(ForbiddenException);
  });

  it.each([ROLES.EDITOR, ROLES.ADMIN])(
    'allows %s for declared roles',
    (role) => {
      const guard = new AuthGuard(
        createReflector(false, [ROLES.EDITOR, ROLES.ADMIN]),
      );

      expect(
        guard.canActivate(createContext({ subject: 'member-1', role })),
      ).toBe(true);
    },
  );
});
