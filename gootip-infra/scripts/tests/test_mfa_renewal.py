#!/usr/bin/env python3
"""Offline tests for the SPEC 02.4 interactive MFA renewal hook.

Every test runs ``scripts/gootip-mfa.zsh`` in an isolated temporary HOME with a
fake ``aws`` CLI on ``PATH``. No credential, token, account identifier, or
network request is used.
"""

from __future__ import annotations

import shlex
import subprocess
import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import mfa_fixtures as fixtures  # noqa: E402


HOOK = shlex.quote(str(fixtures.MFA_HOOK))
ROOT = shlex.quote(str(fixtures.PROJECT_ROOT))
INHERITED = {
    "AWS_PROFILE": "inherited-profile",
    "AWS_ACCESS_KEY_ID": "inherited-key",
    "AWS_SECRET_ACCESS_KEY": "inherited-secret",
    "AWS_SESSION_TOKEN": "inherited-token",
    "AWS_SECURITY_TOKEN": "inherited-security-token",
}


def enter_from_outside(extra: str = "") -> str:
    script = f"source {HOOK}\ncd {ROOT}\n"
    return script + extra


def run_interactive(environment, script: str, *, inside: bool = False):
    cwd = fixtures.PROJECT_ROOT if inside else environment.home
    return fixtures.run_interactive(script, cwd=cwd, env=environment.env)


def run_noninteractive(environment, script: str):
    return subprocess.run(
        ["zsh", "-c", script],
        cwd=str(environment.home),
        env=dict(environment.env),
        capture_output=True,
        text=True,
        check=False,
    )


def login_calls(environment):
    return [line for line in environment.invocations() if "mfa-login" in line]


def verify_calls(environment):
    return [line for line in environment.invocations() if "get-caller-identity" in line]


class EntryTransitionTests(unittest.TestCase):
    def test_valid_session_is_reused_without_prompting(self):
        with fixtures.mfa_environment(fixtures.VALID) as environment:
            result = run_interactive(environment, enter_from_outside())
            self.assertEqual(result.returncode, 0)
            self.assertEqual(len(verify_calls(environment)), 1)
            self.assertEqual(login_calls(environment), [])
            self.assertNotIn("renewed", result.output)

    def test_missing_session_renews_exactly_once_with_reviewed_arguments(self):
        with fixtures.mfa_environment(fixtures.MISSING) as environment:
            result = run_interactive(environment, enter_from_outside())
            self.assertEqual(len(verify_calls(environment)), 1)
            logins = login_calls(environment)
            self.assertEqual(len(logins), 1)
            for fragment in (
                "--profile gootip-dev",
                "--duration-seconds 10800",
                "--update-profile gootip-mfa",
                f"--serial-number {fixtures.FIXTURE_MFA_ARN}",
            ):
                self.assertIn(fragment, logins[0])
            self.assertIn("renewed", result.output)

    def test_expired_session_renews_exactly_once(self):
        with fixtures.mfa_environment(fixtures.EXPIRED) as environment:
            result = run_interactive(environment, enter_from_outside())
            self.assertEqual(len(verify_calls(environment)), 1)
            self.assertEqual(len(login_calls(environment)), 1)
            self.assertIn("renewed", result.output)

    def test_verification_targets_the_source_session_only(self):
        with fixtures.mfa_environment(fixtures.VALID) as environment:
            run_interactive(environment, enter_from_outside())
            self.assertIn("--profile gootip-mfa", verify_calls(environment)[0])

    def test_descendant_moves_do_not_trigger_another_check(self):
        with fixtures.mfa_environment(fixtures.VALID) as environment:
            script = enter_from_outside(f"cd {ROOT}/scripts\ncd {ROOT}/bootstrap\n")
            run_interactive(environment, script)
            self.assertEqual(len(verify_calls(environment)), 1)

    def test_shell_starting_inside_the_tree_checks_once(self):
        with fixtures.mfa_environment(fixtures.VALID) as environment:
            result = run_interactive(environment, f"source {HOOK}\n", inside=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(len(verify_calls(environment)), 1)


class UncertainFailureTests(unittest.TestCase):
    def test_network_access_and_malformed_errors_never_launch_login(self):
        for scenario in (fixtures.UNREACHABLE, fixtures.DENIED, fixtures.MALFORMED):
            with self.subTest(scenario=scenario):
                with fixtures.mfa_environment(scenario) as environment:
                    result = run_interactive(environment, enter_from_outside())
                    self.assertEqual(len(verify_calls(environment)), 1)
                    self.assertEqual(login_calls(environment), [])
                    self.assertIn("could not verify", result.output)
                    self.assertIn("not launching MFA login", result.output)

    def test_missing_device_arn_gives_a_setup_instruction(self):
        with fixtures.mfa_environment(fixtures.MISSING_ARN) as environment:
            result = run_interactive(environment, enter_from_outside())
            self.assertEqual(len(verify_calls(environment)), 1)
            self.assertEqual(login_calls(environment), [])
            self.assertIn("no MFA device ARN is configured", result.output)
            self.assertIn("aws configure set mfa_serial", result.output)

    def test_missing_aws_cli_reports_instead_of_prompting(self):
        with fixtures.mfa_environment(fixtures.EXPIRED, with_aws=False) as environment:
            result = run_interactive(environment, enter_from_outside())
            self.assertEqual(result.returncode, 0)
            self.assertIn("not on PATH", result.output)
            self.assertIn("not launching MFA login", result.output)


class CancellationTests(unittest.TestCase):
    def test_cancelled_renewal_is_reported_without_claiming_success(self):
        with fixtures.mfa_environment(fixtures.CANCEL) as environment:
            result = run_interactive(environment, enter_from_outside())
            self.assertEqual(len(login_calls(environment)), 1)
            self.assertIn("failed or was cancelled", result.output)
            self.assertNotIn("renewed", result.output)
            self.assertEqual(result.returncode, 0)


class NonInteractiveTests(unittest.TestCase):
    def test_non_interactive_shell_never_calls_aws(self):
        with fixtures.mfa_environment(fixtures.EXPIRED) as environment:
            run_noninteractive(environment, enter_from_outside())
            self.assertEqual(environment.invocations(), [])

    def test_ci_environment_is_skipped(self):
        with fixtures.mfa_environment(
            fixtures.EXPIRED, extra_env={"CI": "true"}
        ) as environment:
            run_interactive(environment, enter_from_outside())
            self.assertEqual(environment.invocations(), [])

    def test_direnv_envrc_evaluation_is_skipped(self):
        with fixtures.mfa_environment(
            fixtures.EXPIRED, extra_env={"DIRENV_IN_ENVRC": "1"}
        ) as environment:
            run_interactive(environment, enter_from_outside())
            self.assertEqual(environment.invocations(), [])


class EnvironmentIsolationTests(unittest.TestCase):
    def test_inherited_credentials_are_removed_for_every_child_call(self):
        with fixtures.mfa_environment(
            fixtures.EXPIRED, extra_env=INHERITED
        ) as environment:
            run_interactive(environment, enter_from_outside())
            self.assertTrue(environment.invocations())
            for line in environment.invocations():
                self.assertIn("[env:clean]", line)

    def test_parent_shell_variables_are_not_modified(self):
        with fixtures.mfa_environment(
            fixtures.EXPIRED, extra_env=INHERITED
        ) as environment:
            probe = (
                'print -r -- "PARENT:'
                "$AWS_PROFILE:$AWS_ACCESS_KEY_ID:$AWS_SESSION_TOKEN"
                '"\n'
            )
            result = run_interactive(environment, enter_from_outside(probe))
            self.assertIn(
                "PARENT:inherited-profile:inherited-key:inherited-token",
                result.output,
            )


class ManualRefreshTests(unittest.TestCase):
    def test_refresh_renews_without_verifying(self):
        with fixtures.mfa_environment(fixtures.VALID) as environment:
            result = run_interactive(environment, f"source {HOOK}\ngootip-mfa-refresh\n")
            self.assertEqual(verify_calls(environment), [])
            self.assertEqual(len(login_calls(environment)), 1)
            self.assertIn("renewed", result.output)

    def test_refresh_reports_cancellation(self):
        with fixtures.mfa_environment(fixtures.CANCEL) as environment:
            result = run_interactive(environment, f"source {HOOK}\ngootip-mfa-refresh\n")
            self.assertIn("failed or was cancelled", result.output)
            self.assertNotIn("renewed", result.output)


if __name__ == "__main__":
    unittest.main()
