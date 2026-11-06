#!/usr/bin/env python3
"""Offline contract checks for SPEC 12 scripts/postgresql18_prechecks.sql."""

from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PRECHECKS = ROOT / "scripts" / "postgresql18_prechecks.sql"

FORBIDDEN_KEYWORDS = re.compile(
    r"\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|vacuum|reindex|analyze)\b",
    re.IGNORECASE,
)

REQUIRED_CHECKS = (
    "pg_extension",
    "am.amname = 'hash'",
    "atttypid",
    "pg_replication_slots",
    "pg_prepared_xacts",
    "LIKE 'rds%'",
    "pg_encoding_to_char",
    "datcollate",
    "typtype IN ('e', 'd')",
    "regclass",
    "pg_stat_user_tables",
    "pg_stat_user_indexes",
)


class Postgresql18PrecheckTests(unittest.TestCase):
    def test_prechecks_exist_and_are_read_only(self):
        sql = PRECHECKS.read_text()

        statements = [
            line for line in sql.splitlines()
            if line.strip() and not line.lstrip().startswith("--") and not line.startswith("\\")
        ]
        for statement in statements:
            self.assertIsNone(
                FORBIDDEN_KEYWORDS.search(statement),
                f"Precheck SQL must stay read-only: {statement!r}",
            )
        self.assertIn("SELECT", sql)

    def test_prechecks_cover_the_spec_findings(self):
        sql = PRECHECKS.read_text()

        for check in REQUIRED_CHECKS:
            self.assertIn(check, sql)

    def test_prechecks_document_verified_tls_tunnel(self):
        sql = PRECHECKS.read_text()

        self.assertIn("./scripts/db_access.sh tunnel", sql)
        self.assertIn("sslmode=verify-full", sql)
        self.assertIn("rds-ca-bundle.pem", sql)
        self.assertNotIn("sslmode=disable", sql)
        self.assertNotIn("sslmode=require", sql)


if __name__ == "__main__":
    unittest.main()
