"""AWS Lambda entry point for the Gootip PostgreSQL administrative bootstrap."""

from __future__ import annotations

import logging
from typing import Any

import boto3
import psycopg

from . import db, locking, reconcile
from .config import Config, load_config
from .credentials import Credentials, load_all_credentials
from .errors import BootstrapError, DatabaseError
from .events import validate_event
from .results import INTERNAL_ERROR, STATUS_SUCCEEDED, correlation_id, failure, result

_LOGGER = logging.getLogger(__name__)


def lambda_handler(
    event: dict[str, Any],
    context: Any = None,
    *,
    env: dict[str, str] | None = None,
    secrets_client: Any = None,
) -> dict[str, Any]:
    """Validate one administrative request and return a sanitized result.

    Only the fixed ``bootstrap`` operation is accepted. Database targets, role
    names, schemas, secret ARNs, and the CA path come from validated environment
    configuration, never the event. Configuration and credentials are validated
    before any database work; raw values and errors are never logged or returned.
    """
    correlation = correlation_id(context)
    connection = None
    try:
        operation = validate_event(event)
        config = load_config(env)
        credentials = load_all_credentials(config, secrets_client or boto3.client("secretsmanager"))
        connection = db.connect(config, credentials["master"])
        counts = _reconcile(connection, config, credentials)
    except BootstrapError as error:
        _LOGGER.warning("bootstrap rejected: %s", error.code)
        return failure(correlation, error.code)
    except psycopg.Error as error:
        _LOGGER.error("database operation failed: %s", type(error).__name__)
        return failure(correlation, DatabaseError.code)
    except Exception as error:  # noqa: BLE001 - return a bounded code, never the raw error
        _LOGGER.error("bootstrap failed: %s", type(error).__name__)
        return failure(correlation, INTERNAL_ERROR)
    finally:
        if connection is not None:
            connection.close()

    return result(
        status=STATUS_SUCCEEDED,
        correlation_id=correlation,
        operation=operation,
        counts=counts,
    )


def _reconcile(
    connection: psycopg.Connection, config: Config, credentials: dict[str, Credentials]
) -> dict[str, int]:
    """Serialize on the stable advisory lock and reconcile in one transaction."""
    timeout_seconds = config.lock_acquire_timeout_ms / 1000
    with (
        locking.hold_bootstrap_locks(connection, config.db_name, timeout_seconds),
        connection.transaction(),
    ):
        return reconcile.bootstrap(connection, config, credentials)
