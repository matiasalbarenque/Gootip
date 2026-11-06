"""Idempotent reconciliation of roles, schema, ownership, grants, and defaults.

Every statement is explicit and named by the task it performs. Repeated runs
converge on the same state and never destroy data. These functions only execute
statements; the caller owns the transaction and the advisory lock.
"""

from __future__ import annotations

from psycopg import Connection, sql

from . import inventory
from .config import Config
from .credentials import Credentials
from .errors import DatabaseError

# PostgreSQL lets a CREATEROLE login without SUPERUSER create a role with the
# restricted attributes set, but refuses to *mention* SUPERUSER, CREATEDB,
# REPLICATION, or BYPASSRLS in an ALTER unless the executing login holds that
# attribute itself. The RDS master login is not a superuser, so creation carries
# the full contract and the ALTER only reasserts what it is permitted to, while
# `_verify_role_is_unprivileged` proves the rest held.
_CREATE_ROLE = sql.SQL(
    "CREATE ROLE {} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
    "NOREPLICATION NOBYPASSRLS PASSWORD {}"
)
_ALTER_ROLE = sql.SQL("ALTER ROLE {} WITH LOGIN NOCREATEROLE PASSWORD {}")

# The migration history is application-visible for reads but must never be
# writable by the developer operator, so after the broad per-schema grant
# reconciliation reduces that one table back to SELECT only.
_HISTORY_TABLE = "gootip_schema_migrations"
_CORE_HISTORY_TABLE = "typeorm_migrations"
_CREATE_CORE_HISTORY = sql.SQL(
    "CREATE TABLE {}.{} (id SERIAL NOT NULL PRIMARY KEY, "
    "timestamp bigint NOT NULL, name character varying NOT NULL)"
)
_REVOKE_HISTORY_WRITES = sql.SQL(
    "REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE {} FROM {}"
)
_GRANT_HISTORY_SELECT = sql.SQL("GRANT SELECT ON TABLE {} TO {}")


def bootstrap(
    connection: Connection, config: Config, credentials: dict[str, Credentials]
) -> dict[str, int]:
    """Reconcile the administrative contract and return non-sensitive counts.

    Idempotent: existing roles and schema are reused. Login state and every
    ownership, membership, grant, and default privilege is reasserted, while the
    restricted role attributes are verified because a non-superuser
    administrator cannot negate them.
    """
    core_inventory = inventory.inspect_core(connection, config)
    inventory.verify_core_role_isolation(connection, config)
    for role in (config.core_runtime_role, config.core_migrator_role):
        if inventory.privileged_attributes(connection, role):
            raise DatabaseError(f"role {role} holds restricted attributes")
    memberships = inventory.unexpected_core_memberships(connection, config)
    if memberships:
        raise DatabaseError("Core role memberships require explicit review")

    counts = {"roles_created": 0, "schema_created": 0}

    # PostgreSQL cannot safely reconcile an operator that is already a member
    # of the administrative login. Check before ALTER ROLE: that membership can
    # remove the bootstrap login's authority over the operator itself.
    if inventory.role_exists(connection, config.operator_role):
        _verify_operator_administrative_membership(connection, config)

    # Roles must exist before they can be granted or own the schema.
    for role in (
        config.migrator_role,
        config.runtime_role,
        config.operator_role,
        config.core_migrator_role,
        config.core_runtime_role,
    ):
        counts["roles_created"] += int(_ensure_role(connection, role, credentials[role].password))

    # The bootstrap login manages the migrator's objects and default privileges,
    # which PostgreSQL permits only for a member of the owning role.
    _grant_role(connection, config.migrator_role, inventory.current_user(connection))
    _grant_role(connection, config.core_migrator_role, inventory.current_user(connection))

    counts["schema_created"] += int(
        _ensure_schema(connection, config.auth_schema, config.migrator_role)
    )
    counts["schema_created"] += int(
        _ensure_schema(connection, config.core_schema, config.core_migrator_role)
    )

    if not core_inventory.history_exists:
        connection.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(config.core_migrator_role)))
        connection.execute(
            _CREATE_CORE_HISTORY.format(
                sql.Identifier(config.core_schema), sql.Identifier(_CORE_HISTORY_TABLE)
            )
        )
        connection.execute("RESET ROLE")

    # Remove anything that would let one role act as the other, then reset the
    # permissive default grants that would defeat schema isolation.
    _revoke_role(connection, config.runtime_role, config.migrator_role)
    _revoke_public_privileges(connection, config.db_name)
    _grant_connect(
        connection,
        config.db_name,
        config.runtime_role,
        config.migrator_role,
        config.operator_role,
        config.core_runtime_role,
        config.core_migrator_role,
    )

    _grant_runtime_privileges(connection, config.auth_schema, config.runtime_role)
    if inventory.table_exists(connection, config.auth_schema, _HISTORY_TABLE):
        # Broad DML above must not reopen writes to migration bookkeeping.
        connection.execute(
            _REVOKE_HISTORY_WRITES.format(
                sql.Identifier(config.auth_schema, _HISTORY_TABLE),
                sql.Identifier(config.runtime_role),
            )
        )
    _set_default_privileges(
        connection, config.auth_schema, config.migrator_role, config.runtime_role
    )

    _grant_runtime_privileges(connection, config.core_schema, config.core_runtime_role)
    _set_default_privileges(
        connection, config.core_schema, config.core_migrator_role, config.core_runtime_role
    )
    _revoke_core_history_privileges(connection, config, config.core_runtime_role)

    _reconcile_operator(connection, config)

    return counts


def _ensure_role(connection: Connection, role: str, password: str) -> bool:
    """Create the role if missing, then enforce attributes and password."""
    created = not inventory.role_exists(connection, role)
    if created:
        connection.execute(_CREATE_ROLE.format(sql.Identifier(role), sql.Literal(password)))
    connection.execute(_ALTER_ROLE.format(sql.Identifier(role), sql.Literal(password)))
    _verify_role_is_unprivileged(connection, role)
    return created


def _verify_role_is_unprivileged(connection: Connection, role: str) -> None:
    """Fail loudly if a role holds an attribute the contract forbids.

    A non-superuser administrator cannot revoke these, so drift is detected
    instead of silently tolerated.
    """
    attributes = inventory.privileged_attributes(connection, role)
    if attributes:
        raise DatabaseError(f"role {role} holds restricted attributes: {', '.join(attributes)}")


def _verify_operator_administrative_membership(connection: Connection, config: Config) -> None:
    """Fail before mutation if the operator can act as the bootstrap login."""
    administrative_role = inventory.current_user(connection)
    if inventory.is_member(connection, config.operator_role, administrative_role):
        raise DatabaseError(
            f"operator role {config.operator_role} must not be a member of {administrative_role}"
        )


def _ensure_schema(connection: Connection, schema: str, owner: str) -> bool:
    """Create the schema if missing and enforce its owner."""
    created = inventory.schema_owner(connection, schema) is None
    if created:
        connection.execute(
            sql.SQL("CREATE SCHEMA IF NOT EXISTS {} AUTHORIZATION {}").format(
                sql.Identifier(schema), sql.Identifier(owner)
            )
        )
    connection.execute(
        sql.SQL("ALTER SCHEMA {} OWNER TO {}").format(sql.Identifier(schema), sql.Identifier(owner))
    )
    return created


def _grant_role(connection: Connection, role: str, member: str) -> None:
    connection.execute(
        sql.SQL("GRANT {} TO {}").format(sql.Identifier(role), sql.Identifier(member))
    )


def _revoke_role(connection: Connection, member: str, role: str) -> None:
    connection.execute(
        sql.SQL("REVOKE {} FROM {}").format(sql.Identifier(role), sql.Identifier(member))
    )


def _revoke_public_privileges(connection: Connection, database: str) -> None:
    # PUBLIC keeps no ability to create schemas, create objects in public, or
    # hold temporary tables. Only the designated roles regain CONNECT.
    connection.execute(sql.SQL("REVOKE CREATE ON SCHEMA public FROM PUBLIC"))
    connection.execute(
        sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(database))
    )


def _grant_connect(connection: Connection, database: str, *roles: str) -> None:
    connection.execute(
        sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
            sql.Identifier(database),
            sql.SQL(", ").join(sql.Identifier(role) for role in roles),
        )
    )


def _grant_runtime_privileges(connection: Connection, schema: str, runtime: str) -> None:
    """Grant the runtime role usage and DML on existing application objects."""
    for statement in (
        sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(
            sql.Identifier(schema), sql.Identifier(runtime)
        ),
        sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {} TO {}").format(
            sql.Identifier(schema), sql.Identifier(runtime)
        ),
        sql.SQL("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {} TO {}").format(
            sql.Identifier(schema), sql.Identifier(runtime)
        ),
    ):
        connection.execute(statement)


def _set_default_privileges(
    connection: Connection, schema: str, migrator: str, runtime: str
) -> None:
    """Grant runtime privileges on future objects created by the migrator."""
    for statement in (
        sql.SQL(
            "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA {} "
            "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}"
        ).format(sql.Identifier(migrator), sql.Identifier(schema), sql.Identifier(runtime)),
        sql.SQL(
            "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA {} "
            "GRANT USAGE, SELECT ON SEQUENCES TO {}"
        ).format(sql.Identifier(migrator), sql.Identifier(schema), sql.Identifier(runtime)),
    ):
        connection.execute(statement)


def _reconcile_operator(connection: Connection, config: Config) -> None:
    """Reconcile the developer operator's memberships and schema grants.

    The operator must not be able to act as any other role. The two application
    roles can be revoked by the master login, so that cleanup is unconditional;
    any membership that remains, including the administrative login itself,
    fails instead of granting more access.

    DML and the default privileges that extend it to future objects are withheld
    until the migration-history table exists, because only then can that one
    table be reduced back to SELECT only.
    """
    operator = config.operator_role
    for role in (config.migrator_role, config.runtime_role):
        _revoke_role(connection, operator, role)
    for role in (config.migrator_role, config.runtime_role):
        if inventory.is_member(connection, operator, role):
            raise DatabaseError(f"operator role {operator} must not be a member of {role}")

    _verify_operator_administrative_membership(connection, config)

    for schema in config.application_schemas:
        connection.execute(
            sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(
                sql.Identifier(schema), sql.Identifier(operator)
            )
        )
        history_table = _CORE_HISTORY_TABLE if schema == config.core_schema else _HISTORY_TABLE
        migrator = (
            config.core_migrator_role if schema == config.core_schema else config.migrator_role
        )
        if not inventory.table_exists(connection, schema, history_table):
            continue
        _grant_operator_privileges(connection, schema, operator)
        _set_default_privileges(connection, schema, migrator, operator)
        if schema == config.core_schema:
            _restrict_core_history_operator(connection, config)
        else:
            _restrict_history_table(connection, schema, operator)


def _revoke_core_history_privileges(connection: Connection, config: Config, role: str) -> None:
    table = sql.Identifier(config.core_schema, _CORE_HISTORY_TABLE)
    connection.execute(
        sql.SQL("REVOKE ALL PRIVILEGES ON TABLE {} FROM {}").format(table, sql.Identifier(role))
    )
    connection.execute(
        sql.SQL("REVOKE ALL PRIVILEGES ON SEQUENCE {}.{} FROM {}").format(
            sql.Identifier(config.core_schema),
            sql.Identifier("typeorm_migrations_id_seq"),
            sql.Identifier(role),
        )
    )


def _restrict_core_history_operator(connection: Connection, config: Config) -> None:
    table = sql.Identifier(config.core_schema, _CORE_HISTORY_TABLE)
    sequence = sql.Identifier(config.core_schema, "typeorm_migrations_id_seq")
    connection.execute(
        sql.SQL("REVOKE ALL PRIVILEGES ON TABLE {} FROM {}").format(
            table, sql.Identifier(config.operator_role)
        )
    )
    connection.execute(
        sql.SQL("GRANT SELECT ON TABLE {} TO {}").format(
            table, sql.Identifier(config.operator_role)
        )
    )
    connection.execute(
        sql.SQL("REVOKE ALL PRIVILEGES ON SEQUENCE {} FROM {}").format(
            sequence, sql.Identifier(config.operator_role)
        )
    )


def _grant_operator_privileges(connection: Connection, schema: str, operator: str) -> None:
    """Grant the operator DML on the existing application objects in a schema."""
    for statement in (
        sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {} TO {}").format(
            sql.Identifier(schema), sql.Identifier(operator)
        ),
        sql.SQL("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {} TO {}").format(
            sql.Identifier(schema), sql.Identifier(operator)
        ),
    ):
        connection.execute(statement)


def _restrict_history_table(connection: Connection, schema: str, operator: str) -> None:
    """Reduce the migration history to read-only for the operator."""
    table = sql.Identifier(schema, _HISTORY_TABLE)
    connection.execute(_REVOKE_HISTORY_WRITES.format(table, sql.Identifier(operator)))
    connection.execute(_GRANT_HISTORY_SELECT.format(table, sql.Identifier(operator)))
