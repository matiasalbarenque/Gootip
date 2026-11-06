import {
  MIGRATION_OPERATIONS,
  type MigrationOperation,
  type MigrationRequest,
} from './contract.js';
import {
  APPROVAL_REFERENCE_PATTERN,
  COMMIT_SHA_PATTERN,
  RUN_ID_PATTERN,
  SHA256_PATTERN,
} from './patterns.js';

/**
 * Strict validation of the synchronous invocation event.
 *
 * The handler accepts only the documented fields: identities, SQL, and
 * configuration never come from the event. Unknown or misplaced fields are
 * rejected instead of ignored so an operator cannot smuggle in an approval or
 * a target other than the packaged one.
 */

const REQUEST_FIELDS = [
  'operation',
  'run_id',
  'commit_sha',
  'expected_manifest_sha256',
  'expected_history_sha256',
  'approval_reference',
  'expected_schema_fingerprint',
] as const;

const BASELINE_ADOPTION_FIELDS = [
  'approval_reference',
  'expected_schema_fingerprint',
] as const;

/**
 * `validate` may carry the expected history digest for the activation
 * revalidation path owned by SPEC 10, and must stay usable before any
 * activation history exists (so it is optional there). `baseline_adopt`
 * requires it. Operations that never revalidate activation reject it.
 */
const HISTORY_DIGEST_REJECTING_OPERATIONS = [
  'apply',
  'baseline_check',
] as const;

export type RequestValidation =
  | { ok: true; request: MigrationRequest }
  | { ok: false; problems: string[] };

const isOperation = (value: unknown): value is MigrationOperation =>
  typeof value === 'string' &&
  (MIGRATION_OPERATIONS as readonly string[]).includes(value);

const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && SHA256_PATTERN.test(value);

export const validateMigrationRequest = (raw: unknown): RequestValidation => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: ['the event must be a JSON object'] };
  }

  const record = raw as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(REQUEST_FIELDS);

  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      problems.push(`unexpected event field: ${key}`);
    }
  }

  if (!isOperation(record.operation)) {
    problems.push(
      `operation must be one of ${MIGRATION_OPERATIONS.join(', ')}`,
    );
  }

  if (
    typeof record.run_id !== 'string' ||
    !RUN_ID_PATTERN.test(record.run_id)
  ) {
    problems.push('run_id must be a bounded correlation identifier');
  }

  if (
    typeof record.commit_sha !== 'string' ||
    !COMMIT_SHA_PATTERN.test(record.commit_sha)
  ) {
    problems.push('commit_sha must be a full commit hash');
  }

  if (!isDigest(record.expected_manifest_sha256)) {
    problems.push('expected_manifest_sha256 must be a sha256 hex digest');
  }

  if (
    record.expected_history_sha256 !== undefined &&
    !isDigest(record.expected_history_sha256)
  ) {
    problems.push('expected_history_sha256 must be a sha256 hex digest');
  }

  const operation = isOperation(record.operation) ? record.operation : null;

  if (operation === 'baseline_adopt') {
    if (
      typeof record.approval_reference !== 'string' ||
      !APPROVAL_REFERENCE_PATTERN.test(record.approval_reference)
    ) {
      problems.push('approval_reference is required for baseline adoption');
    }

    if (!isDigest(record.expected_schema_fingerprint)) {
      problems.push(
        'expected_schema_fingerprint is required for baseline adoption',
      );
    }

    if (!isDigest(record.expected_history_sha256)) {
      problems.push(
        'expected_history_sha256 is required for baseline adoption',
      );
    }
  }

  if (operation !== null && operation !== 'baseline_adopt') {
    for (const field of BASELINE_ADOPTION_FIELDS) {
      if (record[field] !== undefined) {
        problems.push(`${field} is only accepted for baseline_adopt`);
      }
    }
  }

  if (
    operation !== null &&
    (HISTORY_DIGEST_REJECTING_OPERATIONS as readonly string[]).includes(
      operation,
    ) &&
    record.expected_history_sha256 !== undefined
  ) {
    problems.push(`expected_history_sha256 is not accepted for ${operation}`);
  }

  if (problems.length > 0 || operation === null) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    request: {
      operation,
      run_id: record.run_id as string,
      commit_sha: record.commit_sha as string,
      expected_manifest_sha256: record.expected_manifest_sha256 as string,
      ...(record.expected_history_sha256 === undefined
        ? {}
        : {
            expected_history_sha256: record.expected_history_sha256 as string,
          }),
      ...(record.approval_reference === undefined
        ? {}
        : { approval_reference: record.approval_reference as string }),
      ...(record.expected_schema_fingerprint === undefined
        ? {}
        : {
            expected_schema_fingerprint:
              record.expected_schema_fingerprint as string,
          }),
    },
  };
};
