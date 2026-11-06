"""Core inventory accepts only registered, cumulative migration prefixes."""

from __future__ import annotations

import pytest

from gootip_db_config.config import CORE_MIGRATION_EXPECTATIONS
from gootip_db_config.errors import DatabaseError

pytestmark = pytest.mark.integration


def _insert_history(bootstrapped, count: int) -> None:
    with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
        migrator.execute("DELETE FROM core.typeorm_migrations")
        for name, timestamp, _ in CORE_MIGRATION_EXPECTATIONS[:count]:
            migrator.execute(
                "INSERT INTO core.typeorm_migrations (timestamp, name) VALUES (%s, %s)",
                (timestamp, name),
            )


def test_core_inventory_accepts_two_and_three_migration_prefixes(bootstrapped):
    with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
        migrator.execute("CREATE TABLE core.categories (id integer NOT NULL)")
    try:
        _insert_history(bootstrapped, 1)
        bootstrapped.reconcile()

        with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
            migrator.execute("CREATE TABLE core.products (id integer NOT NULL)")
        _insert_history(bootstrapped, 2)
        bootstrapped.reconcile()
        bootstrapped.reconcile()

        _insert_history(bootstrapped, 3)
        bootstrapped.reconcile()
        bootstrapped.reconcile()

        with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
            migrator.execute(
                "INSERT INTO core.typeorm_migrations (timestamp, name) VALUES (%s, %s)",
                (
                    CORE_MIGRATION_EXPECTATIONS[1][1],
                    CORE_MIGRATION_EXPECTATIONS[1][0],
                ),
            )
        with pytest.raises(DatabaseError, match="unknown migration records"):
            bootstrapped.reconcile()

        _insert_history(bootstrapped, 3)
        with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
            migrator.execute(
                "UPDATE core.typeorm_migrations SET timestamp = %s WHERE name = %s",
                (
                    CORE_MIGRATION_EXPECTATIONS[1][1],
                    CORE_MIGRATION_EXPECTATIONS[0][0],
                ),
            )
        with pytest.raises(DatabaseError, match="unknown migration records"):
            bootstrapped.reconcile()

        _insert_history(bootstrapped, 3)
        with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
            migrator.execute(
                "UPDATE core.typeorm_migrations SET name = 'Unknown1793318400000' "
                "WHERE timestamp = 1793318400000"
            )
        with pytest.raises(DatabaseError, match="unknown migration records"):
            bootstrapped.reconcile()

        _insert_history(bootstrapped, 3)
        with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
            migrator.execute("CREATE TABLE core.unrelated_probe (id integer)")
        with pytest.raises(DatabaseError, match="do not match"):
            bootstrapped.reconcile()
        with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
            migrator.execute("DROP TABLE core.unrelated_probe")
    finally:
        with bootstrapped.session(bootstrapped.config.core_migrator_role) as migrator:
            migrator.execute("DROP TABLE IF EXISTS core.products")
            migrator.execute("DROP TABLE IF EXISTS core.categories")
            migrator.execute("DELETE FROM core.typeorm_migrations")
