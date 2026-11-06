#!/usr/bin/env python3
"""Self-tests for the SPEC 02.4 offline MFA fixtures.

These tests prove the fixtures themselves are deterministic, isolated, and
credential-free before the interactive hook relies on them.
"""

from __future__ import annotations

import json
import shutil
import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import mfa_fixtures as fixtures  # noqa: E402


class IsolationTests(unittest.TestCase):
    def test_environment_never_inherits_real_aws_credentials(self):
        with fixtures.mfa_environment() as environment:
            for forbidden in (
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
                "AWS_SECURITY_TOKEN",
                "AWS_PROFILE",
            ):
                self.assertNotIn(forbidden, environment.env)

    def test_credentials_are_deterministic_fixtures(self):
        with fixtures.mfa_environment() as environment:
            text = environment.credentials_text()
            self.assertIn(fixtures.FIXTURE_ACCESS_KEY_ID, text)
            self.assertIn(fixtures.FIXTURE_SESSION_TOKEN, text)
            self.assertNotIn("AKIAIOSFODNN7EXAMPLE", text)

    def test_home_is_a_temporary_directory(self):
        with fixtures.mfa_environment() as environment:
            self.assertTrue(environment.home.is_dir())
            self.assertTrue(str(environment.home).startswith(str(environment.root)))

    def test_missing_tool_environment_has_no_aws_on_path(self):
        with fixtures.mfa_environment(with_aws=False) as environment:
            self.assertIsNone(
                shutil.which("aws", path=environment.env["PATH"])
            )


class SourceSessionClassificationTests(unittest.TestCase):
    def classify(self, scenario: str):
        with fixtures.mfa_environment(scenario) as environment:
            return environment.run_aws(
                "sts", "get-caller-identity", "--profile", "gootip-mfa", "--output", "json"
            )

    def test_valid_session_returns_the_fixture_identity(self):
        result = self.classify(fixtures.VALID)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            json.loads(result.stdout)["Account"], fixtures.FIXTURE_ACCOUNT_ID
        )

    def test_missing_session_is_reported_as_missing_profile(self):
        result = self.classify(fixtures.MISSING)
        self.assertEqual(result.returncode, 255)
        self.assertIn("could not be found", result.stderr)

    def test_expired_session_is_reported_as_expired_token(self):
        result = self.classify(fixtures.EXPIRED)
        self.assertEqual(result.returncode, 255)
        self.assertIn("ExpiredToken", result.stderr)

    def test_unreachable_session_is_a_network_error(self):
        result = self.classify(fixtures.UNREACHABLE)
        self.assertEqual(result.returncode, 255)
        self.assertIn("Could not connect", result.stderr)

    def test_denied_session_is_an_access_error(self):
        result = self.classify(fixtures.DENIED)
        self.assertEqual(result.returncode, 255)
        self.assertIn("AccessDenied", result.stderr)

    def test_malformed_session_is_an_invalid_credential_error(self):
        result = self.classify(fixtures.MALFORMED)
        self.assertEqual(result.returncode, 255)
        self.assertIn("InvalidClientTokenId", result.stderr)


class SerialLookupTests(unittest.TestCase):
    def test_configured_serial_is_returned(self):
        with fixtures.mfa_environment() as environment:
            result = environment.run_aws(
                "configure", "get", "mfa_serial", "--profile", "gootip-dev"
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), fixtures.FIXTURE_MFA_ARN)

    def test_missing_serial_lookup_fails_without_output(self):
        with fixtures.mfa_environment(fixtures.MISSING_ARN) as environment:
            result = environment.run_aws(
                "configure", "get", "mfa_serial", "--profile", "gootip-dev"
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout.strip(), "")


def credentials_section(text: str, name: str) -> str:
    """Return one INI section's body, ignoring surrounding blank lines."""
    collected: list[str] = []
    capturing = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if capturing:
                break
            capturing = stripped == f"[{name}]"
            continue
        if capturing:
            collected.append(line)
    return "\n".join(line for line in collected if line.strip())


class LoginSimulationTests(unittest.TestCase):
    def test_successful_login_updates_only_the_target_profile(self):
        with fixtures.mfa_environment(fixtures.MISSING) as environment:
            before = environment.credentials_text()
            result = environment.run_aws(
                "configure",
                "mfa-login",
                "--profile",
                "gootip-dev",
                "--duration-seconds",
                "10800",
                "--update-profile",
                "gootip-mfa",
                "--serial-number",
                fixtures.FIXTURE_MFA_ARN,
            )
            self.assertEqual(result.returncode, 0)
            after = environment.credentials_text()

            self.assertEqual(
                credentials_section(before, "gootip-dev"),
                credentials_section(after, "gootip-dev"),
            )
            self.assertTrue(credentials_section(after, "gootip-mfa"))
            self.assertIn(fixtures.FIXTURE_SESSION_TOKEN, after)

    def test_cancelled_login_fails_and_leaves_credentials_unchanged(self):
        with fixtures.mfa_environment(fixtures.CANCEL) as environment:
            before = environment.credentials_text()
            result = environment.run_aws(
                "configure",
                "mfa-login",
                "--profile",
                "gootip-dev",
                "--duration-seconds",
                "10800",
                "--update-profile",
                "gootip-mfa",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(before, environment.credentials_text())

    def test_invocations_are_recorded(self):
        with fixtures.mfa_environment(fixtures.VALID) as environment:
            environment.run_aws("sts", "get-caller-identity", "--profile", "gootip-mfa")
            self.assertEqual(len(environment.invocations()), 1)
            self.assertIn("get-caller-identity", environment.invocations()[0])
            self.assertIn("gootip-mfa", environment.invocations()[0])


if __name__ == "__main__":
    unittest.main()
