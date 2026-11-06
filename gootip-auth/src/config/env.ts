import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    POSTGRES_DB_HOST: z.string().min(1),
    POSTGRES_DB_PORT: z.coerce.number().int().min(1).max(65535),
    POSTGRES_DB_NAME: z.string().min(1),
    AUTH_PG_POOL_MAX: z.coerce.number().int().min(1).max(81).default(2),
    AUTH_RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('true'),
    POSTGRES_DB_USER: z.string().min(1),
    POSTGRES_DB_PASSWORD: z.string().min(1),
    POSTGRES_SSL_MODE: z.enum(['disable', 'verify-full']).default('disable'),
    POSTGRES_CA_PATH: optionalNonEmptyString,
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    JWT_AUDIENCE: z.string().min(1),
    FRONTEND_URL: z.url(),
    SECRET_ARN: optionalNonEmptyString,
    DB_RUNTIME_SECRET_ARN: optionalNonEmptyString,
    AUTH_RATE_LIMIT_RULES: z
      .string()
      .default(
        '/sign-in/*:10:3,/sign-up/*:10:3,/request-password-reset:60:3,/forget-password/*:60:3',
      ),
  })
  .refine((env) => !env.SECRET_ARN || env.DB_RUNTIME_SECRET_ARN, {
    message: 'DB_RUNTIME_SECRET_ARN must be set when SECRET_ARN is set.',
    path: ['DB_RUNTIME_SECRET_ARN'],
  })
  .refine(
    (env) => env.POSTGRES_SSL_MODE !== 'verify-full' || env.POSTGRES_CA_PATH,
    {
      message: 'POSTGRES_CA_PATH must be set when PostgreSQL TLS is enabled.',
      path: ['POSTGRES_CA_PATH'],
    },
  );

export type AppEnv = z.infer<typeof envSchema>;

export const parseRateLimitRules = (value: string) =>
  Object.fromEntries(
    value.split(',').map((entry) => {
      const [path, window, max] = entry.split(':');
      if (!path || !path.startsWith('/') || !window || !max) {
        throw new Error(
          'AUTH_RATE_LIMIT_RULES must contain path:window:max entries.',
        );
      }
      const parsedWindow = Number(window);
      const parsedMax = Number(max);
      if (
        !Number.isInteger(parsedWindow) ||
        parsedWindow < 1 ||
        !Number.isInteger(parsedMax) ||
        parsedMax < 1
      ) {
        throw new Error(
          'AUTH_RATE_LIMIT_RULES windows and maxima must be positive integers.',
        );
      }
      return [path, { window: parsedWindow, max: parsedMax }];
    }),
  );

export const readEnv = (
  source: Record<string, string | undefined> = process.env,
): AppEnv => envSchema.parse(source);
