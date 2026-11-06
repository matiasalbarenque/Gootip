"""Secrets Manager loading and credential validation.

Every operation reads the current secret values, so a warm environment never
reuses a credential cached before an RDS-managed master password rotation. Role
secrets are validated against their expected username before any SQL mutation.
Values are never logged or returned.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import boto3

from .config import Config
from .errors import InvalidSecret


@dataclass(frozen=True)
class Credentials:
    """A validated database username/password pair."""

    username: str
    password: str


def read_credentials(
    client: Any, secret_arn: str, expected_username: str | None = None
) -> Credentials:
    """Read and validate a JSON secret with ``username`` and ``password``.

    Raises:
        InvalidSecret: if the value is missing, not a JSON object with both
            fields, or (when ``expected_username`` is given) names another role.
    """
    response = client.get_secret_value(SecretId=secret_arn)
    payload = response.get("SecretString")
    if not payload:
        raise InvalidSecret("secret has no string value")

    try:
        data = json.loads(payload)
    except ValueError:
        raise InvalidSecret("secret value is not valid JSON") from None
    if not isinstance(data, dict):
        raise InvalidSecret("secret value is not a JSON object")

    username = data.get("username")
    password = data.get("password")
    if not username or not password:
        raise InvalidSecret("secret must contain username and password")
    if expected_username is not None and username != expected_username:
        raise InvalidSecret("secret username does not match the expected role")

    return Credentials(username=username, password=password)


def load_all_credentials(config: Config, client: Any = None) -> dict[str, Credentials]:
    """Read the master and all role secrets, validating each role's username."""
    client = client or boto3.client("secretsmanager")
    return {
        "master": read_credentials(client, config.master_secret_arn),
        config.runtime_role: read_credentials(
            client, config.runtime_secret_arn, config.runtime_role
        ),
        config.migrator_role: read_credentials(
            client, config.migrator_secret_arn, config.migrator_role
        ),
        config.operator_role: read_credentials(
            client, config.operator_secret_arn, config.operator_role
        ),
        config.core_runtime_role: read_credentials(
            client, config.core_runtime_secret_arn, config.core_runtime_role
        ),
        config.core_migrator_role: read_credentials(
            client, config.core_migrator_secret_arn, config.core_migrator_role
        ),
    }
