import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { AppAuth } from './auth/auth.js';

interface CreateAppOptions {
  auth: Pick<AppAuth, 'handler'>;
  frontendURL: string;
  issuer: string;
}

export const createApp = ({ auth, frontendURL, issuer }: CreateAppOptions) => {
  const app = new Hono();

  app.get('/health', (context) => context.json({ status: 'ok' }));

  app.get('/.well-known/openid-configuration', (context) =>
    context.json({
      issuer,
      jwks_uri: new URL('/api/auth/jwks', issuer).toString(),
    }),
  );

  app.use(
    '/api/auth/*',
    cors({
      origin: frontendURL,
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      exposeHeaders: ['set-auth-token', 'set-auth-jwt'],
    }),
  );

  app.on(['GET', 'POST'], '/api/auth/*', async (context) => {
    try {
      return await auth.handler(context.req.raw);
    } catch {
      return context.json({ error: 'service_unavailable' }, 503);
    }
  });

  return app;
};

export type App = ReturnType<typeof createApp>;
