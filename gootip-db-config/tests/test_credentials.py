"""Secrets Manager loading and credential validation."""

import pytest

from conftest import VALID_ENV
from gootip_db_config.credentials import Credentials, load_all_credentials, read_credentials
from gootip_db_config.errors import InvalidSecret


def test_master_secret_is_loaded(secrets_client, secret_payload):
    arn = VALID_ENV["DB_MASTER_SECRET_ARN"]
    client = secrets_client({arn: secret_payload("gootip_auth", "master-password")})

    credentials = read_credentials(client, arn)

    assert credentials == Credentials(username="gootip_auth", password="master-password")


def test_role_secret_with_matching_username_is_loaded(secrets_client, secret_payload):
    arn = VALID_ENV["AUTH_RUNTIME_SECRET_ARN"]
    client = secrets_client({arn: secret_payload("auth_runtime")})

    assert read_credentials(client, arn, "auth_runtime").username == "auth_runtime"


def test_load_all_reads_six_secrets(config, secrets_client, valid_secret_map):
    credentials = load_all_credentials(config, secrets_client(valid_secret_map))

    assert set(credentials) == {
        "master",
        config.runtime_role,
        config.migrator_role,
        config.operator_role,
        config.core_runtime_role,
        config.core_migrator_role,
    }
    assert credentials[config.operator_role].username == "gootip_dev_operator"
    assert credentials[config.core_runtime_role].username == "core_runtime"
    assert credentials[config.core_migrator_role].username == "core_migrator"


@pytest.mark.parametrize(
    ("role_field", "secret_field", "wrong_username"),
    [
        ("core_runtime_role", "core_runtime_secret_arn", "core_migrator"),
        ("core_migrator_role", "core_migrator_secret_arn", "core_runtime"),
    ],
)
def test_core_role_secret_username_must_match(
    config, secrets_client, role_field, secret_field, wrong_username, secret_payload
):
    arn = getattr(config, secret_field)

    with pytest.raises(InvalidSecret, match="does not match the expected role"):
        read_credentials(
            secrets_client({arn: secret_payload(wrong_username)}), arn, getattr(config, role_field)
        )


@pytest.mark.parametrize(
    "payload",
    [
        "",
        "not json",
        "[]",
        "{}",
        '{"username": "auth_runtime"}',
        '{"password": "secret-password"}',
    ],
)
def test_missing_or_malformed_secret_is_rejected(secrets_client, payload):
    arn = VALID_ENV["AUTH_RUNTIME_SECRET_ARN"]
    client = secrets_client({arn: payload})

    with pytest.raises(InvalidSecret) as raised:
        read_credentials(client, arn, "auth_runtime")

    assert raised.value.code == "invalid_secret"


def test_mismatched_role_username_is_rejected(secrets_client, secret_payload):
    arn = VALID_ENV["AUTH_RUNTIME_SECRET_ARN"]
    client = secrets_client({arn: secret_payload("auth_migrator")})

    with pytest.raises(InvalidSecret, match="does not match the expected role"):
        read_credentials(client, arn, "auth_runtime")


def test_operator_username_must_match_the_fixed_identity(secrets_client, secret_payload):
    arn = VALID_ENV["DB_OPERATOR_SECRET_ARN"]
    client = secrets_client({arn: secret_payload("auth_runtime")})

    with pytest.raises(InvalidSecret, match="does not match the expected role"):
        read_credentials(client, arn, "gootip_dev_operator")
