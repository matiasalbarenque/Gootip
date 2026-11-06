#!/usr/bin/env python3
"""Offline-only validation for the deferred SPEC 10.1 credential rotation."""

from __future__ import annotations

import json
import sys


TARGETS = {
    "auth": "auth_runtime",
    "core": "core_runtime",
}


class RotationPreconditionError(ValueError):
    """A local safety check failed; the message contains no credential data."""


def require_target(service: str, username: str) -> None:
    if service not in TARGETS or TARGETS[service] != username:
        raise RotationPreconditionError("unsupported service or database identity")


def require_expected_current_version(versions: dict, expected_version_id: str) -> None:
    current = [version_id for version_id, stages in versions.items() if "AWSCURRENT" in stages]
    if len(current) != 1 or current[0] != expected_version_id:
        raise RotationPreconditionError("current secret version changed; no write is safe")


def prepare_secret_payload(raw_secret: str, username: str, new_password: str) -> str:
    """Return a replacement JSON payload while preserving every unrelated field."""
    if not isinstance(new_password, str) or not new_password or "\n" in new_password or "\r" in new_password:
        raise RotationPreconditionError("new password is empty or has an unsupported line break")
    try:
        payload = json.loads(raw_secret)
    except (json.JSONDecodeError, TypeError):
        raise RotationPreconditionError("runtime secret payload is not valid JSON") from None
    if (not isinstance(payload, dict) or payload.get("username") != username
            or not isinstance(payload.get("password"), str) or not payload["password"]):
        raise RotationPreconditionError("runtime secret identity or password is invalid")
    if payload["password"] == new_password:
        raise RotationPreconditionError("new password must differ from the current password")
    payload["password"] = new_password
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def recovery_action(database_write: str, secret_write: str) -> str:
    """Classify a sanitized interruption point; never retries a write."""
    valid_database = {"not_started", "changed", "uncertain"}
    valid_secret = {"not_attempted", "committed", "failed", "uncertain"}
    if database_write not in valid_database or secret_write not in valid_secret:
        raise ValueError("unknown transition state")
    if database_write == "not_started" and secret_write == "not_attempted":
        return "no_change"
    if secret_write == "uncertain":
        return "reconcile_secret_version_then_probe_fresh_verified_tls_identity"
    if database_write == "uncertain":
        return "stop_and_reconcile_secret_version_and_fresh_database_identity"
    if database_write == "not_started":
        return "stop_and_reconcile_secret_before_any_database_write"
    if secret_write == "committed":
        return "verify_current_secret_and_fresh_verified_tls_identity"
    return "stop_and_restore_a_matching_pair_using_the_recorded_prior_version"


def decide_recovery(secret_version: str, tls_identity: str) -> str:
    """Choose recovery only after secret-version reconciliation and a fresh TLS probe."""
    valid_versions = {"prior", "new", "other"}
    valid_identities = {"runtime_identity_verified", "password_rejected", "tls_or_network_failed"}
    if secret_version not in valid_versions or tls_identity not in valid_identities:
        raise ValueError("unknown reconciliation result")
    if tls_identity == "tls_or_network_failed":
        return "stop_and_escalate_without_credential_write"
    if tls_identity == "runtime_identity_verified":
        if secret_version == "prior":
            return "prior_pair_verified_stop_transition"
        if secret_version == "new":
            return "new_pair_verified_continue_service_health_and_cleanup"
        return "stop_and_escalate_unknown_secret_version"
    if secret_version == "prior":
        return "restore_database_from_prior_secret_then_verify_fresh_tls"
    if secret_version == "new":
        return "restore_database_from_current_secret_then_verify_fresh_tls"
    return "stop_and_escalate_unknown_secret_version"


def operator_lifecycle(state: str, action: str, actor: str, approved: bool) -> str:
    """Model the gated operator-login lifecycle; this function performs no I/O."""
    if state not in {"disabled", "active"} or action not in {"activate", "disable"}:
        raise ValueError("unknown operator lifecycle state or action")
    if actor != "credential_provisioner" or not approved:
        raise RotationPreconditionError("authorized provisioner approval is required")
    if action == "activate" and state != "disabled":
        raise RotationPreconditionError("operator login is not disabled")
    if action == "disable" and state != "active":
        raise RotationPreconditionError("operator login is not active")
    return "active" if action == "activate" else "disabled"


def sanitized_failure(_error: BaseException) -> str:
    """Do not include SDK/SQL exception text, which may contain submitted values."""
    return "operation failed; inspect the sanitized local transition state"


def main() -> int:
    print(
        "Live credential rotation is disabled. This script provides local validation only.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
