"""Typed, sanitized errors for the administrative bootstrap.

Every error exposes a fixed ``code`` that is safe to log and return. Messages may
name a missing or invalid field, but must never contain a secret value, password,
credential, or connection string.
"""

from __future__ import annotations


class BootstrapError(Exception):
    """Base class for every expected administrative bootstrap failure."""

    code = "internal_error"


class InvalidEvent(BootstrapError):
    """The event is outside the fixed invocation contract."""

    code = "invalid_event"


class InvalidConfiguration(BootstrapError):
    """Required environment configuration is missing or unsafe."""

    code = "invalid_configuration"


class InvalidSecret(BootstrapError):
    """A Secrets Manager value is missing, malformed, or the wrong identity."""

    code = "invalid_secret"


class DatabaseError(BootstrapError):
    """A database connection or session failed a required safety check."""

    code = "database_error"


class LockTimeout(BootstrapError):
    """The stable advisory lock could not be acquired within its deadline."""

    code = "lock_timeout"
