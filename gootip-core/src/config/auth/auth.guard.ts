import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  CatalogPrincipal,
  PUBLIC_ROUTE,
  REQUIRED_ROLES,
  CatalogRole,
} from './auth.js';

type AuthorizedRequest = { catalogPrincipal?: CatalogPrincipal };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    const principal = request.catalogPrincipal;
    if (!principal) {
      throw new UnauthorizedException();
    }

    const requiredRoles = this.reflector.getAllAndOverride<CatalogRole[]>(
      REQUIRED_ROLES,
      [context.getHandler(), context.getClass()],
    );
    if (
      !requiredRoles?.length ||
      !principal.role ||
      !requiredRoles.includes(principal.role)
    ) {
      throw new ForbiddenException();
    }
    return true;
  }
}
