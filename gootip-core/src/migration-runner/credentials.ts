import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';

export type MigrationCredential = { username: string; password: string };
type SecretClient = {
  send(
    command: GetSecretValueCommand,
  ): Promise<Pick<GetSecretValueCommandOutput, 'SecretString'>>;
};

/** Accepts only the configured Core migrator identity from the secret payload. */
export const parseMigratorSecret = (
  secretString: string | undefined,
): MigrationCredential | null => {
  try {
    const value: unknown = JSON.parse(secretString ?? '');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const { username, password } = value as Record<string, unknown>;
    return username === 'core_migrator' &&
      typeof password === 'string' &&
      password
      ? { username, password }
      : null;
  } catch {
    return null;
  }
};

/** Fetches the migrator credential from the configured secret for this invocation. */
export const loadMigratorCredential = async (
  secretArn: string,
  client: SecretClient = new SecretsManagerClient({}),
): Promise<MigrationCredential> => {
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const credential = parseMigratorSecret(result.SecretString);
  if (!credential) throw new Error('Invalid migrator secret');
  return credential;
};
