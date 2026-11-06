from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from credential_rotation import (
    RotationPreconditionError,
    decide_recovery,
    main,
    operator_lifecycle,
    prepare_secret_payload,
    recovery_action,
    require_expected_current_version,
    require_target,
    sanitized_failure,
)


class CredentialRotationOfflineTests(unittest.TestCase):
    def test_operator_lifecycle_requires_approved_provisioner_and_starts_disabled(self):
        for actor, approved in (("credential_operator", True), ("credential_provisioner", False)):
            with self.subTest(actor=actor, approved=approved), self.assertRaises(RotationPreconditionError):
                operator_lifecycle("disabled", "activate", actor, approved)
        self.assertEqual(
            operator_lifecycle("disabled", "activate", "credential_provisioner", True),
            "active",
        )
        self.assertEqual(
            operator_lifecycle("active", "disable", "credential_provisioner", True),
            "disabled",
        )
        with self.assertRaises(RotationPreconditionError):
            operator_lifecycle("active", "activate", "credential_provisioner", True)

    def test_only_fixed_runtime_identities_are_accepted(self):
        require_target("auth", "auth_runtime")
        require_target("core", "core_runtime")
        for service, username in (("auth", "gootip_dev_operator"), ("other", "auth_runtime")):
            with self.subTest(service=service, username=username), self.assertRaises(RotationPreconditionError):
                require_target(service, username)

    def test_payload_update_preserves_all_unrelated_fields(self):
        raw = json.dumps({
            "username": "auth_runtime",
            "password": "fictional-old-password",
            "BETTER_AUTH_SECRET_VERSION": 7,
            "BETTER_AUTH_PREVIOUS_SECRETS": [{"version": 6, "value": "fictional-key"}],
            "custom": {"keep": True},
        })
        updated = json.loads(prepare_secret_payload(raw, "auth_runtime", "fictional-new-password"))
        self.assertEqual(updated["password"], "fictional-new-password")
        self.assertEqual(updated["BETTER_AUTH_SECRET_VERSION"], 7)
        self.assertEqual(updated["BETTER_AUTH_PREVIOUS_SECRETS"], [{"version": 6, "value": "fictional-key"}])
        self.assertEqual(updated["custom"], {"keep": True})

    def test_rejects_bad_payload_identity_empty_or_reused_password(self):
        cases = [
            ('{"username":"core_runtime","password":"fictional"}', "auth_runtime", "fictional-new"),
            ('{"username":"auth_runtime","password":"fictional"}', "auth_runtime", ""),
            ('{"username":"auth_runtime","password":"fictional"}', "auth_runtime", "fictional"),
            ('not-json', "auth_runtime", "fictional-new"),
        ]
        for raw, username, password in cases:
            with self.subTest(raw=raw), self.assertRaises(RotationPreconditionError):
                prepare_secret_payload(raw, username, password)

    def test_unexpected_or_concurrent_current_version_blocks_before_write(self):
        with self.assertRaises(RotationPreconditionError):
            require_expected_current_version({"v2": ["AWSCURRENT"], "v1": ["AWSPREVIOUS"]}, "v1")
        with self.assertRaises(RotationPreconditionError):
            require_expected_current_version({"v1": ["AWSCURRENT"], "v2": ["AWSCURRENT"]}, "v1")
        require_expected_current_version({"v1": ["AWSCURRENT"], "v0": ["AWSPREVIOUS"]}, "v1")

    def test_failure_between_database_and_secret_writes_requires_pair_recovery(self):
        self.assertEqual(
            recovery_action("changed", "failed"),
            "stop_and_restore_a_matching_pair_using_the_recorded_prior_version",
        )

    def test_uncertain_write_reconciles_secret_and_tls_before_choosing_recovery(self):
        self.assertEqual(
            recovery_action("changed", "uncertain"),
            "reconcile_secret_version_then_probe_fresh_verified_tls_identity",
        )
        self.assertEqual(
            decide_recovery("new", "runtime_identity_verified"),
            "new_pair_verified_continue_service_health_and_cleanup",
        )
        self.assertEqual(
            decide_recovery("prior", "runtime_identity_verified"),
            "prior_pair_verified_stop_transition",
        )
        self.assertEqual(
            decide_recovery("prior", "password_rejected"),
            "restore_database_from_prior_secret_then_verify_fresh_tls",
        )
        self.assertEqual(
            decide_recovery("new", "password_rejected"),
            "restore_database_from_current_secret_then_verify_fresh_tls",
        )
        self.assertEqual(
            decide_recovery("new", "tls_or_network_failed"),
            "stop_and_escalate_without_credential_write",
        )

    def test_interruption_with_known_secret_failure_uses_prior_version_recovery(self):
        self.assertEqual(
            recovery_action("changed", "failed"),
            "stop_and_restore_a_matching_pair_using_the_recorded_prior_version",
        )

    def test_sanitized_failure_never_includes_exception_text(self):
        error = RuntimeError("fictional-password must-not-appear")
        self.assertNotIn("fictional-password", sanitized_failure(error))

    def test_cli_is_disabled_and_never_accepts_live_arguments(self):
        self.assertEqual(main(), 2)
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parents[1] / "credential_rotation.py"), "--rotate", "auth"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("Live credential rotation is disabled", result.stderr)
        self.assertNotIn("fictional", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
