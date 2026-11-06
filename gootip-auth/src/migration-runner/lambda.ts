import type { Context } from 'aws-lambda';

import type { MigrationResult } from './contract.js';
import { runMigration } from './handler.js';

/**
 * Adapts the runtime's real remaining time for the operation budget.
 *
 * The handler combines it with the reviewed total-operation timeout and the
 * cleanup margin, so a slow cold start or a shortened function timeout cannot
 * let the work outlive the invocation.
 */
export const invocationRemaining =
  (context: Pick<Context, 'getRemainingTimeInMillis'>) => (): number =>
    context.getRemainingTimeInMillis();

export const invocationArn =
  (context: Pick<Context, 'invokedFunctionArn'>): (() => string | null) =>
  () =>
    context.invokedFunctionArn ?? null;

/**
 * Lambda entry point for the private auth migration runner.
 *
 * Built with `pnpm build:migration-lambda` into `dist/migrations/lambda.mjs`
 * and deployed with the handler `dist/migrations/lambda.handler`.
 */
export const handler = (
  event: unknown,
  context?: Pick<Context, 'getRemainingTimeInMillis' | 'invokedFunctionArn'>,
): Promise<MigrationResult> =>
  runMigration(
    event,
    context
      ? {
          remainingInvocationMs: invocationRemaining(context),
          invokedFunctionArn: invocationArn(context),
        }
      : {},
  );
