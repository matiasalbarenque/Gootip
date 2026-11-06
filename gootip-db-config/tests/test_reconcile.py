"""Reconciliation orchestration and SQL composition (no live database)."""

import pytest

from gootip_db_config import reconcile
from gootip_db_config.credentials import Credentials
from gootip_db_config.errors import DatabaseError
from gootip_db_config.inventory import CoreInventory


class RecordingConnection:
    """Captures the SQL text of every statement executed against it."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def execute(self, statement):
        self.statements.append(
            statement.as_string() if hasattr(statement, "as_string") else statement
        )


def _stub_inventory(
    monkeypatch, *, roles_exist: bool, schema_exists: bool, history_exists: bool = True
) -> None:
    monkeypatch.setattr(reconcile.inventory, "role_exists", lambda connection, role: roles_exist)
    monkeypatch.setattr(
        reconcile.inventory,
        "schema_owner",
        lambda connection, schema: "auth_migrator" if schema_exists else None,
    )
    monkeypatch.setattr(reconcile.inventory, "current_user", lambda connection: "gootip_auth")
    monkeypatch.setattr(reconcile.inventory, "privileged_attributes", lambda connection, role: ())
    monkeypatch.setattr(
        reconcile.inventory,
        "inspect_core",
        lambda connection, config: CoreInventory(
            config.core_migrator_role if schema_exists else None,
            (),
            (),
            None,
            history_exists and schema_exists,
        ),
    )
    monkeypatch.setattr(reconcile.inventory, "unexpected_core_memberships", lambda *args: ())
    monkeypatch.setattr(reconcile.inventory, "verify_core_role_isolation", lambda *args: None)
    monkeypatch.setattr(
        reconcile.inventory,
        "table_exists",
        lambda connection, schema, table: (
            (schema == "core" and table == "typeorm_migrations") or history_exists
        ),
    )
    monkeypatch.setattr(reconcile.inventory, "is_member", lambda connection, member, group: False)


def test_fresh_bootstrap_creates_roles_and_schema(monkeypatch, config, role_credentials):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=False, schema_exists=False)

    counts = reconcile.bootstrap(connection, config, role_credentials)

    assert counts == {"roles_created": 5, "schema_created": 2}
    text = "\n".join(connection.statements)
    # Creation carries the full attributes, including the ones a non-superuser
    # administrator may not mention in an ALTER.
    assert (
        'CREATE ROLE "auth_migrator" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE '
        "NOREPLICATION NOBYPASSRLS PASSWORD" in text
    )
    assert (
        'CREATE ROLE "auth_runtime" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE '
        "NOREPLICATION NOBYPASSRLS PASSWORD" in text
    )
    assert (
        'CREATE ROLE "gootip_dev_operator" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE '
        "NOREPLICATION NOBYPASSRLS PASSWORD" in text
    )
    assert 'CREATE SCHEMA IF NOT EXISTS "auth" AUTHORIZATION "auth_migrator"' in text
    assert 'CREATE SCHEMA IF NOT EXISTS "core" AUTHORIZATION "core_migrator"' in text
    assert 'CREATE TABLE "core"."typeorm_migrations" (id SERIAL NOT NULL PRIMARY KEY, ' in text
    assert 'ALTER SCHEMA "auth" OWNER TO "auth_migrator"' in text
    assert 'REVOKE "auth_migrator" FROM "auth_runtime"' in text
    assert "REVOKE CREATE ON SCHEMA public FROM PUBLIC" in text
    assert 'REVOKE ALL ON DATABASE "gootip" FROM PUBLIC' in text
    assert (
        'GRANT CONNECT ON DATABASE "gootip" TO "auth_runtime", "auth_migrator", '
        '"gootip_dev_operator"' in text
    )
    assert 'GRANT USAGE ON SCHEMA "auth" TO "auth_runtime"' in text
    assert (
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "auth" TO "auth_runtime"'
        in text
    )
    assert 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "auth" TO "auth_runtime"' in text
    assert (
        'ALTER DEFAULT PRIVILEGES FOR ROLE "auth_migrator" IN SCHEMA "auth" '
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "auth_runtime"' in text
    )
    assert (
        'ALTER DEFAULT PRIVILEGES FOR ROLE "auth_migrator" IN SCHEMA "auth" '
        'GRANT USAGE, SELECT ON SEQUENCES TO "auth_runtime"' in text
    )


def test_operator_privileges_follow_the_declared_schema_allowlist(
    monkeypatch, config, role_credentials
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)

    reconcile.bootstrap(connection, config, role_credentials)

    text = "\n".join(connection.statements)
    assert config.application_schemas == ("auth", "core")
    assert 'GRANT USAGE ON SCHEMA "auth" TO "gootip_dev_operator"' in text
    assert 'GRANT USAGE ON SCHEMA "core" TO "gootip_dev_operator"' in text
    assert (
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "auth" '
        'TO "gootip_dev_operator"' in text
    )
    assert 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "auth" TO "gootip_dev_operator"' in text
    assert (
        'ALTER DEFAULT PRIVILEGES FOR ROLE "auth_migrator" IN SCHEMA "auth" '
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "gootip_dev_operator"' in text
    )
    assert (
        'ALTER DEFAULT PRIVILEGES FOR ROLE "auth_migrator" IN SCHEMA "auth" '
        'GRANT USAGE, SELECT ON SEQUENCES TO "gootip_dev_operator"' in text
    )
    # No undeclared schema may be granted automatically.
    assert '"public" TO "gootip_dev_operator"' not in text


def test_migration_history_is_restricted_to_select_after_broad_grants(
    monkeypatch, config, role_credentials
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)

    reconcile.bootstrap(connection, config, role_credentials)

    statements = connection.statements
    broad_grant = statements.index(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "auth" '
        'TO "gootip_dev_operator"'
    )
    revoke = statements.index(
        "REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "
        '"auth"."gootip_schema_migrations" FROM "gootip_dev_operator"'
    )
    grant = statements.index(
        'GRANT SELECT ON TABLE "auth"."gootip_schema_migrations" TO "gootip_dev_operator"'
    )
    assert broad_grant < revoke < grant


def test_core_history_is_prepared_before_broad_grants_and_restricted_afterward(
    monkeypatch, config, role_credentials
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=False, schema_exists=False)

    reconcile.bootstrap(connection, config, role_credentials)

    statements = connection.statements
    prepare = next(
        index
        for index, statement in enumerate(statements)
        if statement.startswith('CREATE TABLE "core"')
    )
    runtime_grant = statements.index(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "core" TO "core_runtime"'
    )
    operator_grant = statements.index(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "core" '
        'TO "gootip_dev_operator"'
    )
    runtime_history_revoke = statements.index(
        'REVOKE ALL PRIVILEGES ON TABLE "core"."typeorm_migrations" FROM "core_runtime"'
    )
    operator_history_revoke = statements.index(
        'REVOKE ALL PRIVILEGES ON TABLE "core"."typeorm_migrations" FROM "gootip_dev_operator"'
    )
    operator_history_select = statements.index(
        'GRANT SELECT ON TABLE "core"."typeorm_migrations" TO "gootip_dev_operator"'
    )
    sequence_revoke = statements.index(
        'REVOKE ALL PRIVILEGES ON SEQUENCE "core"."typeorm_migrations_id_seq" '
        'FROM "gootip_dev_operator"'
    )
    assert prepare < runtime_grant < runtime_history_revoke
    assert prepare < operator_grant < operator_history_revoke < operator_history_select
    assert sequence_revoke > operator_grant


def test_unexpected_core_membership_stops_before_reconciliation(
    monkeypatch, config, role_credentials
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)
    monkeypatch.setattr(
        reconcile.inventory,
        "unexpected_core_memberships",
        lambda *args: ((config.core_runtime_role, config.core_migrator_role),),
    )

    with pytest.raises(DatabaseError, match="Core role memberships"):
        reconcile.bootstrap(connection, config, role_credentials)

    assert connection.statements == []


def test_runtime_migration_history_writes_are_revoked_after_broad_grants(
    monkeypatch, config, role_credentials
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)

    reconcile.bootstrap(connection, config, role_credentials)

    statements = connection.statements
    broad_grant = statements.index(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "auth" TO "auth_runtime"'
    )
    runtime_revoke = statements.index(
        "REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "
        '"auth"."gootip_schema_migrations" FROM "auth_runtime"'
    )
    assert broad_grant < runtime_revoke


def test_runtime_history_revoke_is_skipped_when_history_is_absent(
    monkeypatch, config, role_credentials
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True, history_exists=False)

    reconcile.bootstrap(connection, config, role_credentials)

    assert not any(
        '"auth"."gootip_schema_migrations" FROM "auth_runtime"' in statement
        for statement in connection.statements
    )


def test_absent_migration_history_defers_operator_dml_and_defaults(
    monkeypatch, config, role_credentials
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True, history_exists=False)

    reconcile.bootstrap(connection, config, role_credentials)

    text = "\n".join(connection.statements)
    # Connection and schema usage are safe, but every table/sequence grant and
    # default privilege is withheld until the history table can be reduced.
    assert 'GRANT USAGE ON SCHEMA "auth" TO "gootip_dev_operator"' in text
    assert (
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "auth" '
        'TO "gootip_dev_operator"' not in text
    )
    assert (
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "auth" TO "gootip_dev_operator"' not in text
    )
    assert (
        'ALTER DEFAULT PRIVILEGES FOR ROLE "auth_migrator" IN SCHEMA "auth" '
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "gootip_dev_operator"' not in text
    )
    assert (
        'ALTER DEFAULT PRIVILEGES FOR ROLE "auth_migrator" IN SCHEMA "auth" '
        'GRANT USAGE, SELECT ON SEQUENCES TO "gootip_dev_operator"' not in text
    )
    assert "gootip_schema_migrations" not in text


def test_operator_privileged_role_memberships_are_revoked(monkeypatch, config, role_credentials):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)

    reconcile.bootstrap(connection, config, role_credentials)

    text = "\n".join(connection.statements)
    assert 'REVOKE "auth_migrator" FROM "gootip_dev_operator"' in text
    assert 'REVOKE "auth_runtime" FROM "gootip_dev_operator"' in text
    # The administrative role cannot be revoked from inside the bootstrap; a
    # preexisting membership is detected and fails the reconciliation instead.
    assert 'REVOKE "gootip_auth" FROM "gootip_dev_operator"' not in text


@pytest.mark.parametrize("privileged_role", ["migrator", "runtime", "administrative"])
def test_operator_privileged_membership_fails_the_bootstrap(
    monkeypatch, config, role_credentials, privileged_role
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)
    group = {
        "migrator": config.migrator_role,
        "runtime": config.runtime_role,
        "administrative": "gootip_auth",
    }[privileged_role]
    monkeypatch.setattr(
        reconcile.inventory,
        "is_member",
        lambda connection, member, role: role == group,
    )

    with pytest.raises(DatabaseError) as raised:
        reconcile.bootstrap(connection, config, role_credentials)

    assert raised.value.code == "database_error"
    assert config.operator_role in str(raised.value)
    assert group in str(raised.value)


def test_repeat_bootstrap_creates_nothing(monkeypatch, config, role_credentials):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)

    counts = reconcile.bootstrap(connection, config, role_credentials)

    assert counts == {"roles_created": 0, "schema_created": 0}
    text = "\n".join(connection.statements)
    assert "CREATE ROLE" not in text
    assert "CREATE SCHEMA" not in text
    # Login state and grants are still reasserted so drift cannot persist.
    assert 'ALTER ROLE "auth_runtime" WITH LOGIN NOCREATEROLE PASSWORD' in text
    assert 'ALTER ROLE "core_runtime" WITH LOGIN NOCREATEROLE PASSWORD' in text


def test_migrator_membership_is_granted_before_schema_ownership(
    monkeypatch, config, role_credentials
):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)

    reconcile.bootstrap(connection, config, role_credentials)

    order = {statement: index for index, statement in enumerate(connection.statements)}
    assert (
        order['GRANT "auth_migrator" TO "gootip_auth"']
        < order['ALTER SCHEMA "auth" OWNER TO "auth_migrator"']
    )


def test_runtime_password_is_escaped_as_a_literal(monkeypatch, config):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)
    credentials = {
        config.runtime_role: Credentials(config.runtime_role, "p'; DROP ROLE x; --"),
        config.migrator_role: Credentials(config.migrator_role, "migrator-password"),
        config.operator_role: Credentials(config.operator_role, "operator-password"),
        config.core_runtime_role: Credentials(config.core_runtime_role, "core-runtime-password"),
        config.core_migrator_role: Credentials(config.core_migrator_role, "core-migrator-password"),
    }

    reconcile.bootstrap(connection, config, credentials)

    alter_runtime = next(
        statement
        for statement in connection.statements
        if statement.startswith('ALTER ROLE "auth_runtime"')
    )
    assert alter_runtime.endswith("PASSWORD 'p''; DROP ROLE x; --'")


def test_restricted_role_attribute_fails_the_bootstrap(monkeypatch, config, role_credentials):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)
    monkeypatch.setattr(
        reconcile.inventory,
        "privileged_attributes",
        lambda connection, role: ("createdb",) if role == config.runtime_role else (),
    )

    with pytest.raises(DatabaseError) as raised:
        reconcile.bootstrap(connection, config, role_credentials)

    assert raised.value.code == "database_error"
    assert config.runtime_role in str(raised.value)


def test_operator_restricted_attribute_fails_the_bootstrap(monkeypatch, config, role_credentials):
    connection = RecordingConnection()
    _stub_inventory(monkeypatch, roles_exist=True, schema_exists=True)
    monkeypatch.setattr(
        reconcile.inventory,
        "privileged_attributes",
        lambda connection, role: ("createrole",) if role == config.operator_role else (),
    )

    with pytest.raises(DatabaseError) as raised:
        reconcile.bootstrap(connection, config, role_credentials)

    assert raised.value.code == "database_error"
    assert config.operator_role in str(raised.value)
