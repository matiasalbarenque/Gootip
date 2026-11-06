"""Environment configuration validation."""

import pytest

from conftest import VALID_ENV
from gootip_db_config.config import (
    APPLICATION_SCHEMAS,
    AUTH_SCHEMA,
    CORE_MIGRATOR_ROLE,
    CORE_RUNTIME_ROLE,
    CORE_SCHEMA,
    MIGRATOR_ROLE,
    OPERATOR_ROLE,
    RUNTIME_ROLE,
    load_config,
)
from gootip_db_config.errors import InvalidConfiguration


def test_valid_environment_builds_config():
    config = load_config(VALID_ENV)

    assert config.db_host == VALID_ENV["POSTGRES_DB_HOST"]
    assert config.db_port == 5432
    assert config.ssl_mode == "verify-full"
    assert config.ca_path == "/opt/certs/rds-ca-bundle.pem"
    assert config.auth_schema == AUTH_SCHEMA
    assert config.core_schema == CORE_SCHEMA
    assert config.runtime_role == RUNTIME_ROLE
    assert config.migrator_role == MIGRATOR_ROLE
    assert config.core_runtime_role == CORE_RUNTIME_ROLE
    assert config.core_migrator_role == CORE_MIGRATOR_ROLE
    assert config.core_runtime_secret_arn == VALID_ENV["CORE_RUNTIME_SECRET_ARN"]
    assert config.core_migrator_secret_arn == VALID_ENV["CORE_MIGRATOR_SECRET_ARN"]
    assert config.connect_timeout_seconds == 10


def test_operator_identity_and_allowlist_are_fixed():
    config = load_config(VALID_ENV)

    assert config.operator_role == OPERATOR_ROLE == "gootip_dev_operator"
    assert config.operator_secret_arn == VALID_ENV["DB_OPERATOR_SECRET_ARN"]
    assert config.application_schemas == APPLICATION_SCHEMAS == ("auth", "core")


@pytest.mark.parametrize(
    "removed",
    [
        "POSTGRES_DB_HOST",
        "POSTGRES_DB_NAME",
        "DB_MASTER_SECRET_ARN",
        "AUTH_RUNTIME_SECRET_ARN",
        "DB_OPERATOR_SECRET_ARN",
        "CORE_RUNTIME_SECRET_ARN",
        "CORE_MIGRATOR_SECRET_ARN",
    ],
)
def test_missing_required_field_is_rejected(removed):
    env = {key: value for key, value in VALID_ENV.items() if key != removed}

    with pytest.raises(InvalidConfiguration):
        load_config(env)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("POSTGRES_SSL_MODE", "require"),
        ("POSTGRES_SSL_MODE", "disable"),
        ("POSTGRES_DB_PORT", "not-a-port"),
        ("POSTGRES_DB_PORT", "70000"),
        ("DB_MASTER_SECRET_ARN", "not-an-arn"),
        ("AUTH_RUNTIME_SECRET_ARN", "rds!db-abcd-123456"),
        ("DB_OPERATOR_SECRET_ARN", "gootip-dev-db-operator"),
        ("CORE_RUNTIME_SECRET_ARN", "gootip-dev-core-runtime"),
        ("CORE_MIGRATOR_SECRET_ARN", "gootip-dev-core-migrator"),
        ("DB_CONNECT_TIMEOUT", "0"),
    ],
)
def test_unsafe_value_is_rejected(field, value):
    env = dict(VALID_ENV)
    env[field] = value

    with pytest.raises(InvalidConfiguration):
        load_config(env)
