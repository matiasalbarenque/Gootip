import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';

import type { MigrationConfig } from './config.js';

/**
 * The current migrator credential is read from the allowlisted secret on every
 * invocation. No password is retained in the ZIP, manifest, event, environment,
 * logs, or response, and the username in the secret must match the configured
 * `auth_migrator`.
 */

export interface MigrationCredential {
  username: string;
  password: string;
}

export type CredentialLoadResult =
  | { ok: true; credential: MigrationCredential }
  | { ok: false };

interface SecretClient {
  send(
    command: GetSecretValueCommand,
  ): Promise<Pick<GetSecretValueCommandOutput, 'SecretString'>>;
}

export const parseMigratorSecret = (
  secretString: string | undefined,
  expectedUser: string,
): MigrationCredential | null => {
  if (!secretString) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(secretString);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const { username, password } = parsed as Record<string, unknown>;

  if (typeof username !== 'string' || username.length === 0) {
    return null;
  }

  if (typeof password !== 'string' || password.length === 0) {
    return null;
  }

  if (username !== expectedUser) {
    return null;
  }

  return { username, password };
};

export const loadMigratorCredential = async (
  config: MigrationConfig,
  client: SecretClient = new SecretsManagerClient({}),
): Promise<CredentialLoadResult> => {
  try {
    const output = await client.send(
      new GetSecretValueCommand({ SecretId: config.credentialSecretArn }),
    );
    const credential = parseMigratorSecret(output.SecretString, config.user);

    return credential ? { ok: true, credential } : { ok: false };
  } catch {
    return { ok: false };
  }
};
