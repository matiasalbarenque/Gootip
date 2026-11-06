"""Fixed event validation.

The event may only name the single supported operation. Database targets, role
names, schemas, passwords, secret ARNs, and SQL come from configuration, so any
field outside the contract is rejected rather than ignored.
"""

from __future__ import annotations

from typing import Any

from .errors import InvalidEvent

BOOTSTRAP_OPERATION = "bootstrap"

_ALLOWED_FIELDS = frozenset({"operation"})


def validate_event(event: Any) -> str:
    """Return the requested operation, or raise :class:`InvalidEvent`.

    Raises:
        InvalidEvent: if the event is not a mapping, carries a field outside the
            fixed contract, or names an operation other than ``bootstrap``.
    """
    if not isinstance(event, dict):
        raise InvalidEvent("event must be a JSON object")

    unexpected = sorted(set(event) - _ALLOWED_FIELDS)
    if unexpected:
        raise InvalidEvent(f"unexpected event fields: {unexpected}")

    operation = event.get("operation")
    if operation != BOOTSTRAP_OPERATION:
        raise InvalidEvent(f"only the {BOOTSTRAP_OPERATION!r} operation is supported")

    return operation
