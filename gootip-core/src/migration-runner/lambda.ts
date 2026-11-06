import type { Context } from 'aws-lambda';

import { runMigration } from './handler.js';

/** Lambda entry point; authorization uses the trusted runtime invocation ARN. */
export const handler = (
  event: unknown,
  context: Pick<Context, 'invokedFunctionArn'>,
) =>
  runMigration(event, {
    invokedFunctionArn: () => context.invokedFunctionArn ?? null,
  });
