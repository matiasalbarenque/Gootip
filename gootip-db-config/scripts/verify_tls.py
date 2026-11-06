#!/usr/bin/env python3
"""Operator TLS verification for the administrative PostgreSQL connection.

Runs the four SPEC 03 TLS checks against the SPEC 02.2 RDS instance and prints
only PASS/FAIL with a bounded reason (never a credential, hostname, or error
message). Run it from a private client that can reach the database, with the
same environment variables as ``lambda_db_config``:

    PYTHONPATH=src uv run python scripts/verify_tls.py

The plaintext check relies on ``rds.force_ssl = 1`` (server-side), and the
hostname check keeps the real CA while connecting to the real address under a
name the certificate cannot match.
"""

from __future__ import annotations

import socket
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import boto3  # noqa: E402
import psycopg  # noqa: E402

from gootip_db_config import db  # noqa: E402
from gootip_db_config.config import load_config  # noqa: E402
from gootip_db_config.credentials import read_credentials  # noqa: E402


def attempt(parameters: dict[str, Any]) -> tuple[bool, str]:
    """Connect once with the given parameters; return (connected, reason)."""
    try:
        connection = psycopg.connect(**parameters)
    except psycopg.Error as error:
        return False, type(error).__name__
    connection.close()
    return True, "connected"


def main() -> int:
    config = load_config()
    master = read_credentials(boto3.client("secretsmanager"), config.master_secret_arn)
    baseline = db.connection_parameters(config, master)

    checks: list[tuple[str, bool, str]] = []

    # 1. The verified connection must report an encrypted session.
    try:
        connection = db.connect(config, master)
        encrypted = db.connection_is_encrypted(connection)
        connection.close()
        checks.append(("verified connection is encrypted", encrypted, f"ssl={encrypted}"))
    except psycopg.Error as error:
        checks.append(("verified connection is encrypted", False, type(error).__name__))

    # 2. A CA bundle that did not sign the server certificate must be rejected.
    connected, reason = attempt(dict(baseline, sslrootcert="/nonexistent/other-ca.pem"))
    checks.append(("wrong CA is rejected", not connected, reason))

    # 3. A hostname the certificate cannot match must be rejected.
    try:
        hostaddr = socket.gethostbyname(config.db_host)
    except OSError:
        hostaddr = config.db_host
    connected, reason = attempt(
        dict(baseline, host="certificate-mismatch.invalid", hostaddr=hostaddr)
    )
    checks.append(("hostname mismatch is rejected", not connected, reason))

    # 4. A plaintext connection must be refused by rds.force_ssl.
    plaintext = dict(baseline, sslmode="disable")
    plaintext.pop("sslrootcert", None)
    connected, reason = attempt(plaintext)
    checks.append(("non-TLS connection is rejected", not connected, reason))

    for name, passed, reason in checks:
        print(f"[{'PASS' if passed else 'FAIL'}] {name} ({reason})")

    return 0 if all(passed for _, passed, _ in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
