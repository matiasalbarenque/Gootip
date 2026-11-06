import { SetMetadata } from '@nestjs/common';

import { ROLES } from '../../helpers/app.js';

export const PUBLIC_ROUTE = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';

export const CATALOG_ROLES = Object.values(ROLES);
export type CatalogRole = (typeof ROLES)[keyof typeof ROLES];
export type CatalogPrincipal = { subject: string; role?: CatalogRole };

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const RequireRoles = (...roles: CatalogRole[]) =>
  SetMetadata(REQUIRED_ROLES, roles);
