#!/usr/bin/env python3
"""Offline fixtures for the SPEC 02.4 automatic MFA renewal hook.

Every fixture lives in a temporary directory that is deleted when the test
exits. It provides an isolated ``HOME`` with fake ``~/.aws/config`` and
``~/.aws/credentials`` files, plus a fake ``aws`` executable on ``PATH`` that
emits one of the reviewed source-session classifications. No real credential,
token, or account identifier is ever used, and no AWS request is made.
"""

from __future__ import annotations

import errno
import os
import select
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Mapping


FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "02.4-mfa"
FAKE_AWS = FIXTURES_DIR / "fake-aws"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
MFA_HOOK = PROJECT_ROOT / "scripts" / "gootip-mfa.zsh"

# Deterministic, deliberately non-real fixtures. They satisfy the profile shape
# the hook expects and can never be mistaken for live credentials.
FIXTURE_ACCOUNT_ID = "000000000000"
FIXTURE_MFA_ARN = f"arn:aws:iam::{FIXTURE_ACCOUNT_ID}:mfa/gootip-fixture"
FIXTURE_ACCESS_KEY_ID = "AKIAFIXTURE0000000000"
FIXTURE_SECRET_ACCESS_KEY = "fixture-secret-access-key"
FIXTURE_SESSION_TOKEN = "fixture-session-token"

# A source-session verification classification. ``valid`` is the only scenario
# that must be reused without a prompt; ``missing`` and ``expired`` require
# renewal; every other value is an error that must never launch MFA login.
VALID = "valid"
MISSING = "missing"
EXPIRED = "expired"
UNREACHABLE = "unreachable"
DENIED = "denied"
MALFORMED = "malformed"
MISSING_ARN = "missing-arn"
CANCEL = "cancel"

SCENARIOS = (
    VALID,
    MISSING,
    EXPIRED,
    UNREACHABLE,
    DENIED,
    MALFORMED,
    MISSING_ARN,
    CANCEL,
)

# Scenarios whose starting state has a usable ``gootip-mfa`` source profile and
# a configured MFA device ARN unless the scenario deliberately removes one.
SCENARIO_DEFAULTS: Mapping[str, Mapping[str, bool]] = {
    VALID: {"source_profile": True, "mfa_serial": True},
    MISSING: {"source_profile": False, "mfa_serial": True},
    EXPIRED: {"source_profile": True, "mfa_serial": True},
    UNREACHABLE: {"source_profile": True, "mfa_serial": True},
    DENIED: {"source_profile": True, "mfa_serial": True},
    MALFORMED: {"source_profile": True, "mfa_serial": True},
    MISSING_ARN: {"source_profile": False, "mfa_serial": False},
    CANCEL: {"source_profile": True, "mfa_serial": True},
}


@dataclass(frozen=True)
class InteractiveResult:
    """The outcome of running an interactive zsh command under a pty."""

    returncode: int
    output: str


def run_interactive(
    script: str,
    *,
    cwd: Path,
    env: Mapping[str, str],
    timeout: float = 30.0,
) -> InteractiveResult:
    """Run ``zsh -i -c script`` under a pseudo-terminal.

    A pty makes ``[[ -o interactive ]]`` and ``[[ -t 1 ]]`` true, which is the
    real condition the hook checks. No real command or network request is made:
    only the fake ``aws`` CLI on ``PATH`` runs.
    """
    master, slave = os.openpty()
    process = subprocess.Popen(
        ["zsh", "-i", "-c", script],
        cwd=str(cwd),
        env=dict(env),
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)

    chunks: list[bytes] = []
    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                process.kill()
                break
            ready, _, _ = select.select([master], [], [], min(0.2, remaining))
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                chunks.append(data)
            elif process.poll() is not None:
                break
    finally:
        os.close(master)

    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)

    return InteractiveResult(
        returncode=process.returncode if process.returncode is not None else -1,
        output=b"".join(chunks).decode("utf-8", "replace"),
    )


@dataclass(frozen=True)
class MfaEnvironment:
    """A built offline environment ready for a subprocess run."""

    scenario: str
    root: Path
    home: Path
    bin_dir: Path
    config_path: Path
    credentials_path: Path
    log_path: Path
    env: Mapping[str, str]

    def credentials_text(self) -> str:
        return self.credentials_path.read_text()

    def invocations(self) -> list[str]:
        if not self.log_path.exists():
            return []
        return [
            line
            for line in self.log_path.read_text().splitlines()
            if line.strip()
        ]

    def run_aws(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        """Run the fake CLI directly, for fixture self-tests."""
        return subprocess.run(
            ["aws", *arguments],
            env=dict(self.env),
            capture_output=True,
            text=True,
            check=False,
        )


def expected_defaults(scenario: str) -> Mapping[str, bool]:
    if scenario not in SCENARIO_DEFAULTS:
        raise ValueError(f"Unknown MFA test scenario: {scenario}")
    return SCENARIO_DEFAULTS[scenario]


def _config_text(source_profile: bool, mfa_serial: bool) -> str:
    lines = ["[profile gootip-dev]", "region = us-east-2"]
    if mfa_serial:
        lines.append(f"mfa_serial = {FIXTURE_MFA_ARN}")

    if source_profile:
        lines += ["", "[profile gootip-mfa]", "region = us-east-2"]

    lines += [
        "",
        "[profile gootip-bootstrap-admin]",
        "region = us-east-2",
        "source_profile = gootip-mfa",
        f"role_arn = arn:aws:iam::{FIXTURE_ACCOUNT_ID}:role/gootip/bootstrap/GootipBootstrapAdmin",
        "duration_seconds = 10800",
        "",
        "[profile gootip-terraform-deploy]",
        "region = us-east-2",
        "source_profile = gootip-mfa",
        f"role_arn = arn:aws:iam::{FIXTURE_ACCOUNT_ID}:role/gootip/deployment/GootipTerraformDeploy",
        "duration_seconds = 10800",
    ]
    return "\n".join(lines) + "\n"


def _credentials_text(source_profile: bool) -> str:
    blocks = [
        "[gootip-dev]",
        f"aws_access_key_id = {FIXTURE_ACCESS_KEY_ID}",
        f"aws_secret_access_key = {FIXTURE_SECRET_ACCESS_KEY}",
    ]
    if source_profile:
        blocks += [
            "",
            "[gootip-mfa]",
            f"aws_access_key_id = {FIXTURE_ACCESS_KEY_ID}",
            f"aws_secret_access_key = {FIXTURE_SECRET_ACCESS_KEY}",
            f"aws_session_token = {FIXTURE_SESSION_TOKEN}",
        ]
    return "\n".join(blocks) + "\n"


def _base_path(bin_dir: Path | None) -> str:
    """Build a PATH that exposes the fake CLI first and the real tools after."""
    entries = []
    if bin_dir is not None:
        entries.append(str(bin_dir))
    entries.extend(os.environ.get("PATH", "/usr/bin:/bin").split(os.pathsep))
    return os.pathsep.join(entry for entry in entries if entry)


def _without_aws_path() -> str:
    """Return a PATH with every directory that contains an ``aws`` removed."""
    kept = []
    for entry in os.environ.get("PATH", "/usr/bin:/bin").split(os.pathsep):
        if not entry:
            continue
        candidate = Path(entry) / "aws"
        if candidate.exists() and os.access(candidate, os.X_OK):
            continue
        kept.append(entry)
    return os.pathsep.join(kept)


@contextmanager
def mfa_environment(
    scenario: str = VALID,
    *,
    with_aws: bool = True,
    source_profile: bool | None = None,
    mfa_serial: bool | None = None,
    extra_env: Mapping[str, str] | None = None,
) -> Iterator[MfaEnvironment]:
    """Build an isolated AWS environment for one scenario.

    ``source_profile`` and ``mfa_serial`` default from the scenario table and can
    be overridden for targeted cases. ``with_aws=False`` removes the fake CLI so
    tests can prove the hook reports a missing tool instead of prompting.
    """
    defaults = expected_defaults(scenario)
    resolved_source = defaults["source_profile"] if source_profile is None else source_profile
    resolved_serial = defaults["mfa_serial"] if mfa_serial is None else mfa_serial

    with tempfile.TemporaryDirectory(prefix=f"gootip-mfa-{scenario}-") as temporary:
        root = Path(temporary)
        home = root / "home"
        aws_dir = home / ".aws"
        aws_dir.mkdir(parents=True)
        (home / ".zshrc").write_text("")
        bin_dir = root / "bin"
        bin_dir.mkdir()

        if with_aws:
            shutil.copy(FAKE_AWS, bin_dir / "aws")
            (bin_dir / "aws").chmod(0o755)

        config_path = aws_dir / "config"
        credentials_path = aws_dir / "credentials"
        config_path.write_text(_config_text(resolved_source, resolved_serial))
        credentials_path.write_text(_credentials_text(resolved_source))
        log_path = root / "aws.log"

        env = {
            "HOME": str(home),
            "PATH": _base_path(bin_dir) if with_aws else _without_aws_path(),
            "AWS_CONFIG_FILE": str(config_path),
            "AWS_SHARED_CREDENTIALS_FILE": str(credentials_path),
            "AWS_REGION": "us-east-2",
            "AWS_DEFAULT_REGION": "us-east-2",
            "GOOTIP_MFA_TEST_SCENARIO": scenario,
            "GOOTIP_MFA_TEST_LOG": str(log_path),
            "GOOTIP_MFA_TEST_MFA_ARN": FIXTURE_MFA_ARN,
            "GOOTIP_MFA_TEST_ACCESS_KEY_ID": FIXTURE_ACCESS_KEY_ID,
            "GOOTIP_MFA_TEST_SECRET_ACCESS_KEY": FIXTURE_SECRET_ACCESS_KEY,
            "GOOTIP_MFA_TEST_SESSION_TOKEN": FIXTURE_SESSION_TOKEN,
            "TERM": "xterm-256color",
        }
        if extra_env:
            env.update(extra_env)

        yield MfaEnvironment(
            scenario=scenario,
            root=root,
            home=home,
            bin_dir=bin_dir,
            config_path=config_path,
            credentials_path=credentials_path,
            log_path=log_path,
            env=env,
        )
