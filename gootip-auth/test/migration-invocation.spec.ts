import { describe, expect, it } from 'vitest';

import { runMigration } from '../src/migration-runner/handler.js';
import { isInvocationAuthorized } from '../src/migration-runner/invocation.js';

const deploymentArn =
  'arn:aws:lambda:us-east-2:123456789012:function:gootip-dev-auth-migrations:deployment';
const baselineArn =
  'arn:aws:lambda:us-east-2:123456789012:function:gootip-dev-auth-migrations:baseline';
const unqualifiedArn =
  'arn:aws:lambda:us-east-2:123456789012:function:gootip-dev-auth-migrations';

const event = (operation: string) => ({
  operation,
  run_id: 'run-1',
  commit_sha: 'a'.repeat(40),
  expected_manifest_sha256: 'b'.repeat(64),
  ...(operation === 'baseline_adopt'
    ? {
        approval_reference: 'OPS-42',
        expected_schema_fingerprint: 'c'.repeat(64),
        expected_history_sha256: 'd'.repeat(64),
      }
    : {}),
});

describe('trusted migration invocation authorization', () => {
  it('enforces the complete operation and alias matrix', () => {
    expect(isInvocationAuthorized('validate', deploymentArn)).toBe(true);
    expect(isInvocationAuthorized('apply', deploymentArn)).toBe(true);
    expect(isInvocationAuthorized('baseline_check', deploymentArn)).toBe(false);
    expect(isInvocationAuthorized('baseline_adopt', deploymentArn)).toBe(false);

    expect(isInvocationAuthorized('validate', baselineArn)).toBe(false);
    expect(isInvocationAuthorized('apply', baselineArn)).toBe(false);
    expect(isInvocationAuthorized('baseline_check', baselineArn)).toBe(true);
    expect(isInvocationAuthorized('baseline_adopt', baselineArn)).toBe(true);
  });

  it('rejects unqualified, numeric-version, latest, unknown, and missing contexts', () => {
    for (const arn of [
      unqualifiedArn,
      `${unqualifiedArn}:1`,
      `${unqualifiedArn}:$LATEST`,
      `${unqualifiedArn}:unknown`,
      null,
    ]) {
      expect(isInvocationAuthorized('apply', arn)).toBe(false);
      expect(isInvocationAuthorized('baseline_adopt', arn)).toBe(false);
    }
  });

  it('rejects forbidden operations before credentials or database connection', async () => {
    let credentialLoads = 0;
    let connections = 0;
    const result = await runMigration(event('baseline_adopt'), {
      invokedFunctionArn: () => deploymentArn,
      env: {},
      loadCredential: async () => {
        credentialLoads += 1;
        return { ok: false as const };
      },
      connect: async () => {
        connections += 1;
        return { ok: false as const, errorCode: 'connection_error' as const };
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'invalid_request',
    });
    expect(credentialLoads).toBe(0);
    expect(connections).toBe(0);
  });
});
