import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  splitSqlStatements,
  validateMigrationSql,
} from '../src/migration-runner/sql-policy.js';

const reviewedSql = readFileSync(
  fileURLToPath(
    new URL('../migrations/000001-initial-auth.sql', import.meta.url),
  ),
  'utf8',
);

const problems = (sql: string): readonly string[] => {
  const result = validateMigrationSql(sql);

  return result.ok ? [] : result.problems;
};

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons and drops comments', () => {
    expect(
      splitSqlStatements(`
        -- leading comment; with a semicolon
        create table a (id int);
        /* block ; comment /* nested ; */ still a comment */
        create index a_idx on a (id);
      `),
    ).toEqual(['create table a (id int)', 'create index a_idx on a (id)']);
  });

  it('does not split on semicolons inside literals, identifiers, or bodies', () => {
    expect(
      splitSqlStatements(`
        select 'a;b', "weird;name";
        create function f() returns int as $$ begin; return 1; end $$ language plpgsql;
        select E'a\\';b';
      `),
    ).toHaveLength(3);
  });

  it('keeps a trailing statement without a semicolon', () => {
    expect(splitSqlStatements('select 1')).toEqual(['select 1']);
  });

  it('ignores empty statements', () => {
    expect(splitSqlStatements(';; ;')).toEqual([]);
  });
});

describe('validateMigrationSql', () => {
  it('accepts the reviewed initial migration', () => {
    const result = validateMigrationSql(reviewedSql);

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.statements).toHaveLength(8);
    expect(result.ok && result.statements[0]?.command).toBe('CREATE');
  });

  it('accepts the reviewed create, revoke, and set forms', () => {
    expect(
      problems(`
        create table t (id int primary key);
        alter table t add column name text;
        revoke all on table t from public;
        set local search_path to auth;
        comment on table t is 'reviewed';
        create unique index t_name_idx on t (name);
      `),
    ).toEqual([]);
  });

  for (const [sql, reason] of [
    ['begin;', 'transaction control'],
    ['commit;', 'transaction control'],
    ['end;', 'transaction control'],
    ['rollback;', 'transaction control'],
    ['abort;', 'transaction control'],
    ['start transaction;', 'transaction control'],
    ['savepoint a;', 'transaction control'],
    ['release savepoint a;', 'transaction control'],
    ['prepare transaction ' + "'x';", 'transaction control'],
    ['set role auth_migrator;', 'role switching'],
    ['set local role auth_runtime;', 'role switching'],
    ['set session authorization auth_runtime;', 'role switching'],
    ['reset role;', 'role switching'],
    ['alter system set work_mem = 1;', 'connection-target change'],
    ['alter database gootip set work_mem = 1;', 'connection-target change'],
    ['alter role auth_runtime set work_mem = 1;', 'connection-target change'],
    ['create database other;', 'connection-target change'],
    [
      'create index concurrently t_idx on t (id);',
      'nontransactional operation',
    ],
    ['reindex index concurrently t_idx;', 'nontransactional operation'],
    ['vacuum full t;', 'nontransactional operation'],
    ['cluster t;', 'nontransactional operation'],
    ['call fix_it();', 'nontransactional operation'],
    ['do $$ begin null; end $$;', 'nontransactional operation'],
    ['create subscription s connection ' + "'x'", 'nontransactional operation'],
    ['alter subscription s refresh publication;', 'nontransactional operation'],
    [
      'refresh materialized view concurrently mv;',
      'nontransactional operation',
    ],
    ["copy t from program 'rm -rf /';", 'shell command'],
  ] as const) {
    it(`rejects ${sql.split(' ')[0]} (${reason})`, () => {
      const found = problems(sql);

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(reason);
      expect(found[0]).toContain('statement 1');
    });
  }

  it('rejects a transaction boundary hidden after valid SQL', () => {
    const found = problems('create table t (id int);\n  /* note */ COMMIT ;\n');

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('statement 2');
    expect(found[0]).toContain('transaction control');
  });

  it('cannot be evaded with a backslash-escaped quote', () => {
    const found = problems("select 'a\\'; commit;");

    expect(
      found.some((problem) => problem.includes('transaction control')),
    ).toBe(true);
  });

  it('does not flag forbidden words inside literals, identifiers, or bodies', () => {
    expect(
      problems(`
        comment on table t is 'commit; rollback';
        alter table "commit" add column "vacuum" int;
        create function f() returns int as $body$ begin return 1; end $body$ language plpgsql;
      `),
    ).toEqual([]);
  });

  it('rejects a file with no statements', () => {
    expect(problems('-- nothing reviewed here\n')).toEqual([
      'the migration contains no SQL statements',
    ]);
  });
});
