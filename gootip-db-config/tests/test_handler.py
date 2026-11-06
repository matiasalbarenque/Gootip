"""Handler integration: validation, credentials, and the locked bootstrap transaction."""

import json

import psycopg
import pytest

from gootip_db_config import handler
from gootip_db_config.handler import lambda_handler

COUNTS = {"roles_created": 2, "schema_created": 1}


def _patch_database(monkeypatch, connection, counts=COUNTS):
    monkeypatch.setattr(handler.db, "connect", lambda config, credentials: connection)
    monkeypatch.setattr(handler.reconcile, "bootstrap", lambda c, config, credentials: counts)


def test_valid_request_reconciles_and_reports_counts(
    monkeypatch, env, secrets_client, valid_secret_map, fake_connection
):
    connection = fake_connection()
    _patch_database(monkeypatch, connection)

    response = lambda_handler(
        {"operation": "bootstrap"}, env=env, secrets_client=secrets_client(valid_secret_map)
    )

    assert response["status"] == "succeeded"
    assert response["operation"] == "bootstrap"
    assert response["counts"] == COUNTS
    assert response["correlation_id"] == "local"
    assert connection.closed is True


def test_lock_contention_fails_with_a_bounded_code(
    monkeypatch, env, secrets_client, valid_secret_map, fake_connection
):
    connection = fake_connection(lock_granted=False)
    _patch_database(monkeypatch, connection)
    env["DB_LOCK_ACQUIRE_TIMEOUT_MS"] = "1"

    response = lambda_handler(
        {"operation": "bootstrap"}, env=env, secrets_client=secrets_client(valid_secret_map)
    )

    assert response["status"] == "failed"
    assert response["error_code"] == "lock_timeout"
    assert connection.closed is True


def test_database_error_is_reported_without_details(
    monkeypatch, env, secrets_client, valid_secret_map, fake_connection
):
    connection = fake_connection()
    monkeypatch.setattr(handler.db, "connect", lambda config, credentials: connection)

    def explode(connection, config, credentials):
        raise psycopg.OperationalError("password authentication failed for secret-user")

    monkeypatch.setattr(handler.reconcile, "bootstrap", explode)

    response = lambda_handler(
        {"operation": "bootstrap"}, env=env, secrets_client=secrets_client(valid_secret_map)
    )

    assert response["error_code"] == "database_error"
    assert connection.closed is True
    assert "secret-user" not in json.dumps(response)


def test_event_outside_contract_fails_before_configuration(env, secrets_client):
    response = lambda_handler(
        {"operation": "bootstrap", "sql": "DROP TABLE users"},
        env=env,
        secrets_client=secrets_client({}),
    )

    assert response["status"] == "failed"
    assert response["error_code"] == "invalid_event"


def test_missing_configuration_fails_before_credentials(env, secrets_client):
    response = lambda_handler({"operation": "bootstrap"}, env={}, secrets_client=secrets_client({}))

    assert response["error_code"] == "invalid_configuration"


def test_secret_without_password_fails_before_sql(env, secrets_client):
    client = secrets_client({env["DB_MASTER_SECRET_ARN"]: json.dumps({"username": "gootip_auth"})})

    response = lambda_handler({"operation": "bootstrap"}, env=env, secrets_client=client)

    assert response["status"] == "failed"
    assert response["error_code"] == "invalid_secret"


def test_mismatched_role_username_fails_before_sql(env, secrets_client, secret_payload):
    client = secrets_client(
        {
            env["DB_MASTER_SECRET_ARN"]: secret_payload("gootip_auth"),
            env["AUTH_RUNTIME_SECRET_ARN"]: secret_payload("auth_migrator"),
        }
    )

    response = lambda_handler({"operation": "bootstrap"}, env=env, secrets_client=client)

    assert response["error_code"] == "invalid_secret"


def test_mismatched_operator_username_fails_before_sql(
    env, secrets_client, secret_payload, valid_secret_map
):
    valid_secret_map[env["DB_OPERATOR_SECRET_ARN"]] = secret_payload("auth_runtime")
    client = secrets_client(valid_secret_map)

    response = lambda_handler({"operation": "bootstrap"}, env=env, secrets_client=client)

    assert response["error_code"] == "invalid_secret"


def test_mismatched_core_username_fails_before_database_connect(
    monkeypatch, env, secrets_client, secret_payload, valid_secret_map
):
    valid_secret_map[env["CORE_RUNTIME_SECRET_ARN"]] = secret_payload("core_migrator")
    monkeypatch.setattr(
        handler.db,
        "connect",
        lambda *_: pytest.fail("database connection must not open for invalid Core credentials"),
    )

    response = lambda_handler(
        {"operation": "bootstrap"}, env=env, secrets_client=secrets_client(valid_secret_map)
    )

    assert response["status"] == "failed"
    assert response["error_code"] == "invalid_secret"


def test_missing_core_secret_fails_before_database_connect(
    monkeypatch, env, secrets_client, valid_secret_map
):
    del valid_secret_map[env["CORE_MIGRATOR_SECRET_ARN"]]
    monkeypatch.setattr(
        handler.db,
        "connect",
        lambda *_: pytest.fail("database connection must not open for missing Core credentials"),
    )

    response = lambda_handler(
        {"operation": "bootstrap"}, env=env, secrets_client=secrets_client(valid_secret_map)
    )

    assert response["status"] == "failed"
    assert response["error_code"] == "internal_error"


def test_response_never_contains_a_secret_value(
    monkeypatch, env, secrets_client, secret_payload, fake_connection
):
    connection = fake_connection()
    _patch_database(monkeypatch, connection)
    client = secrets_client(
        {
            env["DB_MASTER_SECRET_ARN"]: secret_payload("gootip_auth", "super-secret-value"),
            env["AUTH_RUNTIME_SECRET_ARN"]: secret_payload("auth_runtime", "super-secret-value"),
            env["AUTH_MIGRATOR_SECRET_ARN"]: secret_payload("auth_migrator", "super-secret-value"),
            env["DB_OPERATOR_SECRET_ARN"]: secret_payload(
                "gootip_dev_operator", "super-secret-value"
            ),
            env["CORE_RUNTIME_SECRET_ARN"]: secret_payload("core_runtime", "super-secret-value"),
            env["CORE_MIGRATOR_SECRET_ARN"]: secret_payload("core_migrator", "super-secret-value"),
        }
    )

    response = lambda_handler({"operation": "bootstrap"}, env=env, secrets_client=client)

    assert response["status"] == "succeeded"
    assert "super-secret-value" not in json.dumps(response)
