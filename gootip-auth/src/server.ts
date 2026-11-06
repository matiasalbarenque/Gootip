import 'dotenv/config';
import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createAuth } from './auth/auth.js';
import { readEnv } from './config/env.js';

const env = readEnv();
const auth = createAuth(env);
const app = createApp({
  auth,
  frontendURL: env.FRONTEND_URL,
  issuer: env.BETTER_AUTH_URL,
});

serve({
  fetch: app.fetch,
  port: env.PORT,
});

console.log(`Authentication API listening on http://localhost:${env.PORT}`);
