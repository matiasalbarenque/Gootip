import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';

interface SecretClient {
  send(
    command: GetSecretValueCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<Pick<GetSecretValueCommandOutput, 'SecretString' | 'VersionId'>>;
}

export const RUNTIME_DB_USERNAME = 'core_runtime';

export interface RuntimeCredentialVersion {
  versionId: string;
  username: string;
  password: string;
}

const readCurrentSecret = async (
  client: SecretClient,
  secretArn: string,
  timeoutMs: number,
): Promise<{ secret: Record<string, unknown>; versionId: string }> => {
  let output: Pick<GetSecretValueCommandOutput, 'SecretString' | 'VersionId'>;
  try {
    output = await client.send(
      new GetSecretValueCommand({
        SecretId: secretArn,
        VersionStage: 'AWSCURRENT',
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
  } catch {
    throw new Error(
      'CORE_RUNTIME_SECRET_ARN could not be retrieved from Secrets Manager.',
    );
  }

  if (
    typeof output.SecretString !== 'string' ||
    output.SecretString.length === 0
  ) {
    throw new Error('CORE_RUNTIME_SECRET_ARN holds no string value.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.SecretString);
  } catch {
    throw new Error('CORE_RUNTIME_SECRET_ARN is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CORE_RUNTIME_SECRET_ARN is not a JSON object.');
  }
  if (typeof output.VersionId !== 'string' || output.VersionId.length === 0) {
    throw new Error('CORE_RUNTIME_SECRET_ARN has no version identifier.');
  }

  return {
    secret: parsed as Record<string, unknown>,
    versionId: output.VersionId,
  };
};

export const loadCoreRuntimeCredential = async (
  client: SecretClient = new SecretsManagerClient({}),
  timeoutMs = 5_000,
): Promise<RuntimeCredentialVersion> => {
  const secretArn = process.env.CORE_RUNTIME_SECRET_ARN;
  if (!secretArn) {
    throw new Error(
      'CORE_RUNTIME_SECRET_ARN must be set for the AWS API runtime.',
    );
  }

  const { secret, versionId } = await readCurrentSecret(
    client,
    secretArn,
    timeoutMs,
  );
  if (typeof secret.username !== 'string' || secret.username.length === 0) {
    throw new Error('CORE_RUNTIME_SECRET_ARN is missing the runtime username.');
  }
  if (secret.username !== RUNTIME_DB_USERNAME) {
    throw new Error(
      `CORE_RUNTIME_SECRET_ARN username must be ${RUNTIME_DB_USERNAME}.`,
    );
  }
  if (typeof secret.password !== 'string' || secret.password.length === 0) {
    throw new Error('CORE_RUNTIME_SECRET_ARN is missing the runtime password.');
  }

  process.env.POSTGRES_DB_USER = RUNTIME_DB_USERNAME;
  process.env.POSTGRES_DB_PASSWORD = secret.password;
  return {
    versionId,
    username: RUNTIME_DB_USERNAME,
    password: secret.password,
  };
};
