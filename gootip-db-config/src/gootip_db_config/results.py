"""Safe result formatting and correlation identity.

Only allowlisted, non-sensitive fields leave the function: status, correlation
id, operation, non-sensitive counts, and a bounded error code. Raw errors,
credentials, connection strings, and database values never appear here.
"""

from __future__ import annotations

from typing import Any

STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"

INTERNAL_ERROR = "internal_error"


def correlation_id(context: Any = None) -> str:
    """Return the Lambda request id, or a stable placeholder outside Lambda."""
    return getattr(context, "aws_request_id", None) or "local"


def result(
    *,
    status: str,
    correlation_id: str,
    operation: str | None = None,
    counts: dict[str, int] | None = None,
    error_code: str | None = None,
) -> dict[str, Any]:
    """Build a sanitized response containing only allowlisted fields."""
    body: dict[str, Any] = {"status": status, "correlation_id": correlation_id}
    if operation is not None:
        body["operation"] = operation
    if counts is not None:
        body["counts"] = counts
    if error_code is not None:
        body["error_code"] = error_code
    return body


def failure(correlation_id: str, error_code: str) -> dict[str, Any]:
    """Build a failure response carrying only the bounded error code."""
    return result(status=STATUS_FAILED, correlation_id=correlation_id, error_code=error_code)
