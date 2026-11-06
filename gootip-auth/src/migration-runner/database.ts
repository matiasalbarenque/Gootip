import { readFileSync } from 'node:fs';

import { Client } from 'pg';

import type { OperationBudget } from './budget.js';
import type { MigrationConfig } from './config.js';
import type { MigrationCredential } from './credentials.js';
import type { Queryable } from './schema-descriptor.js';

/**
 * One dedicated connection carries the whole migration operation: bounded
 * connect, statement, and database lock-wait timeouts are applied here, and the
 * session advisory lock is taken on top of it by `session.ts`.
 */

export interface MigrationConnection extends Queryable {
  close(): Promise<void>;
}

export type ConnectionResult =
  | { ok: true; connection: MigrationConnection }
  | { ok: false; errorCode: 'credential_error' | 'connection_error' };

const invalidAuthorization = new Set(['28P01', '28000']);

/**
 * Server-side timeouts, set on the dedicated connection so they survive any
 * client-side path and bound a runaway statement or lock wait even if the
 * in-process deadline is never reached.
 */
const SESSION_TIMEOUTS_SQL = `
  SELECT set_config('statement_timeout', $1, false) AS statement_timeout,
         set_config('lock_timeout', $2, false) AS lock_timeout,
         set_config('idle_in_transaction_session_timeout', $1, false) AS idle_in_transaction_session_timeout
`;

/**
 * Maps a driver failure to a bounded error code using the SQLSTATE only, so no
 * driver message, host, user, or password can reach a result or a log line.
 */
export const classifyConnectionError = (
  error: unknown,
): 'credential_error' | 'connection_error' => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  return typeof code === 'string' && invalidAuthorization.has(code)
    ? 'credential_error'
    : 'connection_error';
};

export const connectToDatabase = async (
  config: MigrationConfig,
  credential: MigrationCredential,
  budget: OperationBudget,
): Promise<ConnectionResult> => {
  try {
    const client = new Client({
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: credential.username,
      password: credential.password,
      application_name: 'gootip-auth-migrations',
      connectionTimeoutMillis: Math.max(
        1,
        budget.bounded(config.timeouts.connectSeconds * 1000),
      ),
      ssl:
        config.database.sslMode === 'disable'
          ? false
          : {
              ca: readFileSync(config.database.caPath as string, 'utf8'),
              rejectUnauthorized: true,
            },
    });

    await client.connect();
    await client.query(SESSION_TIMEOUTS_SQL, [
      `${Math.max(1, budget.bounded(config.timeouts.statementSeconds * 1000))}`,
      `${Math.max(1, budget.bounded(config.timeouts.lockSeconds * 1000))}`,
    ]);

    return {
      ok: true,
      connection: {
        query: async (text, values) => {
          const result = await client.query(
            text,
            values ? [...values] : undefined,
          );

          return { rows: result.rows as Record<string, unknown>[] };
        },
        close: async () => {
          await client.end();
        },
      },
    };
  } catch (error) {
    return { ok: false, errorCode: classifyConnectionError(error) };
  }
};
