/**
 * Reviewed-SQL policy for migration files.
 *
 * Each file is split into statements by a scanner that understands line and
 * block comments, nested block comments, standard and `E''` string literals,
 * quoted identifiers, and dollar-quoted bodies. Classifying statements from that
 * token stream — rather than matching regular expressions over the raw file —
 * means a forbidden command cannot be hidden behind case, whitespace, comments,
 * or string/identifier quoting, and a keyword inside a function body is not a
 * false positive.
 *
 * The runner executes the whole file inside one transaction it opens itself, so
 * the policy rejects the four categories the execution protocol cannot tolerate:
 * transaction boundaries, role switching, connection-target changes, and
 * operations PostgreSQL refuses to roll back. Shell access (`COPY ... FROM
 * PROGRAM`) and procedure calls that could commit are rejected as well.
 */

export interface SqlStatement {
  /** 1-based position among the non-empty statements in the file. */
  position: number;
  /** Leading bare keyword, upper-case. */
  command: string;
}

export type SqlPolicyResult =
  | { ok: true; statements: readonly SqlStatement[] }
  | { ok: false; problems: readonly string[] };

/** Ends or starts a transaction block. */
const TRANSACTION_CONTROL = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'END',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
]);

/** Nontransactional or transaction-escaping commands. */
const NONTRANSACTIONAL_COMMANDS = new Set([
  'VACUUM',
  'CLUSTER',
  'CALL',
  'DO',
  'CHECKPOINT',
  'DISCARD',
  'LOAD',
]);

type StatementViolation =
  | 'transaction control'
  | 'role switching'
  | 'connection-target change'
  | 'nontransactional operation'
  | 'shell command';

const normalizeWords = (statement: string): string[] => {
  const words: string[] = [];
  let index = 0;

  while (index < statement.length) {
    const char = statement[index] as string;

    if (char === "'") {
      const escapeMode = /[Ee]$/.test(statement.slice(0, index));
      let escaped = false;
      index += 1;

      while (index < statement.length) {
        const current = statement[index] as string;

        if (escaped) {
          escaped = false;
          index += 1;
          continue;
        }

        if (escapeMode && current === '\\') {
          escaped = true;
          index += 1;
          continue;
        }

        if (current === "'") {
          if (statement[index + 1] === "'") {
            index += 2;
            continue;
          }

          index += 1;
          break;
        }

        index += 1;
      }

      continue;
    }

    if (char === '"') {
      index += 1;

      while (index < statement.length) {
        if (statement[index] === '"') {
          if (statement[index + 1] === '"') {
            index += 2;
            continue;
          }

          index += 1;
          break;
        }

        index += 1;
      }

      continue;
    }

    const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(statement.slice(index));

    if (match) {
      words.push(match[0].toUpperCase());
      index += match[0].length;
      continue;
    }

    index += 1;
  }

  return words;
};

const isRoleSwitch = (words: readonly string[]): boolean => {
  const [command, second] = words;

  if (command === 'SET') {
    const rest = words.slice(1);
    const withoutModifier =
      rest[0] === 'SESSION' || rest[0] === 'LOCAL' ? rest.slice(1) : rest;

    return (
      withoutModifier[0] === 'ROLE' ||
      (rest[0] === 'SESSION' && withoutModifier[0] === 'AUTHORIZATION')
    );
  }

  if (command === 'RESET') {
    return second === 'ROLE' || second === 'SESSION';
  }

  return false;
};

const isConnectionTargetChange = (words: readonly string[]): boolean => {
  const [command, first] = words;

  if (command === 'ALTER') {
    return first === 'SYSTEM' || first === 'DATABASE' || first === 'ROLE';
  }

  if (command === 'CREATE' || command === 'DROP') {
    return first === 'DATABASE' || first === 'TABLESPACE';
  }

  return false;
};

const isNontransactional = (words: readonly string[]): boolean => {
  const [command, first] = words;

  if (command !== undefined && NONTRANSACTIONAL_COMMANDS.has(command)) {
    return true;
  }

  if (command === 'REINDEX' && words.includes('CONCURRENTLY')) {
    return true;
  }

  if (
    command === 'CREATE' &&
    (first === 'INDEX' || first === 'UNIQUE') &&
    words.includes('CONCURRENTLY')
  ) {
    return true;
  }

  if (command === 'CREATE' && first === 'SUBSCRIPTION') {
    return true;
  }

  if (
    command === 'ALTER' &&
    first === 'SUBSCRIPTION' &&
    words.includes('REFRESH')
  ) {
    return true;
  }

  if (command === 'REFRESH' && words.includes('CONCURRENTLY')) {
    return true;
  }

  return false;
};

const isPreparedTransaction = (words: readonly string[]): boolean => {
  const [command, first] = words;

  return command === 'PREPARE' && first === 'TRANSACTION';
};

const classify = (statement: string): StatementViolation | null => {
  const words = normalizeWords(statement);
  const [command] = words;

  if (command === undefined) {
    return null;
  }

  if (TRANSACTION_CONTROL.has(command) || isPreparedTransaction(words)) {
    return 'transaction control';
  }

  if (isRoleSwitch(words)) {
    return 'role switching';
  }

  if (isConnectionTargetChange(words)) {
    return 'connection-target change';
  }

  if (isNontransactional(words)) {
    return 'nontransactional operation';
  }

  if (command === 'COPY' && words.includes('PROGRAM')) {
    return 'shell command';
  }

  return null;
};

/**
 * Splits a migration file into non-empty statements, removing comments.
 *
 * The scan follows `standard_conforming_strings = on`, which is the PostgreSQL
 * default and is not changed by the runner: inside a plain `'...'` literal only
 * a doubled quote escapes, so a backslash cannot be used to swallow the end of a
 * statement. `E'...'` literals do honor backslash escapes.
 */
export const splitSqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  const flush = (): void => {
    if (current.trim().length > 0) {
      statements.push(current.trim());
    }

    current = '';
  };

  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      index += 2;

      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }

      current += ' ';
      continue;
    }

    if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;

      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
          continue;
        }

        if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
          continue;
        }

        index += 1;
      }

      current += ' ';
      continue;
    }

    if (char === "'") {
      const escapeMode = /[Ee]$/.test(current);
      let literal = "'";
      index += 1;

      while (index < sql.length) {
        const value = sql[index] as string;

        if (escapeMode && value === '\\') {
          literal += value + (sql[index + 1] ?? '');
          index += 2;
          continue;
        }

        if (value === "'") {
          if (sql[index + 1] === "'") {
            literal += "''";
            index += 2;
            continue;
          }

          literal += "'";
          index += 1;
          break;
        }

        literal += value;
        index += 1;
      }

      current += literal;
      continue;
    }

    if (char === '"') {
      let identifier = '"';
      index += 1;

      while (index < sql.length) {
        const value = sql[index] as string;

        if (value === '"') {
          if (sql[index + 1] === '"') {
            identifier += '""';
            index += 2;
            continue;
          }

          identifier += '"';
          index += 1;
          break;
        }

        identifier += value;
        index += 1;
      }

      current += identifier;
      continue;
    }

    if (char === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));

      if (tag) {
        const delimiter = tag[0];
        const end = sql.indexOf(delimiter, index + delimiter.length);
        const stop = end === -1 ? sql.length : end + delimiter.length;

        current += sql.slice(index, stop);
        index = stop;
        continue;
      }
    }

    if (char === ';') {
      flush();
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  flush();

  return statements;
};

export const validateMigrationSql = (sql: string): SqlPolicyResult => {
  const statements = splitSqlStatements(sql);
  const problems: string[] = [];

  if (statements.length === 0) {
    problems.push('the migration contains no SQL statements');
  }

  statements.forEach((statement, index) => {
    const violation = classify(statement);
    const command = normalizeWords(statement)[0] ?? 'unknown';

    if (violation) {
      problems.push(
        `statement ${index + 1} (${command}) is not allowed: ${violation}`,
      );
    }
  });

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    statements: statements.map((statement, index) => ({
      position: index + 1,
      command: normalizeWords(statement)[0] ?? 'unknown',
    })),
  };
};
