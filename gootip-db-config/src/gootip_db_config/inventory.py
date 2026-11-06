"""Read-only inspection of PostgreSQL roles, schemas, memberships, and grants.

Reconciliation uses these queries to decide what to create and to report
non-sensitive counts. Effective-privilege helpers read PostgreSQL's own
``has_*_privilege`` functions so negative tests can prove isolation.
"""

from __future__ import annotations

from dataclasses import dataclass

from psycopg import Connection, sql

from .config import CORE_MIGRATION_EXPECTATIONS, Config
from .errors import DatabaseError

_CURRENT_USER = "SELECT current_user"
_ROLE_EXISTS = "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s)"
_SCHEMA_OWNER = "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = %s"
_TABLE_EXISTS = "SELECT to_regclass(%s) IS NOT NULL"
_IS_MEMBER = "SELECT pg_has_role(%s, %s, 'MEMBER')"
_ROLE_PRIVILEGED_ATTRIBUTES = (
    "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls "
    "FROM pg_roles WHERE rolname = %s"
)
_PRIVILEGED_ATTRIBUTE_NAMES = ("superuser", "createdb", "createrole", "replication", "bypassrls")

_HAS_SCHEMA_PRIVILEGE = "SELECT has_schema_privilege(%s, %s, %s)"
_HAS_DATABASE_PRIVILEGE = "SELECT has_database_privilege(%s, %s, %s)"
_HAS_TABLE_PRIVILEGE = "SELECT has_table_privilege(%s, %s, %s)"
_HAS_SEQUENCE_PRIVILEGE = "SELECT has_sequence_privilege(%s, %s, %s)"
_SCHEMA_RELATIONS = """
SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner)
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = %s AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
ORDER BY c.relname
"""
_HISTORY_COLUMNS = """
SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
       pg_get_expr(d.adbin, d.adrelid)
FROM pg_attribute AS a
JOIN pg_class AS c ON c.oid = a.attrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef AS d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = %s AND c.relname = %s AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum
"""
_HISTORY_PRIMARY_KEY = """
SELECT EXISTS (
  SELECT 1 FROM pg_constraint AS con
  JOIN pg_class AS c ON c.oid = con.conrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = %s AND c.relname = %s AND con.contype = 'p'
    AND ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = k.attnum
              ORDER BY k.ord) = ARRAY['id']::name[]
)
"""
_HISTORY_OWNER = """
SELECT pg_get_userbyid(c.relowner), pg_get_serial_sequence(%s, 'id')
FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = %s AND c.relname = %s
"""
_CORE_MEMBERSHIPS = """
SELECT member.rolname, granted.rolname
FROM pg_auth_members AS m
JOIN pg_roles AS member ON member.oid = m.member
JOIN pg_roles AS granted ON granted.oid = m.roleid
WHERE member.rolname IN (%s, %s) OR granted.rolname IN (%s, %s)
"""
_CORE_UNEXPECTED_GRANTEES = """
SELECT c.relname, COALESCE(grantee.rolname, 'PUBLIC')
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(
  COALESCE(
    c.relacl,
    acldefault(CASE WHEN c.relkind = 'S' THEN 'S' ELSE 'r' END::"char", c.relowner)
  )
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE n.nspname = %s
  AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
  AND COALESCE(grantee.rolname, 'PUBLIC') NOT IN (%s, %s, %s, %s)
"""
_CORE_DEFAULT_ACL = """
SELECT pg_get_userbyid(d.defaclrole), d.defaclnamespace, COALESCE(grantee.rolname, 'PUBLIC')
FROM pg_default_acl AS d
CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE d.defaclnamespace IN (0, (SELECT oid FROM pg_namespace WHERE nspname = %s))
  AND (d.defaclnamespace = 0 OR pg_get_userbyid(d.defaclrole) <> %s
       OR COALESCE(grantee.rolname, 'PUBLIC') NOT IN (%s, %s, %s))
"""
_CORE_SCHEMA_UNEXPECTED_GRANTEES = """
SELECT COALESCE(grantee.rolname, 'PUBLIC')
FROM pg_namespace AS n
CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n'::"char", n.nspowner))) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE n.nspname = %s
  AND COALESCE(grantee.rolname, 'PUBLIC') NOT IN (%s, %s, %s, %s)
"""


@dataclass(frozen=True)
class CoreInventory:
    schema_owner: str | None
    relations: tuple[tuple[str, str, str], ...]
    history_rows: tuple[tuple[int, int, str], ...]
    history_sequence: str | None
    history_exists: bool


def inspect_core(connection: Connection, config: Config) -> CoreInventory:
    """Read Core objects/history and reject state outside the registered contract."""
    owner = schema_owner(connection, config.core_schema)
    if owner is None:
        return CoreInventory(None, (), (), None, False)
    if owner != config.core_migrator_role:
        raise DatabaseError("Core schema has an unexpected owner")

    relations = tuple(connection.execute(_SCHEMA_RELATIONS, (config.core_schema,)).fetchall())
    unexpected_grantees = connection.execute(
        _CORE_UNEXPECTED_GRANTEES,
        (
            config.core_schema,
            config.core_migrator_role,
            config.core_runtime_role,
            config.operator_role,
            current_user(connection),
        ),
    ).fetchall()
    unexpected_defaults = connection.execute(
        _CORE_DEFAULT_ACL,
        (
            config.core_schema,
            config.core_migrator_role,
            config.core_migrator_role,
            config.core_runtime_role,
            config.operator_role,
        ),
    ).fetchall()
    unexpected_schema_grantees = connection.execute(
        _CORE_SCHEMA_UNEXPECTED_GRANTEES,
        (
            config.core_schema,
            config.core_migrator_role,
            config.core_runtime_role,
            config.operator_role,
            current_user(connection),
        ),
    ).fetchall()
    if unexpected_grantees or unexpected_defaults or unexpected_schema_grantees:
        raise DatabaseError("Core contains unexpected direct or default privileges")
    by_name = {name: (kind, relation_owner) for name, kind, relation_owner in relations}
    if "typeorm_migrations" not in by_name:
        if relations:
            raise DatabaseError("Core objects exist without TypeORM migration history")
        return CoreInventory(owner, relations, (), None, False)

    history_kind, history_owner = by_name["typeorm_migrations"]
    if history_kind not in ("r", "p") or history_owner != config.core_migrator_role:
        raise DatabaseError("Core TypeORM history has an unexpected owner or relation type")
    expected_columns = (
        ("id", "integer", True),
        ("timestamp", "bigint", True),
        ("name", "character varying", True),
    )
    columns = connection.execute(
        _HISTORY_COLUMNS, (config.core_schema, "typeorm_migrations")
    ).fetchall()
    if (
        tuple((name, column_type, not_null) for name, column_type, not_null, _ in columns)
        != expected_columns
    ):
        raise DatabaseError("Core TypeORM history has an incompatible structure")
    if not connection.execute(
        _HISTORY_PRIMARY_KEY, (config.core_schema, "typeorm_migrations")
    ).fetchone()[0]:
        raise DatabaseError("Core TypeORM history is missing its id primary key")

    history_owner, sequence = connection.execute(
        _HISTORY_OWNER,
        (f"{config.core_schema}.typeorm_migrations", config.core_schema, "typeorm_migrations"),
    ).fetchone()
    if history_owner != config.core_migrator_role or sequence is None:
        raise DatabaseError("Core TypeORM history sequence is missing or has an unexpected owner")
    sequence_owner = connection.execute(
        "SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = %s::regclass",
        (sequence,),
    ).fetchone()
    if sequence_owner is None or sequence_owner[0] != config.core_migrator_role:
        raise DatabaseError("Core TypeORM history sequence has an unexpected owner")

    rows = tuple(
        connection.execute(
            sql.SQL("SELECT id, timestamp, name FROM {}.{} ORDER BY id").format(
                sql.Identifier(config.core_schema), sql.Identifier("typeorm_migrations")
            )
        ).fetchall()
    )
    known = tuple((name, timestamp) for name, timestamp, _ in CORE_MIGRATION_EXPECTATIONS)
    actual = tuple((name, timestamp) for _, timestamp, name in rows)
    if actual != known[: len(actual)] or len(actual) > len(known):
        raise DatabaseError("Core TypeORM history contains unknown migration records")
    expected_tables = {"typeorm_migrations"}
    expected_tables.add(sequence.rsplit(".", 1)[-1].strip('"'))
    if actual:
        expected_tables.update(CORE_MIGRATION_EXPECTATIONS[len(actual) - 1][2])
    if set(by_name) != expected_tables:
        raise DatabaseError("Core objects do not match the registered migration history")
    if any(relation_owner != config.core_migrator_role for _, _, relation_owner in relations):
        raise DatabaseError("Core contains an object with an unexpected owner")
    return CoreInventory(owner, relations, rows, sequence, True)


def unexpected_core_memberships(
    connection: Connection, config: Config
) -> tuple[tuple[str, str], ...]:
    """Return direct memberships involving Core roles, excluding admin ownership access."""
    rows = connection.execute(
        _CORE_MEMBERSHIPS,
        (
            config.core_runtime_role,
            config.core_migrator_role,
            config.core_runtime_role,
            config.core_migrator_role,
        ),
    ).fetchall()
    current = current_user(connection)
    return tuple((member, granted) for member, granted in rows if member != current)


def verify_core_role_isolation(connection: Connection, config: Config) -> None:
    """Fail before mutation if existing Core logins cross Auth/public or hold DDL."""
    for role in (config.core_runtime_role, config.core_migrator_role):
        if not role_exists(connection, role):
            continue
        if has_schema_privilege(connection, role, "public", "CREATE"):
            raise DatabaseError("Core role can create objects in public")
        if schema_owner(connection, config.auth_schema) is not None and has_schema_privilege(
            connection, role, config.auth_schema, "USAGE"
        ):
            raise DatabaseError("Core role has access to the Auth schema")
    for role in (config.core_runtime_role, config.operator_role):
        if not role_exists(connection, role):
            continue
        if schema_owner(connection, config.core_schema) is not None and has_schema_privilege(
            connection, role, config.core_schema, "CREATE"
        ):
            raise DatabaseError("Core runtime/operator has Core schema DDL privileges")


def current_user(connection: Connection) -> str:
    """Return the login name of the current session."""
    return connection.execute(_CURRENT_USER).fetchone()[0]


def role_exists(connection: Connection, role: str) -> bool:
    """Return whether a role with this name exists."""
    return bool(connection.execute(_ROLE_EXISTS, (role,)).fetchone()[0])


def schema_owner(connection: Connection, schema: str) -> str | None:
    """Return the schema owner, or ``None`` if the schema does not exist."""
    row = connection.execute(_SCHEMA_OWNER, (schema,)).fetchone()
    return row[0] if row else None


def table_exists(connection: Connection, schema: str, table: str) -> bool:
    """Return whether a table with this exact qualified name exists."""
    qualified = f'"{schema}"."{table}"'
    return bool(connection.execute(_TABLE_EXISTS, (qualified,)).fetchone()[0])


def privileged_attributes(connection: Connection, role: str) -> tuple[str, ...]:
    """Return the restricted attributes currently set on a role, if any.

    A non-superuser administrator cannot negate these attributes with
    ``ALTER ROLE``, so the bootstrap verifies them instead of relying on an
    alter that PostgreSQL would refuse.
    """
    row = connection.execute(_ROLE_PRIVILEGED_ATTRIBUTES, (role,)).fetchone()
    if row is None:
        return ()
    return tuple(
        name for name, enabled in zip(_PRIVILEGED_ATTRIBUTE_NAMES, row, strict=True) if enabled
    )


def is_member(connection: Connection, member: str, group: str) -> bool:
    """Return whether ``member`` is a member of ``group``."""
    return bool(connection.execute(_IS_MEMBER, (member, group)).fetchone()[0])


def has_schema_privilege(connection: Connection, role: str, schema: str, privilege: str) -> bool:
    """Return whether ``role`` holds ``privilege`` on ``schema``."""
    row = connection.execute(_HAS_SCHEMA_PRIVILEGE, (role, schema, privilege)).fetchone()
    return bool(row[0])


def has_database_privilege(
    connection: Connection, role: str, database: str, privilege: str
) -> bool:
    """Return whether ``role`` holds ``privilege`` on ``database``."""
    row = connection.execute(_HAS_DATABASE_PRIVILEGE, (role, database, privilege)).fetchone()
    return bool(row[0])


def has_table_privilege(connection: Connection, role: str, table: str, privilege: str) -> bool:
    """Return whether ``role`` holds ``privilege`` on the table ``table``."""
    row = connection.execute(_HAS_TABLE_PRIVILEGE, (role, table, privilege)).fetchone()
    return bool(row[0])


def has_sequence_privilege(
    connection: Connection, role: str, sequence: str, privilege: str
) -> bool:
    """Return whether ``role`` holds ``privilege`` on the sequence ``sequence``."""
    row = connection.execute(_HAS_SEQUENCE_PRIVILEGE, (role, sequence, privilege)).fetchone()
    return bool(row[0])
