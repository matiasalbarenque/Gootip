"""Effective PostgreSQL privileges, proven with positive and negative probes.

Each probe acts as one real role against the disposable database and asserts what
that role can and cannot do after the bootstrap has run. Positive probes commit;
negative probes must raise ``InsufficientPrivilege``.
"""

from __future__ import annotations

import psycopg
import pytest

from gootip_db_config.errors import DatabaseError

pytestmark = pytest.mark.integration


def test_roles_are_non_superuser_without_creation_rights(bootstrapped):
    with bootstrapped.session(bootstrapped.master_user) as connection:
        rows = connection.execute(
            "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls "
            "FROM pg_roles WHERE rolname IN (%s, %s, %s, %s, %s) ORDER BY rolname",
            (
                bootstrapped.migrator_role,
                bootstrapped.runtime_role,
                bootstrapped.operator_role,
                bootstrapped.config.core_migrator_role,
                bootstrapped.config.core_runtime_role,
            ),
        ).fetchall()

    assert rows == [
        (bootstrapped.config.core_migrator_role, False, False, False, False, False),
        (bootstrapped.config.core_runtime_role, False, False, False, False, False),
        (bootstrapped.migrator_role, False, False, False, False, False),
        (bootstrapped.operator_role, False, False, False, False, False),
        (bootstrapped.runtime_role, False, False, False, False, False),
    ]


def test_core_history_is_prepared_and_isolated_from_runtime_and_operator(bootstrapped):
    with bootstrapped.session(bootstrapped.master_user) as admin:
        assert admin.execute(
            "SELECT pg_get_userbyid(c.relowner), count(*) "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'core' AND c.relname = 'typeorm_migrations' "
            "GROUP BY c.relowner"
        ).fetchone() == (bootstrapped.config.core_migrator_role, 1)
        assert admin.execute("SELECT count(*) FROM core.typeorm_migrations").fetchone()[0] == 0
        assert (
            admin.execute(
                "SELECT has_table_privilege(%s, 'core.typeorm_migrations', 'SELECT')",
                (bootstrapped.config.core_runtime_role,),
            ).fetchone()[0]
            is False
        )
        assert (
            admin.execute(
                "SELECT has_table_privilege(%s, 'core.typeorm_migrations', 'SELECT')",
                (bootstrapped.operator_role,),
            ).fetchone()[0]
            is True
        )
        for role in (bootstrapped.config.core_runtime_role, bootstrapped.operator_role):
            assert (
                admin.execute(
                    "SELECT has_sequence_privilege(%s, 'core.typeorm_migrations_id_seq', 'USAGE')",
                    (role,),
                ).fetchone()[0]
                is False
            )

    with bootstrapped.session(bootstrapped.config.core_runtime_role) as runtime:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("SELECT * FROM core.typeorm_migrations")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute(
                "INSERT INTO core.typeorm_migrations (timestamp, name) VALUES (1, 'probe')"
            )

    with bootstrapped.session(bootstrapped.operator_role) as operator:
        assert operator.execute("SELECT count(*) FROM core.typeorm_migrations").fetchone()[0] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(
                "INSERT INTO core.typeorm_migrations (timestamp, name) VALUES (1, 'probe')"
            )


def test_core_runtime_and_operator_get_dml_on_future_migrator_objects(bootstrapped):
    table = "catalog_grant_probe"
    with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
        migrator.execute(
            f"CREATE TABLE core.{table} "
            "(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL)"
        )

    try:
        for role in (
            bootstrapped.config.core_runtime_role,
            bootstrapped.operator_role,
        ):
            with bootstrapped.session(role) as client:
                client.execute(f"INSERT INTO core.{table} (value) VALUES ('first')")
                client.execute(f"UPDATE core.{table} SET value = 'second' WHERE value = 'first'")
                assert client.execute(f"SELECT value FROM core.{table}").fetchall() == [("second",)]
                client.execute(f"DELETE FROM core.{table}")
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    client.execute(f"CREATE TABLE core.{role}_ddl_probe (id integer)")
    finally:
        with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
            migrator.execute(f"DROP TABLE IF EXISTS core.{table}")


def test_runtime_has_dml_on_future_migrator_objects(bootstrapped):
    # The table and its identity sequence are created after the bootstrap, so this
    # proves the default privileges, not the one-off grant on existing objects.
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute(
            "CREATE TABLE auth.runtime_dml_probe "
            "(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text)"
        )

    with bootstrapped.session(bootstrapped.runtime_role) as runtime:
        runtime.execute("INSERT INTO auth.runtime_dml_probe (label) VALUES ('first')")
        runtime.execute("UPDATE auth.runtime_dml_probe SET label = 'second' WHERE label = 'first'")
        assert runtime.execute("SELECT label FROM auth.runtime_dml_probe").fetchall() == [
            ("second",)
        ]
        runtime.execute("DELETE FROM auth.runtime_dml_probe WHERE label = 'second'")
        assert runtime.execute("SELECT count(*) FROM auth.runtime_dml_probe").fetchone()[0] == 0


def test_runtime_history_write_grant_is_reconciled_away(bootstrapped):
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute("DROP TABLE IF EXISTS auth.gootip_schema_migrations")
        migrator.execute(
            "CREATE TABLE auth.gootip_schema_migrations (id integer PRIMARY KEY, name text)"
        )

    with bootstrapped.session(bootstrapped.runtime_role) as runtime:
        assert runtime.execute(
            "SELECT has_table_privilege(current_user, %s, 'INSERT')",
            ("auth.gootip_schema_migrations",),
        ).fetchone()[0]

    bootstrapped.reconcile()

    with (
        bootstrapped.session(bootstrapped.runtime_role) as runtime,
        pytest.raises(psycopg.errors.InsufficientPrivilege),
    ):
        runtime.execute("INSERT INTO auth.gootip_schema_migrations (id, name) VALUES (1, 'probe')")

    with bootstrapped.session(bootstrapped.master_user) as master:
        for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
            assert not master.execute(
                "SELECT has_table_privilege(%s, %s, %s)",
                (bootstrapped.runtime_role, "auth.gootip_schema_migrations", privilege),
            ).fetchone()[0]


def test_operator_has_dml_on_existing_tables_and_sequences(bootstrapped):
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute("DROP TABLE IF EXISTS auth.operator_existing_probe")
        migrator.execute("DROP SEQUENCE IF EXISTS auth.operator_existing_sequence")
        migrator.execute("CREATE TABLE auth.operator_existing_probe (id integer, label text)")
        migrator.execute("CREATE SEQUENCE auth.operator_existing_sequence")

    bootstrapped.reconcile_with_history()

    with bootstrapped.session(bootstrapped.operator_role) as operator:
        operator.execute("INSERT INTO auth.operator_existing_probe (id, label) VALUES (1, 'a')")
        operator.execute("UPDATE auth.operator_existing_probe SET label = 'b' WHERE id = 1")
        assert operator.execute(
            "SELECT id, label FROM auth.operator_existing_probe"
        ).fetchall() == [(1, "b")]
        assert (
            operator.execute("SELECT nextval('auth.operator_existing_sequence')").fetchone()[0] == 1
        )
        operator.execute("DELETE FROM auth.operator_existing_probe WHERE id = 1")
        assert (
            operator.execute("SELECT count(*) FROM auth.operator_existing_probe").fetchone()[0] == 0
        )


def test_operator_has_dml_on_future_migrator_objects_and_sequences(bootstrapped):
    bootstrapped.reconcile_with_history()

    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute("DROP TABLE IF EXISTS auth.operator_future_probe")
        migrator.execute(
            "CREATE TABLE auth.operator_future_probe "
            "(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text)"
        )

    with bootstrapped.session(bootstrapped.operator_role) as operator:
        operator.execute("INSERT INTO auth.operator_future_probe (label) VALUES ('first')")
        operator.execute(
            "UPDATE auth.operator_future_probe SET label = 'second' WHERE label = 'first'"
        )
        assert operator.execute("SELECT label FROM auth.operator_future_probe").fetchall() == [
            ("second",)
        ]
        operator.execute("DELETE FROM auth.operator_future_probe WHERE label = 'second'")
        assert (
            operator.execute("SELECT count(*) FROM auth.operator_future_probe").fetchone()[0] == 0
        )


def test_operator_can_read_but_not_mutate_migration_history(bootstrapped):
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute("DROP TABLE IF EXISTS auth.gootip_schema_migrations")
        migrator.execute(
            "CREATE TABLE auth.gootip_schema_migrations "
            "(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL)"
        )
        migrator.execute("INSERT INTO auth.gootip_schema_migrations (name) VALUES ('0001_initial')")

    bootstrapped.reconcile()

    with bootstrapped.session(bootstrapped.operator_role) as operator:
        assert operator.execute("SELECT name FROM auth.gootip_schema_migrations").fetchall() == [
            ("0001_initial",)
        ]

        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(
                "INSERT INTO auth.gootip_schema_migrations (name) VALUES ('0002_evil')"
            )
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(
                "UPDATE auth.gootip_schema_migrations "
                "SET name = 'changed' WHERE name = '0001_initial'"
            )
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("DELETE FROM auth.gootip_schema_migrations")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("TRUNCATE auth.gootip_schema_migrations")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("ALTER TABLE auth.gootip_schema_migrations ADD COLUMN extra text")

    with bootstrapped.session(bootstrapped.master_user) as master:
        assert (
            master.execute(
                "SELECT has_table_privilege(%s, 'auth.gootip_schema_migrations', 'SELECT')",
                (bootstrapped.operator_role,),
            ).fetchone()[0]
            is True
        )
        for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
            assert (
                master.execute(
                    "SELECT has_table_privilege(%s, 'auth.gootip_schema_migrations', %s)",
                    (bootstrapped.operator_role, privilege),
                ).fetchone()[0]
                is False
            ), privilege


def test_runtime_ddl_is_denied(bootstrapped):
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute("CREATE TABLE auth.runtime_ddl_probe (id integer)")

    with bootstrapped.session(bootstrapped.runtime_role) as runtime:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("CREATE TABLE auth.evil (id integer)")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("ALTER TABLE auth.runtime_ddl_probe ADD COLUMN extra text")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("DROP TABLE auth.runtime_ddl_probe")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("CREATE SCHEMA elsewhere")


def test_absent_history_defers_operator_dml_without_a_future_write_window(bootstrapped):
    # Reconciliation runs before the migration history table exists. Operator DML
    # and default privileges must stay off, so a history table created later does
    # not receive INSERT/UPDATE/DELETE from a default privilege before the next
    # reconciliation can reduce it to SELECT.
    config = bootstrapped.fresh_database("gootip_test_db_config_operator_window")
    bootstrapped.reconcile(config)

    with bootstrapped.session(bootstrapped.migrator_role, config) as migrator:
        migrator.execute("CREATE TABLE auth.ordinary_before_history (id integer)")
        migrator.execute(
            "CREATE TABLE auth.gootip_schema_migrations (id integer, name text NOT NULL)"
        )
        migrator.execute("INSERT INTO auth.gootip_schema_migrations (id, name) VALUES (1, '0001')")

    with bootstrapped.session(bootstrapped.operator_role, config) as operator:
        # No default DML was installed: neither the ordinary table nor the newly
        # created history table is writable before the next reconciliation.
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("INSERT INTO auth.ordinary_before_history (id) VALUES (1)")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(
                "INSERT INTO auth.gootip_schema_migrations (id, name) VALUES (2, 'evil')"
            )
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(
                "UPDATE auth.gootip_schema_migrations SET name = 'changed' WHERE id = 1"
            )

    bootstrapped.reconcile(config)

    with bootstrapped.session(bootstrapped.operator_role, config) as operator:
        operator.execute("INSERT INTO auth.ordinary_before_history (id) VALUES (2)")
        assert operator.execute("SELECT name FROM auth.gootip_schema_migrations").fetchall() == [
            ("0001",)
        ]
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(
                "INSERT INTO auth.gootip_schema_migrations (id, name) VALUES (3, 'evil')"
            )

    with bootstrapped.session(bootstrapped.master_user, config) as master:
        for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
            assert (
                master.execute(
                    "SELECT has_table_privilege(%s, 'auth.gootip_schema_migrations', %s)",
                    (bootstrapped.operator_role, privilege),
                ).fetchone()[0]
                is False
            ), privilege


def test_operator_cannot_perform_ddl_role_or_extension_administration(bootstrapped):
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute("DROP TABLE IF EXISTS auth.operator_ddl_probe")
        migrator.execute("CREATE TABLE auth.operator_ddl_probe (id integer)")

    with bootstrapped.session(bootstrapped.operator_role) as operator:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("CREATE TABLE auth.evil (id integer)")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("ALTER TABLE auth.operator_ddl_probe ADD COLUMN extra text")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("DROP TABLE auth.operator_ddl_probe")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("CREATE SCHEMA elsewhere")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("ALTER SCHEMA auth RENAME TO stolen")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("CREATE ROLE operator_created_role")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(f"ALTER ROLE {bootstrapped.operator_role} CREATEDB")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("CREATE EXTENSION hstore")


def test_operator_cannot_access_undeclared_schemas(bootstrapped):
    with bootstrapped.session(bootstrapped.master_user) as master:
        master.execute("DROP SCHEMA IF EXISTS other_app CASCADE")
        master.execute(f"CREATE SCHEMA other_app AUTHORIZATION {bootstrapped.migrator_role}")

    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute("CREATE TABLE other_app.private_data (id integer)")
        migrator.execute("INSERT INTO other_app.private_data (id) VALUES (1)")

    with bootstrapped.session(bootstrapped.master_user) as master:
        assert (
            master.execute(
                "SELECT has_schema_privilege(%s, 'other_app', 'USAGE')",
                (bootstrapped.operator_role,),
            ).fetchone()[0]
            is False
        )

    with bootstrapped.session(bootstrapped.operator_role) as operator:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("SELECT * FROM other_app.private_data")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute("INSERT INTO other_app.private_data (id) VALUES (2)")


def test_operator_is_not_a_member_of_privileged_roles(bootstrapped):
    with bootstrapped.session(bootstrapped.operator_role) as operator:
        for role in (
            bootstrapped.migrator_role,
            bootstrapped.runtime_role,
            bootstrapped.master_user,
        ):
            assert (
                operator.execute(
                    "SELECT pg_has_role(current_user, %s, 'MEMBER')", (role,)
                ).fetchone()[0]
                is False
            ), role
        for role in (bootstrapped.migrator_role, bootstrapped.runtime_role):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                operator.execute(f"SET ROLE {role}")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(f"SET ROLE {bootstrapped.master_user}")


def test_reconciliation_revokes_preexisting_runtime_and_migrator_memberships(bootstrapped):
    # Membership is cluster-wide. The master login created both application roles,
    # so it can revoke a grant made by itself; cleanup stays unconditional.
    config = bootstrapped.fresh_database("gootip_test_db_config_membership")
    bootstrapped.reconcile(config)
    revocable_roles = (bootstrapped.migrator_role, bootstrapped.runtime_role)
    try:
        with bootstrapped.session(bootstrapped.master_user, config) as master:
            for role in revocable_roles:
                master.execute(f"GRANT {role} TO {bootstrapped.operator_role}")
            for role in revocable_roles:
                assert (
                    master.execute(
                        "SELECT pg_has_role(%s, %s, 'MEMBER')",
                        (bootstrapped.operator_role, role),
                    ).fetchone()[0]
                    is True
                ), role

        assert bootstrapped.reconcile(config) == {"roles_created": 0, "schema_created": 0}

        with bootstrapped.session(bootstrapped.master_user, config) as master:
            for role in revocable_roles:
                assert (
                    master.execute(
                        "SELECT pg_has_role(%s, %s, 'MEMBER')",
                        (bootstrapped.operator_role, role),
                    ).fetchone()[0]
                    is False
                ), role
    finally:
        with bootstrapped.session(bootstrapped.master_user, config) as master:
            for role in revocable_roles:
                master.execute(f"REVOKE {role} FROM {bootstrapped.operator_role}")


def test_reconciliation_fails_closed_on_preexisting_administrative_membership(bootstrapped):
    # PostgreSQL 16+ automatically grants the creator ADMIN OPTION on a role it
    # creates. Remove that reverse membership first, otherwise the intended
    # operator -> master membership would form a prohibited membership cycle.
    # The RDS master cannot revoke the resulting membership inside bootstrap, so
    # reconciliation must refuse before it changes the role.
    config = bootstrapped.fresh_database("gootip_test_db_config_admin_membership")
    bootstrapped.reconcile(config)
    try:
        with bootstrapped.superuser_connection() as superuser:
            superuser.execute(
                f"REVOKE {bootstrapped.operator_role} FROM {bootstrapped.master_user}"
            )
            superuser.execute(f"GRANT {bootstrapped.master_user} TO {bootstrapped.operator_role}")

        with pytest.raises(DatabaseError):
            bootstrapped.reconcile(config)
    finally:
        with bootstrapped.superuser_connection() as superuser:
            superuser.execute(
                f"REVOKE {bootstrapped.master_user} FROM {bootstrapped.operator_role}"
            )
            superuser.execute(
                f"GRANT {bootstrapped.operator_role} TO {bootstrapped.master_user} "
                "WITH ADMIN OPTION"
            )


def test_migrator_owns_and_can_change_auth_objects(bootstrapped):
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        assert (
            migrator.execute(
                "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'auth'"
            ).fetchone()[0]
            == bootstrapped.migrator_role
        )
        migrator.execute("CREATE TABLE auth.migrator_ddl_probe (id integer)")
        migrator.execute("ALTER TABLE auth.migrator_ddl_probe ADD COLUMN note text")
        migrator.execute("DROP TABLE auth.migrator_ddl_probe")


def test_migrator_cannot_touch_unrelated_public_objects(bootstrapped):
    with bootstrapped.session(bootstrapped.master_user) as master:
        master.execute("DROP TABLE IF EXISTS public.other_app")
        master.execute("CREATE TABLE public.other_app (id integer)")

    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            migrator.execute("SELECT * FROM public.other_app")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            migrator.execute("INSERT INTO public.other_app (id) VALUES (1)")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            migrator.execute("ALTER TABLE public.other_app ADD COLUMN extra text")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            migrator.execute("DROP TABLE public.other_app")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            migrator.execute("CREATE TABLE public.evil (id integer)")


def test_runtime_is_not_a_member_of_migrator(bootstrapped):
    with bootstrapped.session(bootstrapped.runtime_role) as runtime:
        assert (
            runtime.execute(
                "SELECT pg_has_role(current_user, %s, 'MEMBER')",
                (bootstrapped.migrator_role,),
            ).fetchone()[0]
            is False
        )
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute(f"SET ROLE {bootstrapped.migrator_role}")


def test_runtime_cannot_write_objects_the_master_created(bootstrapped):
    # A fresh database isolates the ordering: "ALL TABLES" was granted before this
    # object existed, and default privileges only cover the migrator's objects.
    config = bootstrapped.fresh_database("gootip_test_db_config_bookkeeping")
    bootstrapped.reconcile(config)

    with bootstrapped.session(bootstrapped.master_user, config) as master:
        master.execute("CREATE TABLE auth.bookkeeping (id integer)")

    with bootstrapped.session(bootstrapped.runtime_role, config) as runtime:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("INSERT INTO auth.bookkeeping (id) VALUES (1)")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("SELECT * FROM auth.bookkeeping")
