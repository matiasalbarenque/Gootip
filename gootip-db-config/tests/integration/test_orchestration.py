"""Repeated and concurrent invocation against the disposable database.

These exercise the same public path the Lambda uses: the stable advisory lock,
the atomic transaction, and the idempotent reconciliation. Concurrency is proven
both ways: a second session cannot take the lock while it is held, and two
simultaneous invocations serialize instead of racing.
"""

from __future__ import annotations

import dataclasses
import threading

import pytest

from gootip_db_config import handler, locking
from gootip_db_config.errors import LockTimeout

pytestmark = pytest.mark.integration


def test_the_first_bootstrap_created_roles_and_schema(bootstrapped):
    assert bootstrapped.first_counts == {"roles_created": 5, "schema_created": 2}


def test_repeated_invocation_is_idempotent_and_preserves_data(bootstrapped):
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        migrator.execute("DROP TABLE IF EXISTS auth.repeat_probe")
        migrator.execute("CREATE TABLE auth.repeat_probe (id integer)")
        migrator.execute("INSERT INTO auth.repeat_probe (id) VALUES (7)")

    bootstrapped.reconcile_with_history()

    with bootstrapped.session(bootstrapped.operator_role) as operator:
        operator.execute("INSERT INTO auth.repeat_probe (id) VALUES (8)")

    second = bootstrapped.reconcile()

    assert second == {"roles_created": 0, "schema_created": 0}
    with bootstrapped.session(bootstrapped.migrator_role) as migrator:
        assert migrator.execute("SELECT id FROM auth.repeat_probe ORDER BY id").fetchall() == [
            (7,),
            (8,),
        ]
    with bootstrapped.session(bootstrapped.runtime_role) as runtime:
        assert runtime.execute("SELECT id FROM auth.repeat_probe ORDER BY id").fetchall() == [
            (7,),
            (8,),
        ]
    with bootstrapped.session(bootstrapped.operator_role) as operator:
        assert operator.execute("SELECT id FROM auth.repeat_probe ORDER BY id").fetchall() == [
            (7,),
            (8,),
        ]


def test_lock_acquisition_times_out_while_another_session_holds_it(bootstrapped):
    key = locking.lock_key(bootstrapped.config.db_name, bootstrapped.config.auth_schema)
    impatient = dataclasses.replace(bootstrapped.config, lock_acquire_timeout_ms=300)

    holder = bootstrapped.connection(bootstrapped.master_user)
    try:
        holder.execute("SELECT pg_advisory_lock(%s)", (key,))
        waiter = bootstrapped.connection(bootstrapped.master_user, impatient)
        try:
            with pytest.raises(LockTimeout):
                handler._reconcile(waiter, impatient, bootstrapped.credentials)
        finally:
            waiter.close()
    finally:
        holder.close()


def test_typeorm_core_migration_lock_blocks_admin_and_releases_admin_locks(bootstrapped):
    impatient = dataclasses.replace(bootstrapped.config, lock_acquire_timeout_ms=300)
    holder = bootstrapped.connection(bootstrapped.master_user)
    waiter = bootstrapped.connection(bootstrapped.master_user, impatient)
    try:
        holder.execute(
            "SELECT pg_advisory_lock(hashtextextended(current_database() || ':core', 0))"
        )
        with pytest.raises(LockTimeout):
            handler._reconcile(waiter, impatient, bootstrapped.credentials)
        for schema in ("auth", "core"):
            key = locking.lock_key(bootstrapped.config.db_name, schema)
            assert holder.execute("SELECT pg_try_advisory_lock(%s)", (key,)).fetchone()[0]
            assert holder.execute("SELECT pg_advisory_unlock(%s)", (key,)).fetchone()[0]
    finally:
        holder.execute(
            "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':core', 0))"
        )
        waiter.close()
        holder.close()


def test_concurrent_invocations_serialize_without_conflict(bootstrapped):
    # A fresh database is the discriminator: roles already exist cluster-wide, but
    # the schema is per-database, so only a serialized pair can report one creation.
    config = bootstrapped.fresh_database("gootip_test_db_config_concurrency")
    barrier = threading.Barrier(2)
    counts: list[dict[str, int]] = []
    failures: list[Exception] = []

    def run() -> None:
        connection = bootstrapped.connection(bootstrapped.master_user, config)
        try:
            barrier.wait(timeout=15)
            counts.append(handler._reconcile(connection, config, bootstrapped.credentials))
        except Exception as error:  # collected so the assertion reports the real failure
            failures.append(error)
        finally:
            connection.close()

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert failures == []
    assert sorted(count["schema_created"] for count in counts) == [0, 2]
    assert sum(count["roles_created"] for count in counts) == 0


def test_handler_runs_the_full_contract(bootstrapped, monkeypatch, secrets_client):
    monkeypatch.setattr(handler, "load_config", lambda env: bootstrapped.config)
    monkeypatch.setattr(
        handler.db,
        "connect",
        lambda config, credentials: bootstrapped.connection(bootstrapped.master_user, config),
    )

    result = handler.lambda_handler(
        {"operation": "bootstrap"},
        None,
        env=bootstrapped.env,
        secrets_client=secrets_client(bootstrapped.secret_map()),
    )

    assert result["status"] == "succeeded"
    assert result["counts"] == {"roles_created": 0, "schema_created": 0}
