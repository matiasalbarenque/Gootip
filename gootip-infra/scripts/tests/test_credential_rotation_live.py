from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import credential_rotation_live as live
from credential_rotation import RotationPreconditionError

OBSERVED_LOG_SETTINGS = {
    "log_statement": "none",
    "log_min_duration_statement": "-1",
    "log_min_duration_sample": "-1",
    "log_statement_sample_rate": "1",
    "log_transaction_sample_rate": "0",
    "log_parameter_max_length": "-1",
    "log_parameter_max_length_on_error": "0",
    "password_encryption": "scram-sha-256",
    "shared_preload_libraries": "",
    "session_preload_libraries": "",
    "local_preload_libraries": "",
    "pg_stat_statements.track": "top",
    "pg_stat_statements.track_utility": "off",
    "track_activity_query_size": "4096",
    "pgtle.enable_password_check": "off",
    "pgtle.enable_clientauth": "off",
}


class CredentialRotationLiveTests(unittest.TestCase):
    def setUp(self):
        account_id = "123456789012"
        targets = {
            service: {
                "username": f"{service}_runtime",
                "secret_arn": (
                    f"arn:aws:secretsmanager:us-east-2:{account_id}:"
                    f"secret:gootip-dev-{service}-runtime-Ab1Cd2"
                ),
            }
            for service in ("auth", "core")
        }
        self.enterContext(patch.multiple(live, ACCOUNT_ID=account_id, TARGETS=targets))
        self.description = {
            "ARN": live.TARGETS["auth"]["secret_arn"],
            "VersionIdsToStages": {"prior-v1": ["AWSCURRENT"]},
        }
        self.writes = []
        self.events = []

    def run_transition(self, *, confirm_values=("prior-v1", "prior-v1"), publish=None):
        confirmations = iter(confirm_values)
        return live.transition_with_clients(
            service="auth",
            username="auth_runtime",
            secret_arn=live.TARGETS["auth"]["secret_arn"],
            expected_version_id="prior-v1",
            current_description=self.description,
            current_secret=json.dumps({"username": "auth_runtime", "password": "fictional-old"}),
            new_password="fictional-new",
            confirm_current=lambda: next(confirmations),
            set_database_password=lambda user, password: self.writes.append((user, password)),
            publish_secret=publish or (lambda arn, payload, token: {"VersionId": "new-v2"}),
            record=self.events.append,
            request_token="fixed-test-token",
        )

    def test_transition_changes_db_then_publishes_and_records_only_sanitized_metadata(self):
        published = []
        version = self.run_transition(publish=lambda arn, payload, token: (
            published.append((arn, json.loads(payload), token)) or {"VersionId": "new-v2"}
        ))
        self.assertEqual(version, "new-v2")
        self.assertEqual(self.writes, [("auth_runtime", "fictional-new")])
        self.assertEqual(published[0][1], {"username": "auth_runtime", "password": "fictional-new"})
        self.assertEqual(published[0][2], "fixed-test-token")
        self.assertEqual([event["state"] for event in self.events], ["database_changed", "secret_published"])
        self.assertNotIn("password", json.dumps(self.events))

    def test_version_change_after_database_write_stops_before_publication(self):
        publications = []
        with self.assertRaisesRegex(RotationPreconditionError, "after database write"):
            self.run_transition(
                confirm_values=("prior-v1", "other-v2"),
                publish=lambda *args: publications.append(args),
            )
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(publications, [])
        self.assertEqual(self.events[-1]["state"], "publish_uncertain")

    def test_ambiguous_secret_publication_is_redacted_and_not_retried(self):
        def fail(*_args):
            raise RuntimeError("fictional-new must-not-leak")

        with self.assertRaisesRegex(RotationPreconditionError, "operation failed") as raised:
            self.run_transition(publish=fail)
        self.assertNotIn("fictional-new", str(raised.exception))
        self.assertEqual(self.events[-1]["state"], "publish_uncertain")

    def test_wrong_fixed_binding_fails_before_any_write(self):
        self.description["ARN"] = "arn:wrong"
        with self.assertRaises(RotationPreconditionError):
            self.run_transition()
        self.assertEqual(self.writes, [])
        self.assertEqual(self.events[-1]["check"], "description_arn")
        self.assertFalse(self.events[-1]["arn_matches"])

    def test_username_mismatch_records_only_sanitized_preflight_metadata(self):
        with self.assertRaisesRegex(RotationPreconditionError, "identity"):
            live.transition_with_clients(
                service="auth", username="auth_runtime",
                secret_arn=live.TARGETS["auth"]["secret_arn"],
                expected_version_id="prior-v1", current_description=self.description,
                current_secret=json.dumps({"username": "unexpected-user", "password": "do-not-record"}),
                new_password="fictional-new", confirm_current=lambda: "prior-v1",
                set_database_password=lambda *args: self.writes.append(args),
                publish_secret=lambda *args: self.fail("must not publish"), record=self.events.append,
            )
        self.assertEqual(self.writes, [])
        self.assertEqual(self.events, [{
            "service": "auth", "state": "preflight_failed", "arn_matches": True,
            "current_version_id": "prior-v1", "expected_version_id": "prior-v1",
            "check": "username_payload", "username_present": True,
            "username_type": "string", "username_matches_expected": False,
        }])
        self.assertNotIn("unexpected-user", json.dumps(self.events))
        self.assertNotIn("do-not-record", json.dumps(self.events))

    def test_operational_client_flow_checks_identity_tls_and_orders_writes(self):
        trace = []
        sts = Mock(get_caller_identity=lambda: {
            "Account": live.ACCOUNT_ID,
            "Arn": f"arn:aws:sts::{live.ACCOUNT_ID}:assumed-role/GootipCredentialOperator/test-session",
        })
        secrets_client = Mock()
        secrets_client.describe_secret.side_effect = [self.description.copy(), self.description.copy(), self.description.copy()]
        secrets_client.get_secret_value.return_value = {
            "ARN": live.TARGETS["auth"]["secret_arn"],
            "VersionId": "prior-v1",
            "SecretString": json.dumps({"username": "auth_runtime", "password": "fictional-old"}),
        }
        secrets_client.put_secret_value.side_effect = lambda **kwargs: (
            trace.append("publish") or {"VersionId": "new-v2"}
        )

        cursor = Mock()
        cursor.fetchone.side_effect = [({
            "session": {"user": live.OPERATOR_LOGIN, "database": live.DATABASE,
                        "ssl": True, "tls_version": "TLSv1.3"},
            "settings": OBSERVED_LOG_SETTINGS,
            "extensions": ["plpgsql"],
        },), (live.OPERATOR_LOGIN, live.DATABASE, True)]
        connection = Mock()
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        connection.cursor.return_value.__enter__ = Mock(return_value=cursor)
        connection.cursor.return_value.__exit__ = Mock(return_value=False)

        def connect(host, username, password):
            trace.append("connect")
            self.assertRegex(host, r"^gootip-dev\..+\.us-east-2\.rds\.amazonaws\.com$")
            self.assertEqual(username, live.OPERATOR_LOGIN)
            self.assertEqual(password, "fictional-operator-password")
            return connection

        result = live.rotate_with_clients(
            service="auth", expected_version_id="prior-v1", sts_client=sts,
            secrets_client=secrets_client,
            rds_client=Mock(describe_db_instances=lambda **_: {"DBInstances": [{
                "DBInstanceIdentifier": live.DB_INSTANCE,
                "Engine": "postgres",
                "PubliclyAccessible": False,
                "DBInstanceStatus": "available",
                "Endpoint": {"Address": "gootip-dev.example.us-east-2.rds.amazonaws.com", "Port": 5432},
            }]}),
            connection_factory=connect, operator_password="fictional-operator-password",
            new_password="fictional-new", record=lambda event: trace.append(event["state"]),
        )
        self.assertEqual(result, "new-v2")
        self.assertEqual(trace, ["connect", "database_changed", "publish", "secret_published"])
        self.assertEqual(cursor.execute.call_args_list[0].args[0], live.LOGGING_GATE_QUERY)
        self.assertIn("'password_encryption'", live.LOGGING_GATE_QUERY)
        self.assertEqual(connection.commit.call_count, 1)
        self.assertEqual(secrets_client.put_secret_value.call_args.kwargs["SecretId"], live.TARGETS["auth"]["secret_arn"])

    def test_operational_client_flow_rejects_wrong_aws_identity_before_secret_read(self):
        secrets_client = Mock()
        with self.assertRaisesRegex(RotationPreconditionError, "fixed credential-operator role"):
            live.rotate_with_clients(
                service="auth", expected_version_id="prior-v1",
                sts_client=Mock(get_caller_identity=lambda: {"Account": live.ACCOUNT_ID, "Arn": "arn:aws:iam::wrong:user"}),
                secrets_client=secrets_client, rds_client=Mock(), connection_factory=Mock(),
                operator_password="fictional", new_password="fictional-new", record=Mock(),
            )
        secrets_client.describe_secret.assert_not_called()

    def test_operational_client_flow_rejects_value_arn_mismatch_with_sanitized_metadata(self):
        events = []
        description = self.description.copy()
        secrets_client = Mock()
        secrets_client.describe_secret.return_value = description
        secrets_client.get_secret_value.return_value = {
            "ARN": "arn:wrong", "VersionId": "prior-v1", "SecretString": "{}",
        }
        with self.assertRaisesRegex(RotationPreconditionError, "value ARN"):
            live.rotate_with_clients(
                service="auth", expected_version_id="prior-v1",
                sts_client=Mock(get_caller_identity=lambda: {
                    "Account": live.ACCOUNT_ID,
                    "Arn": f"arn:aws:sts::{live.ACCOUNT_ID}:assumed-role/GootipCredentialOperator/test",
                }),
                secrets_client=secrets_client, rds_client=Mock(), connection_factory=Mock(),
                operator_password="fictional", new_password="fictional-new", record=events.append,
            )
        self.assertEqual(events, [{
            "service": "auth", "state": "preflight_failed", "check": "value_arn",
            "arn_matches": False,
        }])
        self.assertNotIn("arn:wrong", json.dumps(events))

    def test_logging_gate_accepts_inert_unlimited_bind_setting_and_sample_rate(self):
        live.validate_logging_settings(OBSERVED_LOG_SETTINGS, {"plpgsql"})

    def test_logging_gate_rejects_only_combinations_that_can_log_bind_values(self):
        active_sampling = OBSERVED_LOG_SETTINGS | {"log_min_duration_sample": "0"}
        with self.assertRaisesRegex(RotationPreconditionError, "active statement logging"):
            live.validate_logging_settings(active_sampling, set())

        protected_sampling = active_sampling | {"log_parameter_max_length": "0"}
        live.validate_logging_settings(protected_sampling, set())

        with self.assertRaisesRegex(RotationPreconditionError, "error-logging"):
            live.validate_logging_settings(
                OBSERVED_LOG_SETTINGS | {"log_parameter_max_length_on_error": "-1"}, set()
            )

        for preload in ("rdsutils", "rds_casts", "pg_stat_statements", "pg_tle"):
            live.validate_logging_settings(
                OBSERVED_LOG_SETTINGS | {"shared_preload_libraries": preload}, set()
            )
        live.validate_logging_settings(
            OBSERVED_LOG_SETTINGS | {
                "shared_preload_libraries": "pg_stat_statements",
                "pg_stat_statements.track_utility": "on",
            }, {"pg_stat_statements"}
        )

        with self.assertRaisesRegex(RotationPreconditionError, "unreviewed PostgreSQL preload"):
            live.validate_logging_settings(
                OBSERVED_LOG_SETTINGS | {"shared_preload_libraries": "rdsutils,unknown_module"}, set()
            )
        with self.assertRaisesRegex(RotationPreconditionError, "pg_stat_statements tracking"):
            live.validate_logging_settings(
                OBSERVED_LOG_SETTINGS | {"shared_preload_libraries": "pg_stat_statements",
                                         "pg_stat_statements.track": "all"}, set()
            )
        with self.assertRaisesRegex(RotationPreconditionError, "pg_tle hook is enabled"):
            live.validate_logging_settings(
                OBSERVED_LOG_SETTINGS | {"shared_preload_libraries": "pg_tle",
                                         "pgtle.enable_password_check": "on"}, set()
            )
        with self.assertRaisesRegex(RotationPreconditionError, "pg_tle hook is enabled"):
            live.validate_logging_settings(
                OBSERVED_LOG_SETTINGS | {"shared_preload_libraries": "pg_tle",
                                         "pgtle.enable_clientauth": "on"}, set()
            )
        with self.assertRaisesRegex(RotationPreconditionError, "fully visible"):
            incomplete_stats = OBSERVED_LOG_SETTINGS | {"shared_preload_libraries": "pg_stat_statements"}
            del incomplete_stats["pg_stat_statements.track_utility"]
            live.validate_logging_settings(incomplete_stats, set())

        with self.assertRaisesRegex(RotationPreconditionError, "pgAudit parameter logging"):
            live.validate_logging_settings(
                OBSERVED_LOG_SETTINGS | {"pgaudit.log_parameter": "on"}, {"plpgsql", "pgaudit"}
            )

        hidden = dict(OBSERVED_LOG_SETTINGS)
        del hidden["shared_preload_libraries"]
        with self.assertRaisesRegex(RotationPreconditionError, "not fully visible"):
            live.validate_logging_settings(hidden, {"plpgsql"})

    def test_logging_gate_requires_empty_readable_tle_feature_registry(self):
        for registered in ([], [("passcheck", "public.hook()")]):
            cursor = Mock()
            cursor.fetchone.return_value = ({
                "session": {"user": live.OPERATOR_LOGIN, "database": live.DATABASE,
                            "ssl": True, "tls_version": "TLSv1.3"},
                "settings": OBSERVED_LOG_SETTINGS | {"shared_preload_libraries": "pg_tle"},
                "extensions": ["plpgsql", "pg_tle"],
            },)
            cursor.fetchall.return_value = registered
            connection = Mock()
            connection.cursor.return_value = nullcontext(cursor)
            if registered:
                with self.assertRaisesRegex(RotationPreconditionError, "registered pg_tle hook"):
                    live._verify_logging_gate(connection)
            else:
                live._verify_logging_gate(connection)

    def test_real_client_constructors_use_fixed_profile_region_and_verify_full_tls(self):
        sts, secrets_client, rds = object(), object(), object()
        session = Mock()
        session.client.side_effect = [sts, secrets_client, rds]
        fake_boto3 = SimpleNamespace(Session=Mock(return_value=session))
        with patch.dict(sys.modules, {"boto3": fake_boto3}):
            self.assertEqual(live._live_clients(), (sts, secrets_client, rds))
        fake_boto3.Session.assert_called_once_with(profile_name=live.OPERATOR_PROFILE, region_name=live.REGION)
        self.assertEqual([call.args[0] for call in session.client.call_args_list], ["sts", "secretsmanager", "rds"])

        connect = Mock(return_value="mock-connection")
        with (
            patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=connect)}),
            patch.object(Path, "is_file", return_value=True),
        ):
            result = live._db_connect(
                "gootip-dev.example.us-east-2.rds.amazonaws.com",
                live.OPERATOR_LOGIN,
                "fictional-password",
            )
        self.assertEqual(result, "mock-connection")
        options = connect.call_args.kwargs
        self.assertEqual(options["sslmode"], "verify-full")
        self.assertEqual(options["hostaddr"], "127.0.0.1")
        self.assertEqual(options["port"], live.LOCAL_PORT)
        self.assertEqual(options["password"], "fictional-password")
        self.assertTrue(options["sslrootcert"].endswith(".db-access/rds-ca-bundle.pem"))

    def test_operational_recovery_repairs_only_a_current_secret_auth_mismatch(self):
        sts = Mock(get_caller_identity=lambda: {
            "Account": live.ACCOUNT_ID,
            "Arn": f"arn:aws:sts::{live.ACCOUNT_ID}:assumed-role/GootipCredentialOperator/test-session",
        })
        secrets_client = Mock()
        secrets_client.describe_secret.return_value = self.description
        secrets_client.get_secret_value.return_value = {
            "VersionId": "prior-v1",
            "SecretString": json.dumps({"username": "auth_runtime", "password": "fictional-current"}),
        }
        trace = []
        calls = 0

        class PasswordRejected(Exception):
            sqlstate = "28P01"

        def connect(_host, username, _password):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise PasswordRejected()
            cursor = Mock()
            cursor.fetchone.side_effect = (
                [({"session": {"user": live.OPERATOR_LOGIN, "database": live.DATABASE,
                               "ssl": True, "tls_version": "TLSv1.3"},
                   "settings": OBSERVED_LOG_SETTINGS, "extensions": ["plpgsql"]},),
                 (username, live.DATABASE, True)]
                if username == live.OPERATOR_LOGIN
                else [(username, live.DATABASE, True)]
            )
            connection = Mock()
            connection.cursor.return_value = nullcontext(cursor)
            connection.__enter__ = Mock(return_value=connection)
            connection.__exit__ = Mock(return_value=False)
            connection.commit.side_effect = lambda: trace.append("db_repaired")
            return connection

        result = live.recover_with_clients(
            service="auth", expected_version_id="prior-v1", sts_client=sts,
            secrets_client=secrets_client,
            rds_client=Mock(describe_db_instances=lambda **_: {"DBInstances": [{
                "DBInstanceIdentifier": live.DB_INSTANCE,
                "Engine": "postgres",
                "PubliclyAccessible": False,
                "DBInstanceStatus": "available",
                "Endpoint": {"Address": "gootip-dev.example.us-east-2.rds.amazonaws.com", "Port": 5432},
            }]}),
            connection_factory=connect, operator_password="fictional-operator",
            record=lambda event: trace.append(event["state"]),
            attempt_versions={"prior_version_id": "prior-v1", "new_version_ids": {"attempt-token"}},
        )
        self.assertEqual(result, "matching_pair_restored_and_fresh_tls_verified")
        self.assertEqual(trace, ["db_repaired", "matching_pair_restored_and_fresh_tls_verified"])
        self.assertEqual(calls, 3)

    def test_disabled_cli_never_calls_aws_or_database(self):
        stderr = io.StringIO()
        with patch.object(live, "LIVE_EXECUTION_ENABLED", False), contextlib.redirect_stderr(stderr):
            result = live.execute_live("auth", "rotate", "prior-v1")
        self.assertEqual(result, 2)
        self.assertIn("Live credential rotation is disabled", stderr.getvalue())
        script = Path(__file__).resolve().parents[1] / "credential_rotation_live.py"
        no_args = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(no_args.returncode, 2)
        self.assertIn("Usage:", no_args.stderr)

    def test_enabled_cli_prompts_privately_then_calls_injected_transition(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        sts, secrets_client, rds = Mock(), Mock(), Mock()
        with (
            patch.object(live, "LIVE_EXECUTION_ENABLED", True),
            patch.object(live, "_live_clients", return_value=(sts, secrets_client, rds)),
            patch.object(live, "_ledger_writer", return_value=Mock()),
            patch.object(live.getpass, "getpass", return_value="fictional-private-input") as prompt,
            patch.object(live, "rotate_with_clients", return_value="fictional-new-version") as rotate,
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr),
        ):
            result = live.execute_live("auth", "rotate", "fictional-prior-version")

        self.assertEqual(result, 0)
        prompt.assert_called_once_with("Credential-operator database password: ")
        self.assertEqual(rotate.call_args.kwargs["operator_password"], "fictional-private-input")
        self.assertEqual(rotate.call_args.kwargs["sts_client"], sts)
        self.assertNotIn("fictional-private-input", stdout.getvalue() + stderr.getvalue())

    def test_recovery_never_writes_after_tls_or_network_failure(self):
        action = live.recover_with_observation(
            service="auth",
            secret_version="prior",
            prior_version_id="prior-v1",
            observed_version_id="prior-v1",
            new_version_id=None,
            tls_identity="tls_or_network_failed",
            current_password="fictional-password",
            username="auth_runtime",
            set_database_password=lambda *args: self.writes.append(args),
            probe_fresh_tls=lambda *_args: self.fail("must not probe after TLS/network failure"),
            record=self.events.append,
        )
        self.assertEqual(action, "stop_and_escalate_without_credential_write")
        self.assertEqual(self.writes, [])

    def test_recovery_restores_only_after_password_rejection_and_checks_fresh_identity(self):
        checks = []
        action = live.recover_with_observation(
            service="auth",
            secret_version="prior",
            prior_version_id="prior-v1",
            observed_version_id="prior-v1",
            new_version_id=None,
            tls_identity="password_rejected",
            current_password="fictional-prior-password",
            username="auth_runtime",
            set_database_password=lambda user, password: self.writes.append((user, password)),
            probe_fresh_tls=lambda user, password: checks.append((user, password)) or True,
            record=self.events.append,
        )
        self.assertEqual(action, "matching_pair_restored_and_fresh_tls_verified")
        self.assertEqual(self.writes, [("auth_runtime", "fictional-prior-password")])
        self.assertEqual(checks, [("auth_runtime", "fictional-prior-password")])

    def test_recovery_reports_prior_pair_without_claiming_rotation_completed(self):
        cursor = Mock()
        cursor.fetchone.return_value = ("auth_runtime", live.DATABASE, True)
        connection = Mock()
        connection.cursor.return_value = nullcontext(cursor)
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        events = []

        result = live.recover_with_clients(
            service="auth", expected_version_id="prior-v1",
            sts_client=Mock(get_caller_identity=lambda: {
                "Account": live.ACCOUNT_ID,
                "Arn": f"arn:aws:sts::{live.ACCOUNT_ID}:assumed-role/GootipCredentialOperator/test",
            }),
            secrets_client=Mock(
                describe_secret=lambda **_: self.description,
                get_secret_value=lambda **kwargs: {
                    "VersionId": kwargs["VersionId"],
                    "SecretString": json.dumps({"username": "auth_runtime", "password": "fictional-current"}),
                },
            ),
            rds_client=Mock(describe_db_instances=lambda **_: {"DBInstances": [{
                "DBInstanceIdentifier": live.DB_INSTANCE, "Engine": "postgres",
                "PubliclyAccessible": False, "DBInstanceStatus": "available",
                "Endpoint": {"Address": "gootip-dev.example.us-east-2.rds.amazonaws.com", "Port": 5432},
            }]}),
            connection_factory=lambda *_: connection, operator_password="fictional-operator",
            record=events.append,
            attempt_versions={"prior_version_id": "prior-v1", "new_version_ids": {"attempt-token"}},
        )

        self.assertEqual(result, "credencial anterior reconciliada; rotación no completada")
        self.assertEqual(events[-1]["state"], "prior_pair_verified_stop_transition")
        self.assertFalse(connection.commit.called)

    def test_recovery_versions_come_from_latest_sanitized_attempt(self):
        with tempfile.TemporaryDirectory() as home:
            ledger = Path(home) / ".local/state/gootip/credential-rotation/ledger.ndjson"
            ledger.parent.mkdir(parents=True)
            ledger.write_text("\n".join(json.dumps(event) for event in (
                {"service": "auth", "state": "database_uncertain", "prior_version_id": "prior-v1",
                 "request_token": "attempt-token"},
                {"service": "auth", "state": "prior_pair_verified_stop_transition"},
                {"service": "core", "state": "database_uncertain", "prior_version_id": "core-v1",
                 "request_token": "core-token"},
            )))
            with patch.object(Path, "home", return_value=Path(home)):
                versions = live._latest_attempt_versions("auth", "prior-v1")
                with self.assertRaises(RotationPreconditionError):
                    live._latest_attempt_versions("auth", "different-prior")
        self.assertEqual(versions, {"prior_version_id": "prior-v1", "new_version_ids": {"attempt-token"}})

    def test_database_write_failure_records_only_safe_stage_and_sqlstate(self):
        class FakeDatabaseError(Exception):
            sqlstate = "42501"

        with self.subTest(stage="connecting"):
            with self.assertRaises(live.DatabaseWriteFailure) as raised:
                def fail_connect(*_):
                    raise FakeDatabaseError("secret value")
                live._set_runtime_password("endpoint", "auth_runtime", "never-record", "private", fail_connect)
            self.assertEqual((raised.exception.stage, raised.exception.sqlstate), ("connecting", "42501"))
            self.assertNotIn("secret value", str(raised.exception))

        def connection_for(stage):
            cursor = Mock()
            cursor.fetchone.return_value = (live.OPERATOR_LOGIN, live.DATABASE, True)
            connection = Mock()
            connection.cursor.return_value = nullcontext(cursor)
            connection.__enter__ = Mock(return_value=connection)
            connection.__exit__ = Mock(return_value=False)
            if stage == "confirming_transaction":
                connection.commit.side_effect = FakeDatabaseError("private value")
            return connection

        for stage in ("validating", "executing_function", "confirming_transaction"):
            with self.subTest(stage=stage):
                connection = connection_for(stage)
                with patch.object(live, "_verify_logging_gate", side_effect=FakeDatabaseError("private value") if stage == "validating" else None):
                    if stage == "executing_function":
                        with patch.object(live, "_invoke_password_function", side_effect=FakeDatabaseError("password and SQL must not leak")):
                            context = self.assertRaises(live.DatabaseWriteFailure)
                            with context as raised:
                                live._set_runtime_password("endpoint", "auth_runtime", "never-record", "private", lambda *_: connection)
                    else:
                        with self.assertRaises(live.DatabaseWriteFailure) as raised:
                            live._set_runtime_password("endpoint", "auth_runtime", "never-record", "private", lambda *_: connection)
                self.assertEqual((raised.exception.stage, raised.exception.sqlstate), (stage, "42501"))
                self.assertNotIn("private value", str(raised.exception))

        with self.assertRaises(RotationPreconditionError):
            live.transition_with_clients(
                service="auth", username="auth_runtime",
                secret_arn=live.TARGETS["auth"]["secret_arn"], expected_version_id="prior-v1",
                current_description=self.description,
                current_secret=json.dumps({"username": "auth_runtime", "password": "fictional-old"}),
                new_password="fictional-new", confirm_current=lambda: "prior-v1",
                set_database_password=lambda *_: (_ for _ in ()).throw(
                    live.DatabaseWriteFailure("executing_function", "42501")
                ),
                publish_secret=lambda *args: self.fail("must not publish"), record=self.events.append,
                request_token="attempt-token",
            )
        self.assertEqual(self.events[-1], {
            "service": "auth", "prior_version_id": "prior-v1", "request_token": "attempt-token",
            "state": "database_uncertain", "stage": "executing_function", "sqlstate": "42501",
        })
        self.assertNotIn("fictional", json.dumps(self.events[-1]))

    def test_ledger_keeps_sqlstate_and_stage_but_drops_error_and_query_text(self):
        with tempfile.TemporaryDirectory() as home:
            with patch.object(Path, "home", return_value=Path(home)):
                live._ledger_writer()({
                    "service": "auth", "state": "database_uncertain",
                    "stage": "executing_function", "sqlstate": "42501",
                    "message": "secret and SQL text", "parameters": ["private-password"],
                    "verifier": "must-not-record",
                })
            ledger = Path(home) / ".local/state/gootip/credential-rotation/ledger.ndjson"
            event = json.loads(ledger.read_text())
        self.assertEqual(event["stage"], "executing_function")
        self.assertEqual(event["sqlstate"], "42501")
        self.assertEqual(set(event), {"service", "state", "stage", "sqlstate", "timestamp"})
        self.assertNotIn("private-password", json.dumps(event))

if __name__ == "__main__":
    unittest.main()
