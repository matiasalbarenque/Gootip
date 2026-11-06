import { sha256Hex } from './digest.js';
import type { Queryable } from './schema-descriptor.js';

/**
 * Session advisory lock for the migration operation.
 *
 * The lock identity is derived only from the target database and schema, so
 * every workflow, operator, and invocation contends for the same key instead of
 * being able to bypass an in-flight migration by inventing a run ID. The key is
 * the first 64 bits of a SHA-256 digest over that documented identity, rendered
 * as a signed 64-bit integer for `pg_try_advisory_lock`.
 *
 * Acquisition is a bounded non-blocking loop: a deadline produces an explicit
 * failure without any mutation, rather than a statement waiting indefinitely.
 * The lock is session scoped, so it spans history verification, every
 * per-migration transaction, and final validation, and is released explicitly
 * in `finally`. PostgreSQL also drops it if the connection terminates, which is
 * the fallback when a Lambda is killed before its `finally` runs.
 */

export const ADVISORY_LOCK_SCOPE = 'gootip-auth-migrations';

export const ADVISORY_LOCK_POLL_INTERVAL_MS = 250;

export const advisoryLockIdentity = (
  database: string,
  schema: string,
): string => `${ADVISORY_LOCK_SCOPE}:${database}:${schema}`;

export const advisoryLockKey = (database: string, schema: string): string =>
  BigInt.asIntN(
    64,
    BigInt(
      `0x${sha256Hex(advisoryLockIdentity(database, schema)).slice(0, 16)}`,
    ),
  ).toString();

export const TRY_SESSION_LOCK_SQL =
  'SELECT pg_try_advisory_lock($1::bigint) AS locked';

export const RELEASE_SESSION_LOCK_SQL =
  'SELECT pg_advisory_unlock($1::bigint) AS unlocked';

export type LockOutcome =
  | { ok: true }
  | { ok: false; errorCode: 'lock_timeout' | 'verification_failed' };

export interface SessionLockOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Tries to take the session lock until the deadline. The first attempt always
 * happens, so a zero budget still reports contention accurately.
 */
export const acquireSessionLock = async (
  queryable: Queryable,
  key: string,
  options: SessionLockOptions,
): Promise<LockOutcome> => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = Math.max(
    1,
    Math.min(
      options.pollIntervalMs ?? ADVISORY_LOCK_POLL_INTERVAL_MS,
      Math.max(1, options.timeoutMs),
    ),
  );
  const deadline = now() + Math.max(0, options.timeoutMs);

  for (;;) {
    const row = (await queryable.query(TRY_SESSION_LOCK_SQL, [key])).rows[0];

    if (row?.locked === true) {
      return { ok: true };
    }

    const remaining = deadline - now();

    if (remaining <= 0) {
      return { ok: false, errorCode: 'lock_timeout' };
    }

    await sleep(Math.min(pollIntervalMs, remaining));
  }
};

/**
 * Releases the session lock and reports whether this session held it, which is
 * what lock-recovery evidence relies on.
 */
export const releaseSessionLock = async (
  queryable: Queryable,
  key: string,
): Promise<boolean> => {
  const row = (await queryable.query(RELEASE_SESSION_LOCK_SQL, [key])).rows[0];

  return row?.unlocked === true;
};
