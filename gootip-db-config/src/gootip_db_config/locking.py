"""Stable advisory-lock protocol with bounded acquisition.

One stable lock identity serializes every reconciliation of the same database
and schema; it is never keyed by a run id. The lock is session-scoped and always
released, so a crashed invocation cannot leave the database permanently locked
(dropping the connection releases it).
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager

from psycopg import Connection

from .errors import LockTimeout

_TRY_LOCK = "SELECT pg_try_advisory_lock(%s)"
_UNLOCK = "SELECT pg_advisory_unlock(%s)"
_TRY_CORE_MIGRATION_LOCK = (
    "SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':core', 0))"
)
_UNLOCK_CORE_MIGRATION_LOCK = (
    "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':core', 0))"
)
_POLL_SECONDS = 0.25


def lock_key(database: str, schema: str) -> int:
    """Return the stable signed 64-bit advisory-lock key for a database/schema.

    Derived from the documented identity only, so every invocation of the same
    operation contends on the same key.
    """
    digest = hashlib.sha256(f"{database}.{schema}".encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


@contextmanager
def hold_core_migration_lock(connection: Connection, timeout_seconds: float) -> Iterator[None]:
    """Contend on the exact session lock used by Core's TypeORM migration runner."""
    deadline = time.monotonic() + timeout_seconds
    while not connection.execute(_TRY_CORE_MIGRATION_LOCK).fetchone()[0]:
        if time.monotonic() >= deadline:
            raise LockTimeout("Core migration lock acquisition timed out")
        time.sleep(_POLL_SECONDS)
    try:
        yield
    finally:
        if not connection.execute(_UNLOCK_CORE_MIGRATION_LOCK).fetchone()[0]:
            raise RuntimeError("Core migration lock was not held")


@contextmanager
def hold_bootstrap_locks(
    connection: Connection, database: str, timeout_seconds: float
) -> Iterator[None]:
    """Acquire Auth admin, Core admin, then TypeORM Core locks; release in reverse."""
    with ExitStack() as stack:
        stack.enter_context(hold_lock(connection, lock_key(database, "auth"), timeout_seconds))
        stack.enter_context(hold_lock(connection, lock_key(database, "core"), timeout_seconds))
        stack.enter_context(hold_core_migration_lock(connection, timeout_seconds))
        yield


@contextmanager
def hold_lock(connection: Connection, key: int, timeout_seconds: float) -> Iterator[None]:
    """Acquire the advisory lock within a deadline, then release it.

    Raises:
        LockTimeout: if another session still holds the lock at the deadline.
    """
    deadline = time.monotonic() + timeout_seconds
    while not connection.execute(_TRY_LOCK, (key,)).fetchone()[0]:
        if time.monotonic() >= deadline:
            raise LockTimeout("advisory lock acquisition timed out")
        time.sleep(_POLL_SECONDS)
    try:
        yield
    finally:
        connection.execute(_UNLOCK, (key,))
