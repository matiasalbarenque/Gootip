"""TLS PostgreSQL connection creation and timeouts.

Connections always use ``sslmode=verify-full`` against the shared RDS CA layer,
so libpq verifies both the server certificate chain and the RDS hostname. The
password is passed only to the driver and is never logged. A connection whose
session is not actually encrypted is refused.
"""

from __future__ import annotations

from typing import Any

import psycopg

from .config import Config
from .credentials import Credentials
from .errors import DatabaseError


def connection_parameters(config: Config, credentials: Credentials) -> dict[str, Any]:
    """Return the canonical libpq parameters for a verified connection.

    Exposed so verification tooling can derive deliberate variants (wrong CA,
    mismatched hostname, plaintext) from the same verified baseline.
    """
    return {
        "host": config.db_host,
        "port": config.db_port,
        "dbname": config.db_name,
        "user": credentials.username,
        "password": credentials.password,
        "sslmode": config.ssl_mode,  # verify-full
        "sslrootcert": config.ca_path,
        "connect_timeout": config.connect_timeout_seconds,
        # statement_timeout is applied server-side before the first query.
        "options": f"-c statement_timeout={config.statement_timeout_ms}",
        "application_name": "gootip-db-config",
    }


def connect(config: Config, credentials: Credentials) -> psycopg.Connection:
    """Open a verified, timeout-bounded connection and require TLS.

    The connection is left in autocommit mode so callers can scope atomic work
    with an explicit transaction.

    Raises:
        DatabaseError: if the established session is not TLS-encrypted.
        psycopg.Error: on authentication, TLS, or connectivity failure.
    """
    connection = psycopg.connect(**connection_parameters(config, credentials))
    connection.autocommit = True
    if not connection_is_encrypted(connection):
        connection.close()
        raise DatabaseError("database session is not TLS-encrypted")
    return connection


def connection_is_encrypted(connection: psycopg.Connection) -> bool:
    """Return whether this backend reports its client connection as TLS."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
        row = cursor.fetchone()
    return bool(row and row[0])
