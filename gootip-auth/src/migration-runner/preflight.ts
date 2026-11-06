import type { Queryable } from './schema-descriptor.js';

/**
 * Pre-mutation checks that bind the live session to the reviewed deployment
 * identity and reject roles or grants the migrator must not have.
 *
 * They run before the history table is touched and before any reviewed SQL, so
 * an unexpected role, database, membership, or cross-schema grant fails without
 * mutating anything. Only bounded reason strings are produced; driver messages
 * and object lists are never surfaced.
 */

export interface MigrationIdentity {
  user: string;
  database: string;
  schema: string;
}

export interface PreflightFailure {
  errorCode: 'database_identity_mismatch' | 'privilege_mismatch';
  reason: string;
}

export type PreflightOutcome =
  | { ok: true }
  | ({ ok: false } & PreflightFailure);

const IDENTITY_SQL = `
  SELECT current_user AS current_user,
         session_user AS session_user,
         current_database() AS current_database,
         r.rolsuper AS is_superuser,
         r.rolcreaterole AS can_create_role,
         r.rolcreatedb AS can_create_db,
         r.rolbypassrls AS bypass_rls,
         r.rolreplication AS can_replicate
    FROM pg_roles r
   WHERE r.rolname = current_user
`;

/** Instance-administration roles reserved by the platform. */
const PRIVILEGED_MEMBERSHIP_SQL = `
  SELECT r.rolname AS name
    FROM pg_roles r
   WHERE r.rolname IN ('rds_superuser', 'rdsadmin', 'rds_replication')
     AND pg_has_role(r.rolname, 'MEMBER')
`;

const SCHEMA_PRIVILEGE_SQL = `
  SELECT has_schema_privilege(current_user, $1, 'CREATE') AS can_create_schema,
         has_schema_privilege(current_user, $1, 'USAGE') AS can_use_schema,
         has_database_privilege(current_user, current_database(), 'CREATE')
           AS can_create_database_objects
`;

const CROSS_SCHEMA_SQL = `
  SELECT n.nspname AS name
    FROM pg_namespace n
   WHERE n.nspname <> $1
     AND n.nspname <> 'information_schema'
     AND n.nspname !~ '^pg_'
     AND has_schema_privilege(current_user, n.oid, 'CREATE')
`;

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : String(value);

const asBoolean = (value: unknown): boolean =>
  value === true || value === 't' || value === 'true';

const identityFailure = (reason: string): PreflightFailure => ({
  errorCode: 'database_identity_mismatch',
  reason,
});

const privilegeFailure = (reason: string): PreflightFailure => ({
  errorCode: 'privilege_mismatch',
  reason,
});

const checkIdentity = async (
  queryable: Queryable,
  identity: MigrationIdentity,
): Promise<PreflightFailure | null> => {
  const result = await queryable.query(IDENTITY_SQL);
  const row = result.rows[0];

  if (!row) {
    return identityFailure('the connected role is not visible in pg_roles');
  }

  if (asString(row.current_user) !== identity.user) {
    return identityFailure('connected role is not the expected migrator');
  }

  if (asString(row.session_user) !== asString(row.current_user)) {
    return identityFailure('the session is running under a switched role');
  }

  if (asString(row.current_database) !== identity.database) {
    return identityFailure('connected database is not the expected database');
  }

  for (const [key, reason] of [
    ['is_superuser', 'the migrator must not be a superuser'],
    ['can_create_role', 'the migrator must not create roles'],
    ['can_create_db', 'the migrator must not create databases'],
    ['bypass_rls', 'the migrator must not bypass row level security'],
    ['can_replicate', 'the migrator must not be a replication role'],
  ] as const) {
    if (asBoolean(row[key])) {
      return identityFailure(reason);
    }
  }

  return null;
};

const checkMemberships = async (
  queryable: Queryable,
): Promise<PreflightFailure | null> => {
  const result = await queryable.query(PRIVILEGED_MEMBERSHIP_SQL);

  return result.rows.length > 0
    ? identityFailure('the migrator belongs to an administration role')
    : null;
};

const checkSchemaPrivileges = async (
  queryable: Queryable,
  identity: MigrationIdentity,
): Promise<PreflightFailure | null> => {
  const result = await queryable.query(SCHEMA_PRIVILEGE_SQL, [identity.schema]);
  const row = result.rows[0];

  if (!row) {
    return privilegeFailure('schema privileges could not be read');
  }

  if (!asBoolean(row.can_create_schema)) {
    return privilegeFailure('the migrator cannot create objects in the schema');
  }

  if (!asBoolean(row.can_use_schema)) {
    return privilegeFailure('the migrator cannot access the schema');
  }

  if (asBoolean(row.can_create_database_objects)) {
    return privilegeFailure(
      'the migrator can create schemas, which the contract forbids',
    );
  }

  return null;
};

const checkCrossSchemaGrants = async (
  queryable: Queryable,
  identity: MigrationIdentity,
): Promise<PreflightFailure | null> => {
  const result = await queryable.query(CROSS_SCHEMA_SQL, [identity.schema]);

  return result.rows.length > 0
    ? privilegeFailure('the migrator holds create privileges on another schema')
    : null;
};

export const verifyMigrationIdentity = async (
  queryable: Queryable,
  identity: MigrationIdentity,
): Promise<PreflightOutcome> => {
  const failure =
    (await checkIdentity(queryable, identity)) ??
    (await checkMemberships(queryable)) ??
    (await checkSchemaPrivileges(queryable, identity)) ??
    (await checkCrossSchemaGrants(queryable, identity));

  return failure ? { ok: false, ...failure } : { ok: true };
};
