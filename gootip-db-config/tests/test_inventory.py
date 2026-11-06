"""Inventory query wrappers return sanitized Python values."""

import pytest

from gootip_db_config import inventory
from gootip_db_config.errors import DatabaseError


class _StubConnection:
    def __init__(self, row) -> None:
        self._row = row
        self.calls: list[tuple[str, tuple | None]] = []

    def execute(self, query, params=None):
        self.calls.append((query, params))
        return self

    def fetchone(self):
        return self._row


def test_role_exists_returns_boolean():
    assert inventory.role_exists(_StubConnection((True,)), "auth_runtime") is True
    assert inventory.role_exists(_StubConnection((False,)), "auth_runtime") is False


def test_schema_owner_returns_none_when_absent():
    assert inventory.schema_owner(_StubConnection(None), "auth") is None


def test_absent_core_schema_is_classified_for_initial_preparation(config):
    state = inventory.inspect_core(_StubConnection(None), config)

    assert state.schema_owner is None
    assert state.relations == ()
    assert state.history_rows == ()
    assert state.history_exists is False


def test_unexpected_core_schema_owner_stops_inventory(config):
    with pytest.raises(DatabaseError, match="unexpected owner"):
        inventory.inspect_core(_StubConnection(("unexpected_owner",)), config)


def test_is_member_forwards_looked_up_names():
    connection = _StubConnection((False,))

    assert inventory.is_member(connection, "auth_runtime", "auth_migrator") is False
    assert connection.calls[0][1] == ("auth_runtime", "auth_migrator")
