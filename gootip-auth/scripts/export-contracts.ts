import { fileURLToPath } from 'node:url';

import { getEndpoints } from 'better-auth/api';

import { createApp } from '../src/app.js';
import { createAuthOptions } from '../src/auth/auth.js';
import { readEnv } from '../src/config/env.js';

const placeholderEnv = readEnv({
  POSTGRES_DB_HOST: 'metadata-only.invalid',
  POSTGRES_DB_PORT: '5432',
  POSTGRES_DB_NAME: 'metadata',
  POSTGRES_DB_USER: 'metadata',
  POSTGRES_DB_PASSWORD: 'metadata-only',
  BETTER_AUTH_SECRET: 'metadata-only-secret-that-is-not-used-0000',
  BETTER_AUTH_URL: 'https://auth.example.invalid',
  JWT_AUDIENCE: 'metadata-only',
  FRONTEND_URL: 'https://frontend.example.invalid',
});

type Field = {
  type: string;
  required: boolean;
  example: unknown;
  values?: unknown[];
  fields?: Record<string, Field>;
};

const pathParameters = (path: string) =>
  Object.fromEntries(
    [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(([, name]) => [
      name,
      {
        type: 'string',
        required: true,
        example: name === 'id' ? 'example-provider' : `example-${name}`,
      },
    ]),
  );

const schemaField = (
  schema: unknown,
  required = true,
  fieldName = '',
): Field => {
  if (!schema || typeof schema !== 'object') {
    throw new Error('Unsupported Better Auth schema entry.');
  }
  const value = schema as {
    type?: string;
    def?: { type?: string; innerType?: unknown; shape?: unknown };
  };
  const kind = value.type ?? value.def?.type;
  if (kind === 'optional' || kind === 'default' || kind === 'nullable') {
    return schemaField(
      value.def?.innerType,
      kind === 'optional' ? false : required,
      fieldName,
    );
  }
  if (kind === 'object') {
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    if (!shape) throw new Error('Better Auth object schema has no shape.');
    return {
      type: 'object',
      required,
      example: {},
      fields: Object.fromEntries(
        Object.entries(shape).map(([name, item]) => [
          name,
          schemaField(item, true, name),
        ]),
      ),
    };
  }
  if (kind === 'array')
    return { type: 'array', required, example: [], fields: undefined };
  if (kind === 'enum') {
    const values = (schema as { options?: unknown[] }).options;
    if (!values?.length) throw new Error('Better Auth enum has no values.');
    return { type: 'string', required, example: values[0], values };
  }
  if (kind === 'union') {
    const options = (schema as { options?: unknown[] }).options;
    if (!options?.length)
      throw new Error('Better Auth union schema has no options.');
    const literals = options.map(
      (option) => (option as { value?: unknown }).value,
    );
    if (literals.every((item) => item !== undefined)) {
      return {
        type: typeof literals[0],
        required,
        example: literals[0],
        values: literals,
      };
    }
    return schemaField(options[0], required, fieldName);
  }
  if (kind === 'record') {
    return { type: 'object', required, example: {} };
  }
  if (kind === 'intersection') {
    const definition = value.def as { left?: unknown; right?: unknown };
    const left = schemaField(definition.left, required);
    const right = schemaField(definition.right, required);
    if (left.type !== 'object' || right.type !== 'object') {
      throw new Error(
        'Unsupported non-object Better Auth schema intersection.',
      );
    }
    return { ...left, fields: { ...left.fields, ...right.fields } };
  }
  const examples: Record<string, unknown> = {
    string: fieldName.toLowerCase().includes('email')
      ? 'user@example.invalid'
      : fieldName.toLowerCase().includes('password')
        ? 'example-password'
        : 'example',
    number: 1,
    boolean: false,
  };
  if (!kind || !(kind in examples))
    throw new Error(`Unsupported Better Auth schema type: ${String(kind)}`);
  return { type: kind, required, example: examples[kind] };
};

export const exportAuthContracts = () => {
  const endpoints = getEndpoints(
    Promise.resolve({ baseURL: placeholderEnv.BETTER_AUTH_URL } as never),
    createAuthOptions(placeholderEnv),
  ).api;
  const betterAuthContracts = Object.entries(endpoints).flatMap(
    ([name, endpoint]) => {
      const descriptor = endpoint as unknown as {
        path?: string;
        options: {
          method?: string | string[];
          body?: unknown;
          query?: unknown;
        };
      };
      if (typeof descriptor.path !== 'string') return [];
      const path = descriptor.path;
      const methods = descriptor.options.method;
      if (!methods)
        throw new Error(`Better Auth endpoint ${name} has no HTTP method.`);
      const body = descriptor.options.body
        ? schemaField(descriptor.options.body).fields
        : undefined;
      const query = descriptor.options.query
        ? schemaField(descriptor.options.query).fields
        : undefined;
      return (Array.isArray(methods) ? methods : [methods]).map((method) => ({
        service: 'auth',
        method,
        path: `/api/auth${path}`,
        ...(body ? { body } : {}),
        ...(query ? { query } : {}),
        parameters: pathParameters(path),
      }));
    },
  );
  const app = createApp({
    auth: { handler: async () => new Response() },
    frontendURL: placeholderEnv.FRONTEND_URL,
    issuer: placeholderEnv.BETTER_AUTH_URL,
  });
  const honoContracts = app.routes
    .filter((route) => route.path !== '/api/auth/*' && route.method !== 'ALL')
    .map((route) => ({
      service: 'auth',
      method: route.method,
      path: route.path,
      parameters: pathParameters(route.path),
    }));
  return [...betterAuthContracts, ...honoContracts];
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(exportAuthContracts(), null, 2)}\n`);
}
