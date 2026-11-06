# SPEC 03 — Catalog authorization

> **Status:** Approved
> **Depends on:** SPEC 01
> **Date:** 2026-10-22
> **Objective:** Restrict catalog administration to editor and admin roles obtained from API Gateway's validated JWT claims.

## Scope

**In:**

- A core authorization module, route permission metadata, and a Nest guard.
- Request-scoped identity obtained from the existing API Gateway HTTP API payload v2 integration.
- Public anonymous access and protected catalog access for `editor` and `admin`.
- Local behavior and focused tests against Lambda events.

**Out of scope (for future specs or other projects):**

- JWT signature validation in core, login, token issuance, role assignment, role editing, and user-management endpoints.
- Changes to `gootip-auth` or its database.
- API Gateway authorizer provisioning, IAM changes, deployment, and direct public Lambda endpoints.

## Identity and permissions

```ts
type CatalogRole = 'user' | 'editor' | 'admin';
type CatalogPrincipal = { subject: string; role?: CatalogRole };
```

- Read `sub` and the single `role` claim exclusively from `event.requestContext.authorizer.jwt.claims`.
- A trusted, non-empty string `sub` establishes identity. A missing or unknown role grants no catalog administration permission.
- `user` can access public catalog routes. `editor` and `admin` have identical catalog management permissions.
- Public routes require no identity. Their visibility rules remain public even when called by an administrator.
- Protected routes return `401` when no trusted identity exists and `403` when the identity lacks an allowed role.
- Public access is a route property, not a role that clients may select. Missing role never makes a protected endpoint public.

## Implementation plan

1. Add an authorization module under `src/config/auth/`, route metadata for public routes and required roles, and an application guard using Nest dependency injection and `Reflector`. Explicitly mark health public. Default unclassified routes to denial rather than anonymous access.
2. Bridge the API Gateway authorizer claims into each Express request using the installed serverless-express request-context API or request mapping hook. Confirm its installed API before implementation. Do not store the current principal in a singleton or module-level mutable variable.
3. Normalize only the expected subject and role fields. Never derive permissions by decoding the incoming `Authorization` header, accepting custom role headers, or reading body/query identity fields.
4. Apply `editor`/`admin` permission metadata to the administration controllers added by SPEC 04 and SPEC 05. Keep public controllers explicitly public.
5. Document that HTTP-local protected requests have no trusted Gateway context and return `401`. Exercise protected behavior through synthetic Lambda events and targeted guard tests instead of adding a local bypass.
6. Document the external deployment and token contract. API Gateway must validate JWT signature, issuer, audience, and time claims on every protected route; the token issuer must supply `sub` and `role`. Protect the Lambda integration from an alternative public HTTP entry point.

## Acceptance criteria

- [ ] Health and public catalog routes work without a token.
- [ ] Trusted Lambda claims for `editor` and `admin` permit catalog management.
- [ ] Trusted claims for `user`, absent role, or unknown role return `403` on administration routes.
- [ ] Missing authorizer context or a missing/invalid subject returns `401` on administration routes.
- [ ] A forged JWT header or custom role header without trusted authorizer context cannot grant access.
- [ ] A token supplied to a public request does not expose drafts or archived products.
- [ ] Sequential and concurrent invocations do not leak identity between requests.
- [ ] HTTP-local protected requests return `401`; tests exercise authorized behavior through Lambda events.
- [ ] No auth implementation, token issuer, AWS configuration, or role-management feature is changed.

## Decisions

- **Yes: validate JWT at API Gateway and authorize inside core.** AWS supplies validated claims in the integration event; see [JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) and [Lambda payload v2](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html).
- **Yes: Nest route metadata and guards.** Keep permission checks explicit and close to HTTP entry points without adding a separate permissions engine.
- **No: treating decoded bearer-token contents as authenticated identity.** Core relies on the trusted integration context.
- **No: managing roles here.** An external system supplies `user`, `editor`, or `admin`; role assignment and token refresh are outside core.

## Risks

| Risk                                                      | Mitigation                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A protected route is deployed without the JWT authorizer. | Core denies requests without trusted identity; deployment must verify the complete protected route mapping.  |
| Auth currently emits no agreed catalog role claim.        | Treat external role issuance as a deployment prerequisite; do not invent roles or alter auth in this spec.   |
| An issued JWT retains an old role until expiry.           | Document that core uses the validated token snapshot; immediate revocation is not provided by this contract. |

## What is **not** in this spec

No role-management API, auth database migration, local authentication bypass, JWT verification in core, or AWS deployment is included.
