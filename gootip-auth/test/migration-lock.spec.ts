import { describe, expect, it } from 'vitest';

import {
  ADVISORY_LOCK_SCOPE,
  acquireSessionLock,
  advisoryLockIdentity,
  advisoryLockKey,
  releaseSessionLock,
} from '../src/migration-runner/lock.js';
import type { Queryable } from '../src/migration-runner/schema-descriptor.js';

const fakeClock = (
  startMs = 0,
): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let current = startMs;

  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
};

const scriptedQueryable = (
  rows: readonly (readonly Record<string, unknown>[])[],
): {
  queryable: Queryable;
  attempts: () => number;
  values: () => unknown[][];
} => {
  const queue = [...rows];
  const values: unknown[][] = [];

  return {
    attempts: () => values.length,
    values: () => values,
    queryable: {
      query: async (_text, parameters) => {
        values.push(parameters ? [...parameters] : []);
        const next = queue.shift();

        return { rows: next ?? [] };
      },
    },
  };
};

describe('advisory lock identity', () => {
  it('derives the key from the database and schema, not the workflow or run', () => {
    expect(advisoryLockIdentity('gootip', 'auth')).toBe(
      `${ADVISORY_LOCK_SCOPE}:gootip:auth`,
    );
    expect(advisoryLockKey('gootip', 'auth')).toBe('1129090495775515127');

    expect(advisoryLockKey('gootip', 'auth')).toBe(
      advisoryLockKey('gootip', 'auth'),
    );
    expect(advisoryLockKey('gootip', 'auth')).not.toBe(
      advisoryLockKey('gootip', 'core'),
    );
    expect(advisoryLockKey('gootip', 'auth')).not.toBe(
      advisoryLockKey('other', 'auth'),
    );
  });

  it('fits the PostgreSQL signed 64-bit lock space', () => {
    const key = BigInt(advisoryLockKey('gootip', 'auth'));

    expect(key).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(key).toBeLessThan(2n ** 63n);
  });
});

describe('acquireSessionLock', () => {
  it('takes a free lock on the first attempt', async () => {
    const clock = fakeClock();
    const scripted = scriptedQueryable([[{ locked: true }]]);

    expect(
      await acquireSessionLock(scripted.queryable, '7', {
        timeoutMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).toEqual({ ok: true });
    expect(scripted.attempts()).toBe(1);
    expect(scripted.values()[0]).toEqual(['7']);
  });

  it('retries within a bounded deadline and then fails without mutating', async () => {
    const clock = fakeClock();
    const scripted = scriptedQueryable([]);

    expect(
      await acquireSessionLock(scripted.queryable, '7', {
        timeoutMs: 1000,
        pollIntervalMs: 250,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).toEqual({ ok: false, errorCode: 'lock_timeout' });

    expect(scripted.attempts()).toBe(5);
    expect(clock.now()).toBe(1000);
  });

  it('succeeds as soon as a contended lock is released', async () => {
    const clock = fakeClock();
    const scripted = scriptedQueryable([
      [{ locked: false }],
      [{ locked: false }],
      [{ locked: true }],
    ]);

    expect(
      await acquireSessionLock(scripted.queryable, '7', {
        timeoutMs: 10_000,
        pollIntervalMs: 250,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).toEqual({ ok: true });
    expect(scripted.attempts()).toBe(3);
    expect(clock.now()).toBe(500);
  });

  it('makes exactly one attempt with no budget', async () => {
    const clock = fakeClock();
    const scripted = scriptedQueryable([]);

    expect(
      await acquireSessionLock(scripted.queryable, '7', {
        timeoutMs: 0,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).toEqual({ ok: false, errorCode: 'lock_timeout' });
    expect(scripted.attempts()).toBe(1);
    expect(clock.now()).toBe(0);
  });
});

describe('releaseSessionLock', () => {
  it('reports whether this session held the lock', async () => {
    expect(
      await releaseSessionLock(
        scriptedQueryable([[{ unlocked: true }]]).queryable,
        '7',
      ),
    ).toBe(true);
    expect(
      await releaseSessionLock(
        scriptedQueryable([[{ unlocked: false }]]).queryable,
        '7',
      ),
    ).toBe(false);
  });
});
