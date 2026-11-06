import { createApp } from './app.js';

const DEFAULT_PORT = 3001;

const port = Number(process.env.PORT ?? DEFAULT_PORT);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${String(process.env.PORT)}`);
}

const app = await createApp();
await app.listen(port);

console.log(`gootip-core listening on http://localhost:${port}/api`);
