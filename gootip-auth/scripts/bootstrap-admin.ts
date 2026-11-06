import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { z } from 'zod';

import {
  initialAdminAction,
  safeAdminBootstrapErrorCode,
} from '../src/auth/admin-bootstrap.js';
import { createAuth } from '../src/auth/auth.js';
import { readEnv } from '../src/config/env.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const secretObject = z.record(z.string(), z.unknown());
const appSecretArnSchema = z
  .string()
  .regex(
    /^arn:aws:secretsmanager:us-east-2:[0-9]{12}:secret:gootip-auth-dev-[A-Za-z0-9]{6}$/,
  );
const dbSecretArnSchema = z
  .string()
  .regex(
    /^arn:aws:secretsmanager:us-east-2:[0-9]{12}:secret:gootip-dev-auth-runtime-[A-Za-z0-9]{6}$/,
  );

const readSecret = async (client: SecretsManagerClient, arn: string) => {
  const output = await client.send(
    new GetSecretValueCommand({ SecretId: arn, VersionStage: 'AWSCURRENT' }),
  );
  if (!output.SecretString)
    throw new Error('A required current secret is unavailable.');
  return secretObject.parse(JSON.parse(output.SecretString));
};

const promptHidden = async (
  readline: ReturnType<typeof createInterface>,
  label: string,
) => {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'The administrator password must be entered in a private terminal.',
    );
  }

  readline.pause();
  stdout.write(label);
  let echoDisabled = false;
  try {
    execFileSync('stty', ['-echo'], { stdio: 'inherit' });
    echoDisabled = true;
    return await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        stdin.off('data', onData);
        stdin.off('error', onError);
        process.off('SIGINT', onInterrupt);
      };
      const onData = (chunk: Buffer) => {
        cleanup();
        resolve(chunk.toString('utf8').replace(/[\r\n]+$/, ''));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onInterrupt = () => {
        cleanup();
        reject(new Error('Password entry cancelled.'));
      };
      stdin.resume();
      stdin.once('data', onData);
      stdin.once('error', onError);
      process.once('SIGINT', onInterrupt);
    });
  } finally {
    stdin.pause();
    if (echoDisabled) {
      execFileSync('stty', ['echo'], { stdio: 'inherit' });
      stdout.write('\n');
    }
    readline.resume();
  }
};

let stage = 'profile verification';

const run = async () => {
  if (process.env.AWS_PROFILE !== 'gootip-bootstrap-admin') {
    throw new Error('Use the MFA-protected gootip-bootstrap-admin profile.');
  }

  const readline = createInterface({ input: stdin, output: stdout });
  const secretClient = new SecretsManagerClient({ region: 'us-east-2' });
  let pool: Pool | undefined;
  try {
    stage = 'identity input';
    const email = z
      .email()
      .parse((await readline.question('Admin email: ')).trim());
    const name = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .parse(await readline.question('Admin name: '));
    stage = 'connection configuration';
    const expectedAccount = z
      .string()
      .regex(/^[0-9]{12}$/)
      .parse(required('TF_VAR_aws_account_id'));
    const rdsHost = z
      .string()
      .regex(/^gootip-dev\.[a-z0-9]+\.us-east-2\.rds\.amazonaws\.com$/)
      .parse(required('GOOTIP_AUTH_ADMIN_RDS_HOST'));
    const caPath = required('GOOTIP_AUTH_ADMIN_RDS_CA_PATH');
    const appSecretArn = appSecretArnSchema.parse(
      required('GOOTIP_AUTH_ADMIN_APP_SECRET_ARN'),
    );
    const dbSecretArn = dbSecretArnSchema.parse(
      required('GOOTIP_AUTH_ADMIN_DB_SECRET_ARN'),
    );
    if (
      [appSecretArn, dbSecretArn].some(
        (arn) => arn.split(':')[4] !== expectedAccount,
      )
    ) {
      throw new Error(
        'Secret references must belong to the configured dev account.',
      );
    }
    const localPort = z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(required('GOOTIP_AUTH_ADMIN_TUNNEL_PORT'));
    stage = 'Secrets Manager reads';
    const [appSecret, dbSecret] = await Promise.all([
      readSecret(secretClient, appSecretArn),
      readSecret(secretClient, dbSecretArn),
    ]);
    stage = 'secret and application configuration validation';
    const signingSecret = z
      .string()
      .min(32)
      .parse(appSecret.BETTER_AUTH_SECRET);
    const signingVersion = z.coerce
      .number()
      .int()
      .min(1)
      .parse(appSecret.BETTER_AUTH_SECRET_VERSION ?? 1);
    const username = z.literal('auth_runtime').parse(dbSecret.username);
    const password = z.string().min(1).parse(dbSecret.password);
    const dbName = z
      .literal('gootip')
      .parse(required('GOOTIP_AUTH_ADMIN_DB_NAME'));
    const betterAuthUrl = z
      .literal(required('GOOTIP_DEV_API_URL'))
      .parse(required('BETTER_AUTH_URL'));
    const jwtAudience = z
      .literal('gootip-auth-dev')
      .parse(required('JWT_AUDIENCE'));
    const frontendUrl = z
      .literal('http://localhost:3000')
      .parse(required('FRONTEND_URL'));
    const env = readEnv({
      ...process.env,
      POSTGRES_DB_HOST: '127.0.0.1',
      POSTGRES_DB_PORT: String(localPort),
      POSTGRES_DB_NAME: dbName,
      POSTGRES_DB_USER: username,
      POSTGRES_DB_PASSWORD: password,
      POSTGRES_SSL_MODE: 'verify-full',
      POSTGRES_CA_PATH: caPath,
      BETTER_AUTH_SECRET: signingSecret,
      BETTER_AUTH_URL: betterAuthUrl,
      JWT_AUDIENCE: jwtAudience,
      FRONTEND_URL: frontendUrl,
      AUTH_PG_POOL_MAX: '1',
    });
    stage = 'CA loading';
    pool = new Pool({
      host: '127.0.0.1',
      port: localPort,
      database: dbName,
      user: username,
      password,
      max: 1,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      ssl: {
        ca: readFileSync(caPath, 'utf8'),
        rejectUnauthorized: true,
        servername: rdsHost,
      },
    });
    stage = 'database connection and existing administrator check';
    const existing = await pool.query<{ email: string; role: string }>(
      `SELECT email, role FROM auth."user"
       WHERE role = 'admin' OR lower(email) = lower($1)`,
      [email],
    );
    const action = initialAdminAction(existing.rows, email);
    if (action === 'no_changes') {
      console.log(
        'Initial administrator already exists; no_changes. This run did not verify sign-in or session revocation.',
      );
      return;
    }
    if (action === 'stop') {
      throw new Error(
        'An administrator or requested email already exists; review required.',
      );
    }

    stage = 'private password input';
    const firstPassword = await promptHidden(readline, 'Admin password: ');
    const confirmation = await promptHidden(
      readline,
      'Confirm admin password: ',
    );
    stage = 'password confirmation (matching values, minimum 32 characters)';
    if (firstPassword.length < 32 || firstPassword !== confirmation) {
      throw new Error(
        'Password confirmation failed or password is shorter than 32 characters.',
      );
    }

    stage = 'Auth initialization';
    const auth = createAuth(env, pool, [
      { version: signingVersion, value: signingSecret },
    ]);
    stage = 'administrator creation';
    const created = await auth.api.createUser({
      body: { email, name, password: firstPassword, role: 'admin' },
    });
    stage = 'created administrator identity verification';
    if (
      created.user.email.toLowerCase() !== email.toLowerCase() ||
      created.user.role !== 'admin'
    ) {
      throw new Error(
        'Created administrator identity did not match the request.',
      );
    }
    stage = 'administrator sign-in verification';
    const session = await auth.api.signInEmail({
      body: { email, password: firstPassword },
    });
    try {
      if (session.user.id !== created.user.id) {
        throw new Error(
          'Administrator sign-in identity did not match the created user.',
        );
      }
    } finally {
      stage = 'verification session revocation';
      await auth.api.signOut({
        headers: new Headers({ authorization: `Bearer ${session.token}` }),
      });
    }
    console.log(
      'Initial administrator created; sign-in verified and session revoked.',
    );
  } finally {
    await pool?.end();
    secretClient.destroy();
    readline.close();
  }
};

run().catch((error: unknown) => {
  console.error(
    `Private administrator bootstrap failed during ${stage}; code=${safeAdminBootstrapErrorCode(error)}. No error details or credentials are logged.`,
  );
  console.error(
    'If creation was attempted, reconcile the existing administrator before retrying; do not delete users or reset credentials.',
  );
  process.exitCode = 1;
});
