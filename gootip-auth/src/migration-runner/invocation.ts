import type { MigrationOperation } from './contract.js';

/** Immutable Lambda aliases configured by Terraform for the two operation paths. */
export const DEPLOYMENT_ALIAS = 'deployment';
export const BASELINE_ALIAS = 'baseline';

const OPERATIONS_BY_ALIAS: Record<string, readonly MigrationOperation[]> = {
  [DEPLOYMENT_ALIAS]: ['validate', 'apply'],
  [BASELINE_ALIAS]: ['baseline_check', 'baseline_adopt'],
};

/**
 * A Lambda invoked ARN ends in the trusted qualifier selected by Lambda. The
 * event never participates in this decision. Unqualified, numeric-version,
 * `$LATEST`, malformed, and unknown-alias invocations deliberately return no
 * alias and therefore cannot reach credentials or the database.
 */
const aliasFromInvocationArn = (
  invokedFunctionArn: string | null,
): string | null => {
  if (invokedFunctionArn === null) {
    return null;
  }

  const match = /^arn:[^:]+:lambda:[^:]+:\d{12}:function:[^:]+:([^:]+)$/.exec(
    invokedFunctionArn,
  );
  const alias = match?.[1] ?? null;

  return alias !== null && alias in OPERATIONS_BY_ALIAS ? alias : null;
};

export const isInvocationAuthorized = (
  operation: MigrationOperation,
  invokedFunctionArn: string | null,
): boolean => {
  const alias = aliasFromInvocationArn(invokedFunctionArn);

  return (
    alias !== null && (OPERATIONS_BY_ALIAS[alias] ?? []).includes(operation)
  );
};
