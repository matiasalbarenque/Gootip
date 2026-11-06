import { AsyncLocalStorage } from 'node:async_hooks';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import {
  CATALOG_ROLES,
  type CatalogPrincipal,
  type CatalogRole,
} from './auth.js';

type GatewayEvent = APIGatewayProxyEventV2 & {
  requestContext: APIGatewayProxyEventV2['requestContext'] & {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
};

const invocationContext = new AsyncLocalStorage<GatewayEvent>();

export const runWithInvocation = <T>(
  event: APIGatewayProxyEventV2,
  callback: () => T,
): T => invocationContext.run(event as GatewayEvent, callback);

export const normalizePrincipal = (
  claims: Record<string, unknown> | undefined,
): CatalogPrincipal | undefined => {
  const subject = claims?.sub;
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    return undefined;
  }

  const claimRole = claims?.role;
  const role: CatalogRole | undefined = isCatalogRole(claimRole)
    ? claimRole
    : undefined;

  return { subject, ...(role ? { role } : {}) };
};

const isCatalogRole = (role: unknown): role is CatalogRole =>
  typeof role === 'string' &&
  (CATALOG_ROLES as readonly string[]).includes(role);

export const gatewayClaimsMiddleware = (
  request: {
    catalogPrincipal?: CatalogPrincipal;
  },
  _response: unknown,
  next: () => void,
): void => {
  const claims =
    invocationContext.getStore()?.requestContext.authorizer?.jwt?.claims;
  if (claims) {
    const principal = normalizePrincipal(claims);
    if (principal) Object.assign(request, { catalogPrincipal: principal });
  }
  next();
};
