"""Shared fixtures for the administrative bootstrap tests."""

from __future__ import annotations

import contextlib
import json
from typing import Any

import pytest

from gootip_db_config.config import (
    CORE_MIGRATOR_ROLE,
    CORE_RUNTIME_ROLE,
    MIGRATOR_ROLE,
    OPERATOR_ROLE,
    RUNTIME_ROLE,
    load_config,
)
from gootip_db_config.credentials import Credentials

VALID_ENV = {
    "POSTGRES_DB_HOST": "gootip-dev.example.us-east-2.rds.amazonaws.com",
    "POSTGRES_DB_PORT": "5432",
    "POSTGRES_DB_NAME": "gootip",
    "POSTGRES_SSL_MODE": "verify-full",
    "POSTGRES_CA_PATH": "/opt/certs/rds-ca-bundle.pem",
    "DB_MASTER_SECRET_ARN": (
        "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-abcd-123456"
    ),
    "AUTH_RUNTIME_SECRET_ARN": (
        "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-auth-runtime-Ab12Cd"
    ),
    "AUTH_MIGRATOR_SECRET_ARN": (
        "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-auth-migrator-Ef34Gh"
    ),
    "DB_OPERATOR_SECRET_ARN": (
        "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-db-operator-Ij56Kl"
    ),
    "CORE_RUNTIME_SECRET_ARN": (
        "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-runtime-Mn78Op"
    ),
    "CORE_MIGRATOR_SECRET_ARN": (
        "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-migrator-Qr90St"
    ),
}


class FakeSecretsClient:
    """Minimal Secrets Manager double: returns configured values or raises them."""

    def __init__(self, values: dict[str, Any]) -> None:
        self._values = values

    def get_secret_value(self, SecretId: str) -> dict[str, str]:  # noqa: N803 - boto3 keyword
        value = self._values[SecretId]
        if isinstance(value, Exception):
            raise value
        return {"SecretString": value}


class _FakeResult:
    def __init__(self, value: Any) -> None:
        self._value = value

    def fetchone(self) -> tuple[Any]:
        return (self._value,)


class FakeConnection:
    """Minimal psycopg double: answers queries and records executed statements."""

    def __init__(self, lock_granted: bool = True) -> None:
        self.lock_granted = lock_granted
        self.closed = False
        self.statements: list[str] = []

    def execute(self, query, params: tuple | None = None) -> _FakeResult:
        self.statements.append(query if isinstance(query, str) else query.as_string())
        return _FakeResult(self.lock_granted)

    def transaction(self) -> contextlib.AbstractContextManager:
        return contextlib.nullcontext()

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def fake_connection():
    """Factory that builds a psycopg double, optionally refusing the advisory lock."""

    def _build(lock_granted: bool = True) -> FakeConnection:
        return FakeConnection(lock_granted)

    return _build


@pytest.fixture
def env() -> dict[str, str]:
    return dict(VALID_ENV)


@pytest.fixture
def config():
    return load_config(VALID_ENV)


@pytest.fixture
def secrets_client():
    """Factory that builds a fake Secrets Manager client from an ARN->value map."""

    def _build(values: dict[str, Any]) -> FakeSecretsClient:
        return FakeSecretsClient(values)

    return _build


@pytest.fixture
def secret_payload():
    """Factory that renders a role-secret JSON body."""

    def _build(username: str, password: str = "secret-password") -> str:
        return json.dumps({"username": username, "password": password})

    return _build


@pytest.fixture
def valid_secret_map(env, secret_payload) -> dict[str, str]:
    return {
        env["DB_MASTER_SECRET_ARN"]: secret_payload("gootip_auth"),
        env["AUTH_RUNTIME_SECRET_ARN"]: secret_payload(RUNTIME_ROLE),
        env["AUTH_MIGRATOR_SECRET_ARN"]: secret_payload(MIGRATOR_ROLE),
        env["DB_OPERATOR_SECRET_ARN"]: secret_payload(OPERATOR_ROLE),
        env["CORE_RUNTIME_SECRET_ARN"]: secret_payload(CORE_RUNTIME_ROLE),
        env["CORE_MIGRATOR_SECRET_ARN"]: secret_payload(CORE_MIGRATOR_ROLE),
    }


@pytest.fixture
def role_credentials(config) -> dict[str, Credentials]:
    return {
        config.runtime_role: Credentials(config.runtime_role, "runtime-password"),
        config.migrator_role: Credentials(config.migrator_role, "migrator-password"),
        config.operator_role: Credentials(config.operator_role, "operator-password"),
        config.core_runtime_role: Credentials(config.core_runtime_role, "core-runtime-password"),
        config.core_migrator_role: Credentials(config.core_migrator_role, "core-migrator-password"),
    }
