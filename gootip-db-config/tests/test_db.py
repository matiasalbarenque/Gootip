"""TLS connection factory: verified parameters, timeouts, and encrypted sessions."""

import pytest

from gootip_db_config import db
from gootip_db_config.credentials import Credentials
from gootip_db_config.errors import DatabaseError


class _FakeCursor:
    def __init__(self, encrypted: bool) -> None:
        self._encrypted = encrypted

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, statement):
        self._statement = statement

    def fetchone(self):
        return (self._encrypted,)


class _FakeConnection:
    def __init__(self, encrypted: bool) -> None:
        self._encrypted = encrypted
        self.closed = False

    def cursor(self):
        return _FakeCursor(self._encrypted)

    def close(self) -> None:
        self.closed = True


def test_parameters_require_verified_tls_and_bounded_timeouts(config):
    parameters = db.connection_parameters(config, Credentials("auth_runtime", "pw"))

    assert parameters["sslmode"] == "verify-full"
    assert parameters["sslrootcert"] == "/opt/certs/rds-ca-bundle.pem"
    assert parameters["host"] == config.db_host
    assert parameters["port"] == 5432
    assert parameters["connect_timeout"] == 10
    assert parameters["options"] == "-c statement_timeout=30000"


def test_connection_is_encrypted_reads_pg_stat_ssl():
    assert db.connection_is_encrypted(_FakeConnection(True)) is True
    assert db.connection_is_encrypted(_FakeConnection(False)) is False


def test_connect_passes_verified_parameters(monkeypatch, config):
    captured = {}

    def fake_connect(**parameters):
        captured.update(parameters)
        return _FakeConnection(encrypted=True)

    monkeypatch.setattr(db.psycopg, "connect", fake_connect)

    connection = db.connect(config, Credentials("auth_runtime", "pw"))

    assert connection is not None
    assert captured["sslmode"] == "verify-full"
    assert captured["sslrootcert"] == "/opt/certs/rds-ca-bundle.pem"


def test_connect_refuses_an_unencrypted_session(monkeypatch, config):
    closed = {}

    def fake_connect(**parameters):
        connection = _FakeConnection(encrypted=False)
        closed["connection"] = connection
        return connection

    monkeypatch.setattr(db.psycopg, "connect", fake_connect)

    with pytest.raises(DatabaseError) as raised:
        db.connect(config, Credentials("auth_runtime", "pw"))

    assert raised.value.code == "database_error"
    assert closed["connection"].closed is True
