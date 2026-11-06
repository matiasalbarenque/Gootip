/**
 * Fixed invocation and result contract for the private auth migration runner.
 *
 * The handler accepts only these operations and returns only the fields below.
 * Values are never taken from the event beyond correlation identifiers and
 * expected digests; database, schema, role, and secret identities come from
 * validated deployment configuration.
 */

export const MIGRATION_OPERATIONS = [
  'validate',
  'apply',
  'baseline_check',
  'baseline_adopt',
] as const;

export type MigrationOperation = (typeof MIGRATION_OPERATIONS)[number];

export const MIGRATION_STATUSES = [
  'succeeded',
  'no_changes',
  'baseline_approval_required',
  'failed',
] as const;

export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export const MIGRATION_ERROR_CODES = [
  'invalid_request',
  'configuration_error',
  'credential_error',
  'connection_error',
  'database_identity_mismatch',
  'privilege_mismatch',
  'manifest_mismatch',
  'history_invalid',
  'sql_policy_violation',
  'lock_timeout',
  'operation_timeout',
  'sql_failed',
  'baseline_mismatch',
  'verification_failed',
  'not_implemented',
] as const;

export type MigrationErrorCode = (typeof MIGRATION_ERROR_CODES)[number];

export interface MigrationRequest {
  operation: MigrationOperation;
  run_id: string;
  commit_sha: string;
  expected_manifest_sha256: string;
  expected_history_sha256?: string;
  approval_reference?: string;
  expected_schema_fingerprint?: string;
}

export interface MigrationResult {
  status: MigrationStatus;
  operation: MigrationOperation | null;
  run_id: string | null;
  commit_sha: string | null;
  manifest_sha256: string | null;
  history_sha256: string | null;
  applied_ids: string[];
  pending_ids: string[];
  error_code: MigrationErrorCode | null;
}

type MigrationResultInput = Partial<Omit<MigrationResult, 'status'>> & {
  status: MigrationStatus;
};

/**
 * Builds a result with every allowlisted field present and defaults filled in,
 * so a response never leaks unexpected keys or raw error detail.
 */
export const createResult = (input: MigrationResultInput): MigrationResult => ({
  status: input.status,
  operation: input.operation ?? null,
  run_id: input.run_id ?? null,
  commit_sha: input.commit_sha ?? null,
  manifest_sha256: input.manifest_sha256 ?? null,
  history_sha256: input.history_sha256 ?? null,
  applied_ids: input.applied_ids ?? [],
  pending_ids: input.pending_ids ?? [],
  error_code: input.error_code ?? null,
});
