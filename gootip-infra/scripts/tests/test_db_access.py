#!/usr/bin/env python3
"""Offline command-stub tests for SPEC 05.2 scripts/db_access.sh.

Every test runs against a copied helper plus a fake AWS CLI. No AWS request is
made, and the only secret value is a deterministic test marker. The helper is
run in a temporary repository so its .db-access extraction never touches the
working tree.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import signal
import stat
import subprocess
import tempfile
import time
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
FAKE_AWS = Path(__file__).resolve().parent / "fixtures" / "05.2-db-access" / "fake-aws"

ACCOUNT = "123456789012"
EICE_ID = "eice-0123456789abcdef0"
INSTANCE_ID = "i-0123456789abcdef0"
SUBNET_ID = "subnet-0123456789abcdef0"
VPC_ID = "vpc-0245facc98884efda"
PASSWORD_MARKER = "test-only-password-marker"

TAGS = [
    {"Key": "Name", "Value": "gootip-dev-db-tunnel"},
    {"Key": "project", "Value": "gootip"},
    {"Key": "env", "Value": "dev"},
    {"Key": "managed_by", "Value": "terraform"},
    {"Key": "purpose", "Value": "db-tunnel"},
]

EICE_TAGS = [
    {"Key": "Name", "Value": "gootip-dev-db-eice"},
    {"Key": "project", "Value": "gootip"},
    {"Key": "env", "Value": "dev"},
    {"Key": "managed_by", "Value": "terraform"},
    {"Key": "purpose", "Value": "db-tunnel"},
]


def default_scenario() -> dict:
    return {
        "identity": {
            "Account": ACCOUNT,
            "Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/GootipDatabaseOperator/test-session",
            "UserId": "AROATEST:test-session",
        },
        "eice": [
            {
                "InstanceConnectEndpointId": EICE_ID,
                "State": "create-complete",
                "DnsName": (
                    f"{EICE_ID}.gootip-dev-db-eice."
                    "ec2-instance-connect.us-east-2.amazonaws.com"
                ),
                "SubnetId": SUBNET_ID,
                "VpcId": VPC_ID,
                "Tags": copy.deepcopy(EICE_TAGS),
            }
        ],
        "instances": [
            {
                "InstanceId": INSTANCE_ID,
                "State": {"Name": "stopped"},
                "SubnetId": SUBNET_ID,
                "VpcId": VPC_ID,
                "MetadataOptions": {
                    "HttpTokens": "required",
                    "HttpEndpoint": "enabled",
                },
                "Tags": copy.deepcopy(TAGS),
            }
        ],
        "rds": [
            {
                "DBInstanceIdentifier": "gootip-dev",
                "DBInstanceStatus": "available",
                "PubliclyAccessible": False,
                "Endpoint": {
                    "Address": (
                        "gootip-dev.abcdefghijkl.us-east-2.rds.amazonaws.com"
                    ),
                    "Port": 5432,
                },
                "DBInstanceArn": f"arn:aws:rds:us-east-2:{ACCOUNT}:db:gootip-dev",
                "DBSubnetGroup": {"VpcId": VPC_ID},
            }
        ],
        "secret": {
            "username": "gootip_dev_operator",
            "password": PASSWORD_MARKER,
        },
        "ssh_exit": 0,
    }


class DatabaseAccessEnvironment:
    def __init__(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="gootip-db-access-")
        self.root = Path(self._temporary.name)
        self.scripts = self.root / "scripts"
        self.bin_dir = self.root / "bin"
        self.home = self.root / "home"
        self.scenario_path = self.root / "scenario.json"
        self.log_path = self.root / "aws.log"
        self.scenario = default_scenario()

        self.scripts.mkdir()
        self.bin_dir.mkdir()
        self.home.mkdir()
        for source, destination in (
            (SCRIPTS / "db_access.sh", self.scripts / "db_access.sh"),
            (SCRIPTS / "verify_rds_ca_layer.sh", self.scripts / "verify_rds_ca_layer.sh"),
            (FAKE_AWS, self.bin_dir / "aws"),
        ):
            if not source.exists():
                raise AssertionError(f"Missing test input: {source}")
            destination.write_bytes(source.read_bytes())
        (self.scripts / "db_access.sh").chmod(0o755)
        (self.scripts / "verify_rds_ca_layer.sh").chmod(0o755)
        (self.bin_dir / "aws").chmod(0o755)
        self.write_test_archive()
        self.write_scenario()

    def write_test_archive(self) -> None:
        """Create a deterministic, non-production archive for the verifier."""
        archive = self.root / "rds-ca-layer.zip"
        certificate = (
            "-----BEGIN CERTIFICATE-----\n"
            "TEST-ONLY-NOT-A-REAL-CERTIFICATE\n"
            "-----END CERTIFICATE-----\n"
        ).encode("ascii")
        entry = zipfile.ZipInfo(
            "certs/rds-ca-bundle.pem", date_time=(1980, 1, 1, 0, 0, 0)
        )
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr(entry, certificate)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.root / "rds-ca-layer.zip.sha256").write_text(
            f"{digest}  rds-ca-layer.zip\n", encoding="ascii"
        )

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self._temporary.cleanup()
        return False

    @property
    def helper(self) -> Path:
        return self.scripts / "db_access.sh"

    @property
    def ca_path(self) -> Path:
        return self.root / ".db-access" / "rds-ca-bundle.pem"

    def write_scenario(self) -> None:
        self.scenario_path.write_text(json.dumps(self.scenario), encoding="utf-8")

    def set_scenario(self, **values) -> None:
        self.scenario.update(values)
        self.write_scenario()

    def scenario_instance(self) -> dict:
        return self.scenario["instances"][0]

    def environment(self, extra: dict | None = None) -> dict:
        environment = {
            "HOME": str(self.home),
            "TF_VAR_aws_account_id": ACCOUNT,
            "PATH": f"{self.bin_dir}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
            "GOOTIP_DB_ACCESS_SCENARIO": str(self.scenario_path),
            "GOOTIP_DB_ACCESS_AWS_LOG": str(self.log_path),
        }
        for name in (
            "AWS_PROFILE",
            "AWS_DEFAULT_PROFILE",
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_SECURITY_TOKEN",
        ):
            environment.pop(name, None)
        if extra:
            environment.update({key: str(value) for key, value in extra.items()})
        return environment

    def run(
        self,
        *args: str,
        extra_env: dict | None = None,
        timeout: float = 30.0,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.helper), *args],
            env=self.environment(extra_env),
            cwd=str(self.root),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def spawn(self, *args: str, extra_env: dict | None = None):
        return subprocess.Popen(
            [str(self.helper), *args],
            env=self.environment(extra_env),
            cwd=str(self.root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )

    def invocations(self) -> list[list[str]]:
        if not self.log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def invocations_containing(self, token: str) -> list[list[str]]:
        return [args for args in self.invocations() if token in args]

    def invocation_index(self, token: str) -> int:
        for index, args in enumerate(self.invocations()):
            if token in args:
                return index
        raise AssertionError(f"No AWS invocation contained {token!r}.")


class InvocationContractTests(unittest.TestCase):
    def test_usage_requires_exactly_one_known_command(self):
        with DatabaseAccessEnvironment() as environment:
            for args in ((), ("unknown",), ("info", "extra")):
                with self.subTest(args=args):
                    result = environment.run(*args)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Usage:", result.stderr)
                    self.assertEqual(environment.invocations(), [])

    def test_every_aws_call_uses_the_fixed_profile_and_region(self):
        with DatabaseAccessEnvironment() as environment:
            result = environment.run("info")
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = environment.invocations()
            self.assertTrue(calls)
            for args in calls:
                self.assertIn("--profile", args)
                self.assertIn("gootip-db-operator", args)
                self.assertIn("--region", args)
                self.assertIn("us-east-2", args)


class PortTests(unittest.TestCase):
    def test_default_local_port_is_15432(self):
        with DatabaseAccessEnvironment() as environment:
            result = environment.run("info")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Port: 15432\n", result.stdout)

    def test_valid_local_port_override_is_printed(self):
        with DatabaseAccessEnvironment() as environment:
            result = environment.run(
                "info", extra_env={"GOOTIP_DB_LOCAL_PORT": "65535"}
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Port: 65535\n", result.stdout)

    def test_invalid_local_ports_fail_before_any_aws_call(self):
        for value in ("1023", "65536", "0", "-1", "1.5", "abc", " 15432"):
            with self.subTest(value=value):
                with DatabaseAccessEnvironment() as environment:
                    result = environment.run(
                        "info", extra_env={"GOOTIP_DB_LOCAL_PORT": value}
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("GOOTIP_DB_LOCAL_PORT", result.stderr)
                    self.assertEqual(environment.invocations(), [])


class InfoTests(unittest.TestCase):
    def test_info_prints_only_dbeaver_settings_and_verifies_the_ca(self):
        with DatabaseAccessEnvironment() as environment:
            result = environment.run("info")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Driver: PostgreSQL\n", result.stdout)
            self.assertIn("Host: localhost\n", result.stdout)
            self.assertIn("Port: 15432\n", result.stdout)
            self.assertIn("Database: gootip\n", result.stdout)
            self.assertIn("Username: gootip_dev_operator\n", result.stdout)
            self.assertIn("Authentication: Password from shell command\n", result.stdout)
            self.assertIn(f"Password command: {environment.helper} password\n", result.stdout)
            self.assertIn("Saved password: Disabled\n", result.stdout)
            self.assertIn("SSL mode: verify-full\n", result.stdout)
            self.assertIn(f"CA certificate: {environment.ca_path}\n", result.stdout)
            self.assertIn(
                "Certificate hostname: "
                "gootip-dev.abcdefghijkl.us-east-2.rds.amazonaws.com\n",
                result.stdout,
            )
            self.assertIn("Skip hostname validation: Disabled\n", result.stdout)
            self.assertIn("Verify server certificate: Enabled\n", result.stdout)

            self.assertNotIn(INSTANCE_ID, result.stdout)
            self.assertNotIn(EICE_ID, result.stdout)
            self.assertNotIn(ACCOUNT, result.stdout)
            self.assertNotIn("arn:aws", result.stdout)
            self.assertNotIn(PASSWORD_MARKER, result.stdout)

            self.assertTrue(environment.ca_path.is_file())
            self.assertIn(
                b"-----BEGIN CERTIFICATE-----",
                environment.ca_path.read_bytes(),
            )
            self.assertEqual(
                stat.S_IMODE(environment.ca_path.stat().st_mode),
                0o600,
            )
            self.assertEqual(
                stat.S_IMODE((environment.root / ".db-access").stat().st_mode),
                0o700,
            )

    def test_info_refuses_duplicate_or_unexpected_resources(self):
        cases = []
        duplicate = copy.deepcopy(default_scenario())
        duplicate["instances"].append(copy.deepcopy(duplicate["instances"][0]))
        cases.append(("duplicate instance", duplicate))
        duplicate_eice = copy.deepcopy(default_scenario())
        duplicate_eice["eice"].append(copy.deepcopy(duplicate_eice["eice"][0]))
        cases.append(("duplicate endpoint", duplicate_eice))
        pending = copy.deepcopy(default_scenario())
        pending["instances"][0]["State"]["Name"] = "pending"
        cases.append(("unexpected instance state", pending))
        wrong_tag = copy.deepcopy(default_scenario())
        wrong_tag["instances"][0]["Tags"][-1]["Value"] = "other"
        cases.append(("wrong instance tag", wrong_tag))
        wrong_eice_tag = copy.deepcopy(default_scenario())
        wrong_eice_tag["eice"][0]["Tags"][-1]["Value"] = "other"
        cases.append(("wrong endpoint tag", wrong_eice_tag))

        for label, scenario in cases:
            with self.subTest(label=label):
                with DatabaseAccessEnvironment() as environment:
                    environment.set_scenario(**scenario)
                    result = environment.run("info")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(environment.invocations_containing("start-instances"))

    def test_info_refuses_public_or_instrumented_hosts(self):
        for field, value in (
            ("PublicIpAddress", "203.0.113.10"),
            ("IamInstanceProfile", {"Arn": "arn:aws:iam::123456789012:instance-profile/bad"}),
        ):
            with self.subTest(field=field):
                with DatabaseAccessEnvironment() as environment:
                    environment.scenario_instance()[field] = value
                    environment.write_scenario()
                    result = environment.run("info")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Refusing", result.stderr)

    def test_info_refuses_a_public_database(self):
        with DatabaseAccessEnvironment() as environment:
            environment.scenario["rds"][0]["PubliclyAccessible"] = True
            environment.write_scenario()
            result = environment.run("info")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("publicly accessible", result.stderr)


class ArchiveTests(unittest.TestCase):
    def test_bad_checksum_stops_before_any_instance_action(self):
        with DatabaseAccessEnvironment() as environment:
            (environment.root / "rds-ca-layer.zip.sha256").write_text(
                "0" * 64 + "  rds-ca-layer.zip\n", encoding="utf-8"
            )
            result = environment.run("tunnel")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("did not pass verification", result.stderr)
            self.assertEqual(environment.invocations_containing("start-instances"), [])
            self.assertEqual(
                environment.invocations_containing("ec2-instance-connect"), []
            )


class PasswordTests(unittest.TestCase):
    def test_password_writes_only_the_password_to_stdout(self):
        with DatabaseAccessEnvironment() as environment:
            result = environment.run("password")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, PASSWORD_MARKER + "\n")
            self.assertNotIn("username", result.stdout)
            self.assertNotIn("SecretString", result.stdout)
            self.assertNotIn("arn:aws", result.stdout)
            self.assertNotIn(ACCOUNT, result.stdout)
            calls = environment.invocations_containing("get-secret-value")
            self.assertEqual(len(calls), 1)
            self.assertIn("gootip-dev-db-operator", calls[0])

    def test_password_rejects_a_wrong_username_without_stdout(self):
        with DatabaseAccessEnvironment() as environment:
            environment.set_scenario(
                secret={"username": "someone_else", "password": PASSWORD_MARKER}
            )
            result = environment.run("password")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_password_does_not_print_aws_json_on_secret_error(self):
        with DatabaseAccessEnvironment() as environment:
            environment.set_scenario(secret_error=True)
            result = environment.run("password")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertNotIn(PASSWORD_MARKER, result.stderr)

    def test_password_rejects_a_different_secret_arn(self):
        with DatabaseAccessEnvironment() as environment:
            environment.set_scenario(
                secret_arn=(
                    "arn:aws:secretsmanager:us-east-2:123456789012:"
                    "secret:gootip-dev-auth-runtime-Ab12Cd"
                )
            )
            result = environment.run("password")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")


class IdentityTests(unittest.TestCase):
    def test_wrong_account_or_role_is_rejected_before_discovery(self):
        for identity in (
            {
                "Account": "000000000000",
                "Arn": "arn:aws:sts::000000000000:assumed-role/GootipDatabaseOperator/test",
            },
            {
                "Account": ACCOUNT,
                "Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/OtherRole/test",
            },
        ):
            with self.subTest(arn=identity["Arn"]):
                with DatabaseAccessEnvironment() as environment:
                    environment.set_scenario(identity=identity)
                    result = environment.run("tunnel")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Refusing", result.stderr)
                    self.assertEqual(
                        environment.invocations_containing("describe-instances"), []
                    )
                    self.assertEqual(
                        environment.invocations_containing("start-instances"), []
                    )


class TunnelTests(unittest.TestCase):
    def test_tunnel_starts_tunnels_and_stops_a_host_it_started(self):
        with DatabaseAccessEnvironment() as environment:
            result = environment.run("tunnel")
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = environment.invocations()

            self.assertEqual(
                len(environment.invocations_containing("start-instances")), 1
            )
            self.assertEqual(
                len(environment.invocations_containing("stop-instances")), 1
            )
            self.assertLess(
                environment.invocation_index("start-instances"),
                environment.invocation_index("ec2-instance-connect"),
            )
            self.assertLess(
                environment.invocation_index("ec2-instance-connect"),
                environment.invocation_index("stop-instances"),
            )

            ssh_calls = environment.invocations_containing("ec2-instance-connect")
            self.assertEqual(len(ssh_calls), 1)
            ssh_args = ssh_calls[0]
            self.assertIn("ssh", ssh_args)
            self.assertIn("--instance-id", ssh_args)
            self.assertIn(INSTANCE_ID, ssh_args)
            self.assertIn("--connection-type", ssh_args)
            self.assertIn("eice", ssh_args)
            self.assertIn("--os-user", ssh_args)
            self.assertIn("ec2-user", ssh_args)
            self.assertIn("--ssh-port", ssh_args)
            self.assertIn("22", ssh_args)
            self.assertIn(
                "maxTunnelDuration=3600,endpointId=" + EICE_ID,
                ssh_args,
            )
            self.assertIn(
                "127.0.0.1:15432:"
                "gootip-dev.abcdefghijkl.us-east-2.rds.amazonaws.com:5432",
                ssh_args,
            )
            self.assertFalse(any("StrictHostKeyChecking" in arg for arg in ssh_args))
            self.assertFalse(any("no-verify-ssl" in arg for arg in ssh_args))
            self.assertFalse(any("0.0.0.0" in arg for arg in ssh_args))

            start_call = environment.invocations_containing("start-instances")[0]
            stop_call = environment.invocations_containing("stop-instances")[0]
            self.assertIn(INSTANCE_ID, start_call)
            self.assertIn(INSTANCE_ID, stop_call)

            self.assertIn("Starting the private tunnel host.", result.stderr)
            self.assertIn("Tunnel host is running.", result.stderr)
            self.assertIn("Tunnel host stopped.", result.stderr)
            self.assertEqual(
                len(environment.invocations_containing("instance-running")), 1
            )
            self.assertEqual(
                environment.invocations_containing("instance-status-ok"), []
            )

    def test_tunnel_does_not_stop_a_preexisting_running_host(self):
        with DatabaseAccessEnvironment() as environment:
            environment.scenario_instance()["State"]["Name"] = "running"
            environment.write_scenario()
            result = environment.run("tunnel")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                environment.invocations_containing("start-instances"), []
            )
            self.assertEqual(
                environment.invocations_containing("stop-instances"), []
            )
            self.assertEqual(
                len(environment.invocations_containing("ec2-instance-connect")), 1
            )
            self.assertIn("already running", result.stderr)

    def test_failed_tunnel_after_start_runs_cleanup_stop(self):
        with DatabaseAccessEnvironment() as environment:
            environment.set_scenario(ssh_exit=7)
            result = environment.run("tunnel")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(
                len(environment.invocations_containing("start-instances")), 1
            )
            self.assertEqual(
                len(environment.invocations_containing("stop-instances")), 1
            )

    def test_running_wait_failure_after_start_runs_cleanup_stop(self):
        with DatabaseAccessEnvironment() as environment:
            environment.set_scenario(wait_fail="instance-running")
            result = environment.run("tunnel")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(
                len(environment.invocations_containing("start-instances")), 1
            )
            self.assertEqual(
                len(environment.invocations_containing("stop-instances")), 1
            )
            self.assertEqual(
                environment.invocations_containing("ec2-instance-connect"), []
            )

    def test_tunnel_refuses_duplicate_or_unexpected_hosts_before_start(self):
        for label, mutation in (
            ("duplicate", lambda scenario: scenario["instances"].append(
                copy.deepcopy(scenario["instances"][0])
            )),
            ("pending", lambda scenario: scenario["instances"][0]["State"].update(
                {"Name": "pending"}
            )),
            ("public", lambda scenario: scenario["instances"][0].update(
                {"PublicIpAddress": "203.0.113.10"}
            )),
            ("profile", lambda scenario: scenario["instances"][0].update(
                {"IamInstanceProfile": {"Arn": "arn:aws:iam::123456789012:instance-profile/bad"}}
            )),
        ):
            with self.subTest(label=label):
                with DatabaseAccessEnvironment() as environment:
                    mutation(environment.scenario)
                    environment.write_scenario()
                    result = environment.run("tunnel")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(
                        environment.invocations_containing("start-instances"), []
                    )
                    self.assertEqual(
                        environment.invocations_containing("ec2-instance-connect"), []
                    )

    def test_signal_after_start_stops_the_host(self):
        with DatabaseAccessEnvironment() as environment:
            marker = environment.root / "ssh-started"
            environment.set_scenario(ssh_sleep=30, ssh_marker=str(marker))
            process = environment.spawn("tunnel")
            try:
                deadline = time.monotonic() + 10
                while not marker.exists() and time.monotonic() < deadline:
                    if process.poll() is not None:
                        break
                    time.sleep(0.05)
                self.assertTrue(marker.exists(), "tunnel did not reach the foreground SSH call")
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
                process.communicate(timeout=15)
            finally:
                if process.poll() is None:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                    process.communicate(timeout=5)

            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(
                len(environment.invocations_containing("start-instances")), 1
            )
            self.assertEqual(
                len(environment.invocations_containing("stop-instances")), 1
            )


class StopTests(unittest.TestCase):
    def test_stop_stops_a_running_host(self):
        with DatabaseAccessEnvironment() as environment:
            environment.scenario_instance()["State"]["Name"] = "running"
            environment.write_scenario()
            result = environment.run("stop")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                len(environment.invocations_containing("stop-instances")), 1
            )
            self.assertIn("Tunnel host stopped.", result.stderr)

    def test_stop_leaves_an_already_stopped_host_alone(self):
        with DatabaseAccessEnvironment() as environment:
            result = environment.run("stop")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                environment.invocations_containing("stop-instances"), []
            )
            self.assertIn("already stopped", result.stderr)

    def test_stop_waits_for_a_stopping_host_without_issuing_another_stop(self):
        with DatabaseAccessEnvironment() as environment:
            environment.scenario_instance()["State"]["Name"] = "stopping"
            environment.write_scenario()
            result = environment.run("stop")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                environment.invocations_containing("stop-instances"), []
            )
            self.assertEqual(
                len(environment.invocations_containing("instance-stopped")), 1
            )


if __name__ == "__main__":
    unittest.main()
