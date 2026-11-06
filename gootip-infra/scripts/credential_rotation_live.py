#!/usr/bin/env python3
"""Prepared SPEC 10.1 credential transition helper; live entry point is disabled."""

from __future__ import annotations

import json
import getpass
import os
import re
import secrets
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from credential_rotation import (
    RotationPreconditionError,
    decide_recovery,
    prepare_secret_payload,
    require_expected_current_version,
    require_target,
    sanitized_failure,
)

REGION = "us-east-2"
ACCOUNT_ID = os.getenv("TF_VAR_aws_account_id", "")
DATABASE = "gootip"
OPERATOR_LOGIN = "gootip_credential_operator"
OPERATOR_PROFILE = "gootip-credential-operator"
OPERATOR_ROLE_ARN = f"arn:aws:iam::{ACCOUNT_ID}:role/gootip/operations/GootipCredentialOperator"
DB_INSTANCE = "gootip-dev"
LOCAL_PORT = 15432
LIVE_EXECUTION_ENABLED = False
TARGETS = {
    "auth": {
        "username": "auth_runtime",
        "secret_arn": os.getenv("TF_VAR_auth_runtime_secret_arn", ""),
    },
    "core": {
        "username": "core_runtime",
        "secret_arn": os.getenv("TF_VAR_core_runtime_secret_arn", ""),
    },
}


def current_version_id(description: dict) -> str:
    versions = description.get("VersionIdsToStages")
    if not isinstance(versions, dict):
        raise RotationPreconditionError("secret version metadata is missing")
    current = [version for version, stages in versions.items() if "AWSCURRENT" in stages]
    if len(current) != 1:
        raise RotationPreconditionError("secret does not have exactly one current version")
    return current[0]


class DatabaseWriteFailure(Exception):
    """Safe database failure metadata; deliberately excludes the driver message."""

    def __init__(self, stage: str, sqlstate: str | None):
        self.stage = stage
        self.sqlstate = sqlstate
        super().__init__(stage)


def _sqlstate(error: BaseException) -> str | None:
    value = getattr(error, "sqlstate", None)
    return value if isinstance(value, str) and re.fullmatch(r"[A-Z0-9]{5}", value) else None


def _latest_attempt_versions(service: str, expected_prior_version_id: str) -> dict:
    path = Path.home() / ".local" / "state" / "gootip" / "credential-rotation" / "ledger.ndjson"
    transition_states = {"database_uncertain", "database_changed", "publish_uncertain", "secret_published"}
    try:
        entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    except (OSError, json.JSONDecodeError):
        raise RotationPreconditionError("sanitized transition ledger is unavailable") from None
    attempt = next((
        item for item in reversed(entries)
        if item.get("service") == service and item.get("state") in transition_states
    ), None)
    if not isinstance(attempt, dict) or attempt.get("prior_version_id") != expected_prior_version_id:
        raise RotationPreconditionError("latest transition does not match the pinned prior version")
    candidates = {
        value for value in (attempt.get("new_version_id"), attempt.get("request_token"))
        if isinstance(value, str) and value
    }
    return {"prior_version_id": expected_prior_version_id, "new_version_ids": candidates}


def transition_with_clients(
    *,
    service: str,
    username: str,
    secret_arn: str,
    expected_version_id: str,
    current_description: dict,
    current_secret: str,
    new_password: str,
    confirm_current: Callable[[], str],
    set_database_password: Callable[[str, str], None],
    publish_secret: Callable[[str, str, str], dict],
    record: Callable[[dict], None],
    request_token: str | None = None,
) -> str:
    """Run the ordered DB-then-secret transition with injected, testable clients."""
    require_target(service, username)
    diagnostic = {"service": service, "state": "preflight_failed"}
    if current_description.get("ARN") != secret_arn:
        record({**diagnostic, "check": "description_arn", "arn_matches": False})
        raise RotationPreconditionError("secret ARN does not match the fixed service binding")
    if current_description.get("ARN") == secret_arn:
        diagnostic["arn_matches"] = True
    try:
        current_id = current_version_id(current_description)
    except RotationPreconditionError:
        record({**diagnostic, "check": "current_version_metadata"})
        raise
    if current_id != expected_version_id:
        record({**diagnostic, "check": "expected_version", "current_version_id": current_id,
                "expected_version_id": expected_version_id})
        raise RotationPreconditionError("current secret version changed; no write is safe")
    diagnostic.update(current_version_id=current_id, expected_version_id=expected_version_id)
    try:
        payload = json.loads(current_secret)
    except (json.JSONDecodeError, TypeError):
        record({**diagnostic, "check": "username_payload", "username_present": False,
                "username_type": "invalid_json", "username_matches_expected": False})
        raise RotationPreconditionError("runtime secret payload is not valid JSON") from None
    username_present = isinstance(payload, dict) and "username" in payload
    username_value = payload.get("username") if isinstance(payload, dict) else None
    username_type = (
        "null" if username_value is None else
        "boolean" if isinstance(username_value, bool) else
        "string" if isinstance(username_value, str) else
        "number" if isinstance(username_value, (int, float)) else
        "array" if isinstance(username_value, list) else
        "object" if isinstance(username_value, dict) else "missing"
    )
    username_matches = username_present and username_value == username
    if not username_matches:
        record({**diagnostic, "check": "username_payload", "username_present": username_present,
                "username_type": username_type, "username_matches_expected": False})
        raise RotationPreconditionError("runtime secret identity is invalid")
    diagnostic.update(username_present=True, username_type=username_type,
                      username_matches_expected=True)
    replacement = prepare_secret_payload(current_secret, username, new_password)
    if confirm_current() != current_id:
        raise RotationPreconditionError("current secret version changed before database write")

    token = request_token or str(uuid.uuid4())
    try:
        set_database_password(username, new_password)
    except Exception as error:
        event = {"service": service, "prior_version_id": current_id, "request_token": token,
                 "state": "database_uncertain"}
        if isinstance(error, DatabaseWriteFailure):
            event.update(stage=error.stage, sqlstate=error.sqlstate)
        else:
            event.update(stage="unknown", sqlstate=_sqlstate(error))
        record(event)
        raise RotationPreconditionError(sanitized_failure(error)) from None
    record({"service": service, "prior_version_id": current_id, "request_token": token, "state": "database_changed"})
    if confirm_current() != current_id:
        record({"service": service, "prior_version_id": current_id, "request_token": token, "state": "publish_uncertain"})
        raise RotationPreconditionError("current secret version changed after database write; reconcile before publication")
    try:
        result = publish_secret(secret_arn, replacement, token)
    except Exception as error:
        record({"service": service, "prior_version_id": current_id, "request_token": token, "state": "publish_uncertain"})
        raise RotationPreconditionError(sanitized_failure(error)) from None

    version_id = result.get("VersionId") if isinstance(result, dict) else None
    if not isinstance(version_id, str) or not version_id:
        record({"service": service, "prior_version_id": current_id, "request_token": token, "state": "publish_uncertain"})
        raise RotationPreconditionError("secret publication response is incomplete; reconcile before retry")
    record({"service": service, "prior_version_id": current_id, "new_version_id": version_id, "request_token": token, "state": "secret_published"})
    return version_id


def recover_with_observation(
    *,
    service: str,
    secret_version: str,
    prior_version_id: str,
    observed_version_id: str,
    new_version_id: str | None,
    tls_identity: str,
    current_password: str,
    username: str,
    set_database_password: Callable[[str, str], None],
    probe_fresh_tls: Callable[[str, str], bool],
    record: Callable[[dict], None],
) -> str:
    """Choose recovery only after version reconciliation and a fresh TLS identity probe."""
    if username not in {target["username"] for target in TARGETS.values()}:
        raise RotationPreconditionError("unsupported database identity")
    action = decide_recovery(secret_version, tls_identity)
    if action in {
        "prior_pair_verified_stop_transition",
        "new_pair_verified_continue_service_health_and_cleanup",
    }:
        record({"service": service, "state": action, "prior_version_id": prior_version_id,
                "observed_version_id": observed_version_id, "new_version_id": new_version_id})
        if action == "prior_pair_verified_stop_transition":
            return "credencial anterior reconciliada; rotación no completada"
        return action
    if action not in {
        "restore_database_from_prior_secret_then_verify_fresh_tls",
        "restore_database_from_current_secret_then_verify_fresh_tls",
    }:
        record({"service": service, "state": action, "prior_version_id": prior_version_id,
                "observed_version_id": observed_version_id, "new_version_id": new_version_id})
        return action

    try:
        set_database_password(username, current_password)
        verified = probe_fresh_tls(username, current_password)
    except Exception as error:
        record({"service": service, "state": "repair_uncertain", "prior_version_id": prior_version_id,
                "observed_version_id": observed_version_id, "new_version_id": new_version_id,
                "stage": error.stage if isinstance(error, DatabaseWriteFailure) else "unknown",
                "sqlstate": error.sqlstate if isinstance(error, DatabaseWriteFailure) else _sqlstate(error)})
        raise RotationPreconditionError(sanitized_failure(error)) from None
    if not verified:
        record({"service": service, "state": "repair_failed_stop_and_escalate",
                "prior_version_id": prior_version_id, "observed_version_id": observed_version_id,
                "new_version_id": new_version_id})
        return "repair_failed_stop_and_escalate"
    record({"service": service, "state": "matching_pair_restored_and_fresh_tls_verified",
            "prior_version_id": prior_version_id, "observed_version_id": observed_version_id,
            "new_version_id": new_version_id})
    return "matching_pair_restored_and_fresh_tls_verified"


def _ledger_writer() -> Callable[[dict], None]:
    directory = Path.home() / ".local" / "state" / "gootip" / "credential-rotation"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    path = directory / "ledger.ndjson"

    def record(event: dict) -> None:
        safe = {
            key: value
            for key, value in event.items()
            if key in {
                "service", "prior_version_id", "new_version_id", "request_token", "state",
                "observed_version_id",
                "check", "arn_matches", "current_version_id", "expected_version_id",
                "username_present", "username_type", "username_matches_expected",
                "stage", "sqlstate",
            }
        }
        if "stage" in event:
            safe["stage"] = event.get("stage") if event.get("stage") in {
                "connecting", "validating", "executing_function", "confirming_transaction", "unknown"
            } else "unknown"
        if "sqlstate" in event:
            sqlstate = event.get("sqlstate")
            safe["sqlstate"] = sqlstate if isinstance(sqlstate, str) and re.fullmatch(r"[A-Z0-9]{5}", sqlstate) else None
        safe["timestamp"] = datetime.now(timezone.utc).isoformat()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (json.dumps(safe, separators=(",", ":")) + "\n").encode())
        finally:
            os.close(fd)

    return record


def _db_connect(host: str, username: str, password: str):
    import psycopg

    infra_root = Path(__file__).resolve().parents[1]
    ca_path = infra_root / ".db-access" / "rds-ca-bundle.pem"
    if not ca_path.is_file():
        raise RotationPreconditionError("verified RDS CA bundle is unavailable")
    if not re.fullmatch(r"gootip-dev\.[A-Za-z0-9.-]+\.us-east-2\.rds\.amazonaws\.com", host):
        raise RotationPreconditionError("RDS host is not the reviewed regional endpoint")
    return psycopg.connect(
        host=host,
        hostaddr="127.0.0.1",
        port=LOCAL_PORT,
        dbname=DATABASE,
        user=username,
        password=password,
        sslmode="verify-full",
        sslrootcert=str(ca_path),
        connect_timeout=5,
        application_name="gootip-credential-transition",
    )


def _invoke_password_function(connection, username: str, password: str) -> None:
    require_target("auth" if username == "auth_runtime" else "core", username)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT credential_admin.set_runtime_password(%s, %s)",
            (username, password),
        )


def _set_runtime_password(endpoint: str, username: str, password: str, operator_password: str,
                          connection_factory) -> None:
    stage = "connecting"
    try:
        connection = connection_factory(endpoint, OPERATOR_LOGIN, operator_password)
        with connection:
            stage = "validating"
            _verify_logging_gate(connection)
            with connection.cursor() as cursor:
                cursor.execute("SELECT current_user, current_database(), ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
                if cursor.fetchone() != (OPERATOR_LOGIN, DATABASE, True):
                    raise RotationPreconditionError("database operator identity or TLS verification failed")
            stage = "executing_function"
            _invoke_password_function(connection, username, password)
            stage = "confirming_transaction"
            connection.commit()
    except Exception as error:
        raise DatabaseWriteFailure(stage, _sqlstate(error)) from None


def validate_logging_settings(settings: dict[str, str], extensions: set[str]) -> None:
    required = {
        "log_statement", "log_min_duration_statement", "log_min_duration_sample",
        "log_statement_sample_rate", "log_transaction_sample_rate",
        "log_parameter_max_length", "log_parameter_max_length_on_error",
        "password_encryption", "shared_preload_libraries",
        "session_preload_libraries", "local_preload_libraries",
        "track_activity_query_size",
    }
    if not required.issubset(settings):
        raise RotationPreconditionError("PostgreSQL logging configuration is not fully visible")
    if settings["log_parameter_max_length_on_error"] != "0" or settings["password_encryption"] != "scram-sha-256":
        raise RotationPreconditionError("PostgreSQL error-logging or password-encryption setting is unsafe")

    try:
        statement_logging = (
            settings["log_statement"] != "none"
            or int(settings["log_min_duration_statement"]) >= 0
            or (
                int(settings["log_min_duration_sample"]) >= 0
                and float(settings["log_statement_sample_rate"]) > 0
            )
            or float(settings["log_transaction_sample_rate"]) > 0
        )
    except ValueError:
        raise RotationPreconditionError("PostgreSQL statement-logging settings are invalid") from None
    if statement_logging and settings.get("log_parameter_max_length") != "0":
        raise RotationPreconditionError("active statement logging requires bind-parameter logging to be disabled")

    preloads = {
        name.strip()
        for key in ("shared_preload_libraries", "session_preload_libraries", "local_preload_libraries")
        for name in settings[key].split(",")
        if name.strip()
    }
    allowed_preloads = {"rdsutils", "rds_casts", "pg_stat_statements", "pg_tle"}
    if preloads - allowed_preloads:
        raise RotationPreconditionError("unreviewed PostgreSQL preload is present")

    if "pg_stat_statements" in preloads:
        required_stats = {
            "pg_stat_statements.track", "pg_stat_statements.track_utility",
            "track_activity_query_size",
        }
        if not required_stats.issubset(settings):
            raise RotationPreconditionError("pg_stat_statements settings are not fully visible")
        if settings["pg_stat_statements.track"] != "top" or settings["pg_stat_statements.track_utility"] not in {"on", "off"}:
            raise RotationPreconditionError("pg_stat_statements tracking is not safe for credential changes")
        try:
            query_size = int(settings["track_activity_query_size"])
        except ValueError:
            raise RotationPreconditionError("pg_stat_statements query-text size is invalid") from None
        if query_size <= 0:
            raise RotationPreconditionError("pg_stat_statements query-text size is invalid")

    if "pg_tle" in preloads:
        enabled_hooks = {
            name for name, value in settings.items()
            if name.startswith("pgtle.enable_") and value != "off"
        }
        if not {"pgtle.enable_password_check", "pgtle.enable_clientauth"}.issubset(settings):
            raise RotationPreconditionError("pg_tle hook settings are not fully visible")
        if enabled_hooks:
            raise RotationPreconditionError("pg_tle hook is enabled or not fully visible")
    if "pgaudit" in extensions and settings.get("pgaudit.log_parameter") != "off":
        raise RotationPreconditionError("pgAudit parameter logging is not confirmed off")


LOGGING_GATE_QUERY = """
SELECT jsonb_build_object(
  'session', (
    SELECT jsonb_build_object(
      'user', current_user,
      'database', current_database(),
      'ssl', ssl,
      'tls_version', version
    )
    FROM pg_stat_ssl WHERE pid = pg_backend_pid()
  ),
  'settings', (
    SELECT jsonb_object_agg(name, setting)
    FROM pg_settings
    WHERE left(name, 4) = 'log_'
       OR name LIKE 'pgaudit.%'
       OR name LIKE 'pg_stat_statements.%'
       OR name LIKE 'pgtle.%'
       OR name IN (
         'password_encryption', 'shared_preload_libraries',
         'session_preload_libraries', 'local_preload_libraries',
         'track_activity_query_size', 'rds.force_admin_logging_level',
         'rds.force_autovacuum_logging_level'
       )
  ),
  'extensions', (
    SELECT COALESCE(jsonb_agg(extname ORDER BY extname), '[]'::jsonb)
    FROM pg_extension
  )
)
""".strip()


def _verify_logging_gate(connection) -> None:
    with connection.cursor() as cursor:
        cursor.execute(LOGGING_GATE_QUERY)
        result = cursor.fetchone()[0]
    session = result["session"] or {}
    if (session.get("user") != OPERATOR_LOGIN or session.get("database") != DATABASE
            or session.get("ssl") is not True):
        raise RotationPreconditionError("database identity, database, or TLS verification failed")
    settings = result["settings"] or {}
    extensions = set(result["extensions"] or [])
    validate_logging_settings(settings, extensions)
    if "pg_tle" in extensions:
        with connection.cursor() as cursor:
            cursor.execute("SELECT feature::text, proc::regprocedure::text FROM pgtle.feature_info")
            if cursor.fetchall():
                raise RotationPreconditionError("registered pg_tle hook requires explicit code review")


def rotate_with_clients(
    *, service: str, expected_version_id: str, sts_client, secrets_client,
    rds_client, connection_factory, operator_password: str, new_password: str,
    record: Callable[[dict], None],
) -> str:
    """Perform one transition using injected AWS/DB clients; never logs values."""
    require_target(service, TARGETS.get(service, {}).get("username", ""))
    identity = sts_client.get_caller_identity()
    if (
        not re.fullmatch(r"[0-9]{12}", ACCOUNT_ID)
        or identity.get("Account") != ACCOUNT_ID
        or not identity.get("Arn", "").startswith(
            f"arn:aws:sts::{ACCOUNT_ID}:assumed-role/GootipCredentialOperator/"
        )
    ):
        raise RotationPreconditionError("AWS caller is not the fixed credential-operator role")

    binding = TARGETS[service]
    secret_arn = binding["secret_arn"]
    prefix = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT_ID}:secret:gootip-dev-{service}-runtime-"
    if not re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9]{6}", secret_arn):
        raise RotationPreconditionError("the exact dev runtime secret ARN is required")
    description = secrets_client.describe_secret(SecretId=secret_arn)
    if description.get("ARN") != secret_arn:
        raise RotationPreconditionError("secret ARN does not match the fixed service binding")
    current = secrets_client.get_secret_value(SecretId=secret_arn)
    if current.get("ARN") != secret_arn:
        record({"service": service, "state": "preflight_failed", "check": "value_arn",
                "arn_matches": False})
        raise RotationPreconditionError("secret value ARN does not match the fixed service binding")
    description_version = current_version_id(description)
    if current.get("VersionId") != description_version:
        record({"service": service, "state": "preflight_failed", "check": "value_version",
                "arn_matches": True, "current_version_id": current.get("VersionId"),
                "expected_version_id": description_version})
        raise RotationPreconditionError("secret value and AWSCURRENT metadata do not match")
    if not isinstance(current.get("SecretString"), str):
        record({"service": service, "state": "preflight_failed", "check": "username_payload",
                "arn_matches": True, "current_version_id": description_version,
                "expected_version_id": expected_version_id, "username_present": False,
                "username_type": "unavailable", "username_matches_expected": False})
        raise RotationPreconditionError("secret value and AWSCURRENT metadata do not match")
    database = rds_client.describe_db_instances(DBInstanceIdentifier=DB_INSTANCE)["DBInstances"]
    if len(database) != 1 or database[0].get("DBInstanceIdentifier") != DB_INSTANCE:
        raise RotationPreconditionError("expected exactly one fixed database")
    if database[0].get("Engine") != "postgres" or database[0].get("PubliclyAccessible"):
        raise RotationPreconditionError("fixed database engine or network exposure is unexpected")
    if database[0].get("Endpoint", {}).get("Port") != 5432:
        raise RotationPreconditionError("fixed database port is unexpected")
    endpoint = database[0].get("Endpoint", {}).get("Address", "")
    if database[0].get("DBInstanceStatus") != "available":
        raise RotationPreconditionError("fixed database is not available")

    def connect(username: str, password: str):
        if username != OPERATOR_LOGIN:
            raise RotationPreconditionError("unsupported database operator identity")
        return connection_factory(endpoint, username, password)

    def set_password(username: str, password: str) -> None:
        _set_runtime_password(endpoint, username, password, operator_password, connection_factory)

    def confirm() -> str:
        latest = secrets_client.describe_secret(SecretId=secret_arn)
        if latest.get("ARN") != secret_arn:
            raise RotationPreconditionError("secret ARN changed")
        return current_version_id(latest)

    def publish(arn: str, payload: str, token: str) -> dict:
        return secrets_client.put_secret_value(
            SecretId=arn, SecretString=payload, ClientRequestToken=token,
        )

    return transition_with_clients(
        service=service, username=binding["username"], secret_arn=secret_arn,
        expected_version_id=expected_version_id, current_description=description,
        current_secret=current["SecretString"], new_password=new_password,
        confirm_current=confirm, set_database_password=set_password,
        publish_secret=publish, record=record,
    )


def recover_with_clients(
    *, service: str, expected_version_id: str, sts_client, secrets_client,
    rds_client, connection_factory, operator_password: str,
    record: Callable[[dict], None], attempt_versions: dict | None = None,
) -> str:
    """Reconcile the pinned AWSCURRENT pair; repair only an auth mismatch."""
    binding = TARGETS.get(service)
    if binding is None:
        raise RotationPreconditionError("unsupported service")
    identity = sts_client.get_caller_identity()
    if (
        not re.fullmatch(r"[0-9]{12}", ACCOUNT_ID)
        or identity.get("Account") != ACCOUNT_ID
        or not identity.get("Arn", "").startswith(
            f"arn:aws:sts::{ACCOUNT_ID}:assumed-role/GootipCredentialOperator/"
        )
    ):
        raise RotationPreconditionError("AWS caller is not the fixed credential-operator role")
    arn = binding["secret_arn"]
    prefix = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT_ID}:secret:gootip-dev-{service}-runtime-"
    if not re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9]{6}", arn):
        raise RotationPreconditionError("the exact dev runtime secret ARN is required")
    attempt = attempt_versions or _latest_attempt_versions(service, expected_version_id)
    prior_version_id = attempt.get("prior_version_id")
    new_version_ids = set(attempt.get("new_version_ids", ()))
    if prior_version_id != expected_version_id or expected_version_id in new_version_ids:
        raise RotationPreconditionError("recorded transition versions are inconsistent")
    description = secrets_client.describe_secret(SecretId=arn)
    if description.get("ARN") != arn:
        raise RotationPreconditionError("secret ARN does not match the fixed service binding")
    observed_version_id = current_version_id(description)
    if observed_version_id not in {prior_version_id, *new_version_ids}:
        raise RotationPreconditionError("current secret version is not recorded for this transition")
    secret = secrets_client.get_secret_value(SecretId=arn, VersionId=observed_version_id)
    if secret.get("VersionId") != observed_version_id or not isinstance(secret.get("SecretString"), str):
        raise RotationPreconditionError("pinned current secret value is unavailable")
    try:
        payload = json.loads(secret["SecretString"])
    except (json.JSONDecodeError, TypeError):
        raise RotationPreconditionError("runtime secret payload is not valid JSON") from None
    username = binding["username"]
    if not isinstance(payload, dict) or payload.get("username") != username or not isinstance(payload.get("password"), str):
        raise RotationPreconditionError("runtime secret identity or password is invalid")

    database = rds_client.describe_db_instances(DBInstanceIdentifier=DB_INSTANCE)["DBInstances"]
    if len(database) != 1 or database[0].get("DBInstanceIdentifier") != DB_INSTANCE:
        raise RotationPreconditionError("expected exactly one fixed database")
    if database[0].get("Engine") != "postgres" or database[0].get("DBInstanceStatus") != "available" or database[0].get("PubliclyAccessible"):
        raise RotationPreconditionError("fixed database state or network exposure is unexpected")
    endpoint = database[0].get("Endpoint", {}).get("Address", "")
    if database[0].get("Endpoint", {}).get("Port") != 5432:
        raise RotationPreconditionError("fixed database port is unexpected")

    def probe(_username: str, password: str) -> bool:
        try:
            with connection_factory(endpoint, username, password) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT current_user, current_database(), ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
                    row = cursor.fetchone()
                    if row != (username, DATABASE, True):
                        raise RotationPreconditionError("database identity, database, or TLS verification failed")
            return True
        except Exception as error:
            if getattr(error, "sqlstate", None) == "28P01":
                return False
            raise

    def set_password(target_username: str, password: str) -> None:
        latest = secrets_client.describe_secret(SecretId=arn)
        if latest.get("ARN") != arn:
            raise RotationPreconditionError("secret ARN changed before recovery write")
        require_expected_current_version(latest.get("VersionIdsToStages", {}), expected_version_id)
        _set_runtime_password(endpoint, target_username, password, operator_password, connection_factory)

    return recover_with_observation(
        service=service,
        secret_version="prior" if observed_version_id == prior_version_id else "new",
        prior_version_id=prior_version_id,
        observed_version_id=observed_version_id,
        new_version_id=observed_version_id if observed_version_id != prior_version_id else None,
        tls_identity="runtime_identity_verified" if probe(username, payload["password"]) else "password_rejected",
        current_password=payload["password"], username=username,
        set_database_password=set_password, probe_fresh_tls=probe, record=record,
    )


def _live_clients():
    import boto3

    session = boto3.Session(profile_name=OPERATOR_PROFILE, region_name=REGION)
    return session.client("sts"), session.client("secretsmanager"), session.client("rds")


def _live_connection_factory(host: str, username: str, password: str):
    return _db_connect(host, username, password)


def execute_live(service: str, mode: str, expected_version_id: str | None = None) -> int:
    if not LIVE_EXECUTION_ENABLED:
        print("Live credential rotation is disabled; no AWS or PostgreSQL calls were made.", file=sys.stderr)
        return 2

    if mode not in {"rotate", "recover"} or not expected_version_id:
        print("A version-pinned rotate or recover operation is required.", file=sys.stderr)
        return 2
    try:
        sts, secrets_client, rds = _live_clients()
        operator_password = getpass.getpass("Credential-operator database password: ")
        new_password = secrets.token_urlsafe(32) if mode == "rotate" else None
        if mode == "rotate":
            result = rotate_with_clients(
                service=service, expected_version_id=expected_version_id,
                sts_client=sts, secrets_client=secrets_client, rds_client=rds,
                connection_factory=_live_connection_factory,
                operator_password=operator_password, new_password=new_password or "",
                record=_ledger_writer(),
            )
            print(f"Rotation completed; new secret version: {result}")
        else:
            result = recover_with_clients(
                service=service, expected_version_id=expected_version_id,
                sts_client=sts, secrets_client=secrets_client, rds_client=rds,
                connection_factory=_live_connection_factory,
                operator_password=operator_password, record=_ledger_writer(),
            )
            print(f"Recovery completed: {result}")
        return 0
    except Exception as error:
        print(sanitized_failure(error), file=sys.stderr)
        return 2


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) in {2, 3} and args[0] in {"auth", "core"} and args[1] in {"rotate", "recover"}:
        return execute_live(args[0], args[1], args[2] if len(args) == 3 else None)
    print("Usage: credential_rotation_live.py auth|core rotate|recover EXPECTED_VERSION_ID", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
