"""Stable advisory-lock identity and bounded acquisition."""

import pytest

from gootip_db_config import locking
from gootip_db_config.errors import LockTimeout


class _Result:
    def __init__(self, value: bool) -> None:
        self._value = value

    def fetchone(self) -> tuple[bool]:
        return (self._value,)


class _LockConnection:
    """Returns a scripted sequence of lock outcomes and records each query."""

    def __init__(self, outcomes: list[bool]) -> None:
        self._outcomes = list(outcomes)
        self.queries: list[str] = []

    def execute(self, query: str, params: tuple | None = None) -> _Result:
        self.queries.append(query)
        return _Result(self._outcomes.pop(0) if self._outcomes else False)


def test_lock_key_is_stable_and_scoped():
    assert locking.lock_key("gootip", "auth") == locking.lock_key("gootip", "auth")
    assert locking.lock_key("gootip", "auth") != locking.lock_key("gootip", "core")
    assert locking.lock_key("gootip", "auth") != locking.lock_key("other", "auth")


def test_lock_key_fits_signed_64_bit():
    key = locking.lock_key("gootip", "auth")

    assert -(2**63) <= key < 2**63


def test_hold_lock_acquires_then_releases():
    connection = _LockConnection([True, True])

    with locking.hold_lock(connection, 42, 1.0):
        pass

    assert "pg_try_advisory_lock" in connection.queries[0]
    assert "pg_advisory_unlock" in connection.queries[1]


def test_hold_lock_times_out_without_touching_the_database():
    connection = _LockConnection([False])

    with pytest.raises(LockTimeout) as raised, locking.hold_lock(connection, 42, 0.0):
        pass

    assert raised.value.code == "lock_timeout"
    assert all("pg_advisory_unlock" not in query for query in connection.queries)


def test_core_lock_uses_typeorm_identity_and_releases_after_failure():
    connection = _LockConnection([True, True])

    with pytest.raises(ValueError), locking.hold_core_migration_lock(connection, 1.0):
        raise ValueError("test failure")

    assert "hashtextextended(current_database() || ':core', 0)" in connection.queries[0]
    assert (
        "pg_advisory_unlock(hashtextextended(current_database() || ':core', 0))"
        in (connection.queries[1])
    )


def test_bootstrap_lock_order_and_reverse_release():
    connection = _LockConnection([True] * 6)

    with locking.hold_bootstrap_locks(connection, "gootip", 1.0):
        pass

    queries = connection.queries
    assert "pg_try_advisory_lock(%s)" in queries[0]
    assert "pg_try_advisory_lock(%s)" in queries[1]
    assert "hashtextextended(current_database() || ':core', 0)" in queries[2]
    assert "hashtextextended(current_database() || ':core', 0)" in queries[3]
    assert "pg_advisory_unlock(%s)" in queries[4]
    assert "pg_advisory_unlock(%s)" in queries[5]
