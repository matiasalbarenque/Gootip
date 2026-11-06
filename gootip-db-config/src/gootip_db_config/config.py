"""Validated environment configuration for the administrative bootstrap.

Every database identity, role name, schema name, secret ARN, and the CA path
comes from here, never from the event, so a caller cannot redirect the operation
to another target. The fixed role and schema names are part of the SPEC 03
contract and are not configurable.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

from .errors import InvalidConfiguration

RUNTIME_ROLE = "auth_runtime"
MIGRATOR_ROLE = "auth_migrator"
OPERATOR_ROLE = "gootip_dev_operator"
CORE_RUNTIME_ROLE = "core_runtime"
CORE_MIGRATOR_ROLE = "core_migrator"
AUTH_SCHEMA = "auth"
CORE_SCHEMA = "core"
# Keep this guard aligned with gootip-core's registered migration list and the
# objects each additive migration creates; mismatches stop reconciliation.
CORE_MIGRATION_EXPECTATIONS = (
    ("CreateCategories1782086400000", 1782086400000, ("categories",)),
    ("CreateProducts1793059200000", 1793059200000, ("categories", "products")),
    (
        "RenameCatalogColumnsToSnakeCase1793318400000",
        1793318400000,
        ("categories", "products"),
    ),
)
# The developer operator is an application-surface role: reconciliation grants
# it DML only inside the declared application schemas, never cluster-wide.
APPLICATION_SCHEMAS = (AUTH_SCHEMA, CORE_SCHEMA)

_REQUIRED_SSL_MODE = "verify-full"
_DEFAULT_CA_PATH = "/opt/certs/rds-ca-bundle.pem"
_SECRET_ARN_PREFIX = "arn:aws:secretsmanager:"


@dataclass(frozen=True)
class Config:
    """Validated, non-secret runtime configuration."""

    db_host: str
    db_port: int
    db_name: str
    ssl_mode: str
    ca_path: str
    master_secret_arn: str
    runtime_secret_arn: str
    migrator_secret_arn: str
    operator_secret_arn: str
    core_runtime_secret_arn: str
    core_migrator_secret_arn: str
    auth_schema: str
    core_schema: str
    runtime_role: str
    migrator_role: str
    operator_role: str
    core_runtime_role: str
    core_migrator_role: str
    application_schemas: tuple[str, ...]
    connect_timeout_seconds: int
    statement_timeout_ms: int
    lock_acquire_timeout_ms: int


def load_config(env: Mapping[str, str] | None = None) -> Config:
    """Validate the environment and return the immutable configuration.

    Raises:
        InvalidConfiguration: if a required variable is missing or unsafe, such
            as an SSL mode other than ``verify-full`` or a non-ARN secret
            reference.
    """
    env = os.environ if env is None else env
    return Config(
        db_host=_required(env, "POSTGRES_DB_HOST"),
        db_port=_integer(env, "POSTGRES_DB_PORT", 5432, minimum=1, maximum=65535),
        db_name=_required(env, "POSTGRES_DB_NAME"),
        ssl_mode=_choice(env, "POSTGRES_SSL_MODE", _REQUIRED_SSL_MODE),
        ca_path=env.get("POSTGRES_CA_PATH") or _DEFAULT_CA_PATH,
        master_secret_arn=_secret_arn(env, "DB_MASTER_SECRET_ARN"),
        runtime_secret_arn=_secret_arn(env, "AUTH_RUNTIME_SECRET_ARN"),
        migrator_secret_arn=_secret_arn(env, "AUTH_MIGRATOR_SECRET_ARN"),
        operator_secret_arn=_secret_arn(env, "DB_OPERATOR_SECRET_ARN"),
        core_runtime_secret_arn=_secret_arn(env, "CORE_RUNTIME_SECRET_ARN"),
        core_migrator_secret_arn=_secret_arn(env, "CORE_MIGRATOR_SECRET_ARN"),
        auth_schema=AUTH_SCHEMA,
        core_schema=CORE_SCHEMA,
        runtime_role=RUNTIME_ROLE,
        migrator_role=MIGRATOR_ROLE,
        operator_role=OPERATOR_ROLE,
        core_runtime_role=CORE_RUNTIME_ROLE,
        core_migrator_role=CORE_MIGRATOR_ROLE,
        application_schemas=APPLICATION_SCHEMAS,
        connect_timeout_seconds=_integer(env, "DB_CONNECT_TIMEOUT", 10, minimum=1, maximum=60),
        statement_timeout_ms=_integer(
            env, "DB_STATEMENT_TIMEOUT_MS", 30000, minimum=1, maximum=900000
        ),
        lock_acquire_timeout_ms=_integer(
            env, "DB_LOCK_ACQUIRE_TIMEOUT_MS", 5000, minimum=1, maximum=60000
        ),
    )


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name)
    if not value:
        raise InvalidConfiguration(f"{name} is required")
    return value


def _integer(env: Mapping[str, str], name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise InvalidConfiguration(f"{name} must be an integer") from None
    if not minimum <= value <= maximum:
        raise InvalidConfiguration(f"{name} must be between {minimum} and {maximum}")
    return value


def _choice(env: Mapping[str, str], name: str, expected: str) -> str:
    value = env.get(name)
    if value != expected:
        raise InvalidConfiguration(f"{name} must be {expected!r}")
    return value


def _secret_arn(env: Mapping[str, str], name: str) -> str:
    value = _required(env, name)
    if not value.startswith(_SECRET_ARN_PREFIX):
        raise InvalidConfiguration(f"{name} must be a Secrets Manager ARN")
    return value
