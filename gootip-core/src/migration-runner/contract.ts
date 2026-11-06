import { createHash } from 'node:crypto';

export type MigrationRequest = {
  operation: 'validate' | 'apply';
  run_id: string;
  commit_sha: string;
  expected_manifest_sha256: string;
  expected_history_sha256?: string;
};

export type MigrationResult = {
  operation: 'validate' | 'apply';
  run_id: string;
  commit_sha: string;
  status: 'succeeded' | 'no_changes' | 'failed';
  manifest_sha256: string;
  history_sha256: string | null;
  applied_names: string[];
  pending_names: string[];
  error_code: string | null;
};

const requestFields = new Set([
  'operation',
  'run_id',
  'commit_sha',
  'expected_manifest_sha256',
  'expected_history_sha256',
]);

export const parseMigrationRequest = (value: unknown): MigrationRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid migration request');
  }

  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => !requestFields.has(key))) {
    throw new Error('Invalid migration request');
  }
  if (request.operation !== 'validate' && request.operation !== 'apply') {
    throw new Error('Invalid migration request');
  }
  if (
    typeof request.run_id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(request.run_id) ||
    typeof request.commit_sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(request.commit_sha) ||
    typeof request.expected_manifest_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.expected_manifest_sha256) ||
    (request.expected_history_sha256 !== undefined &&
      (typeof request.expected_history_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.expected_history_sha256)))
  ) {
    throw new Error('Invalid migration request');
  }

  return request as MigrationRequest;
};

export const assertArtifactIdentity = (
  request: MigrationRequest,
  commitSha: string,
  manifestSha256: string,
): void => {
  if (
    request.commit_sha !== commitSha ||
    request.expected_manifest_sha256 !== manifestSha256
  ) {
    throw new Error('Migration artifact identity mismatch');
  }
};

export const migrationHistorySha256 = (
  history: { name: string; timestamp: number }[],
): string => createHash('sha256').update(JSON.stringify(history)).digest('hex');
