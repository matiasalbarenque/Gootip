#!/usr/bin/env python3
"""Bounded SPEC 10.1 request scheduling and private campaign accounting."""

from __future__ import annotations

import fcntl
import argparse
import fnmatch
import getpass
import http.cookiejar
import json
import math
import os
import re
import secrets
import signal
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable


def stop_reason(
    *,
    monitor_available: bool,
    connections: int | None,
    unexpected_5xx_streak: int,
    p95_ms: float | None = None,
    p95_over_limit_seconds: int = 0,
) -> str | None:
    if not monitor_available or connections is None:
        return "sql_monitor_unavailable"
    if connections >= 50:
        return "sql_connection_cutoff"
    if unexpected_5xx_streak >= 3:
        return "unexpected_5xx_streak"
    if p95_ms is not None and p95_ms > 2000 and p95_over_limit_seconds >= 30:
        return "successful_request_p95_cutoff"
    return None


def advance_schedule_slot(next_slot: float, now: float, interval: float) -> float:
    next_slot += interval
    return now + interval if next_slot <= now else next_slot


class CampaignLedger:
    """Serialize every request reservation across processes before sending it."""

    def __init__(self, path: Path, campaign_id: str, approved_cap: int):
        if not campaign_id or approved_cap <= 0:
            raise ValueError("campaign ID and positive approved cap are required")
        self.path = path
        self.lock_path = path.with_suffix(path.suffix + ".lock")
        self.campaign_id = campaign_id
        self.approved_cap = approved_cap

    def initialize(self, metadata: dict) -> None:
        with self._locked():
            if self.path.exists():
                raise RuntimeError("campaign report already exists; refusing to overwrite")
            self._save({
                **metadata,
                "campaign_id": self.campaign_id,
                "approved_campaign_cap": self.approved_cap,
                "campaign_requests_used": 0,
                "campaign_requests_remaining": self.approved_cap,
                "requests": [],
            })

    def resume(self, *, authorized_until: str, bindings: dict, limiter_probe_cap: int) -> None:
        with self._locked():
            data = self._load()
            requests = data.get("requests")
            used = data.get("campaign_requests_used")
            remaining = data.get("campaign_requests_remaining")
            if (data.get("status") != "pending"
                    or not isinstance(requests, list)
                    or used != len(requests)
                    or remaining != self.approved_cap - used
                    or used > self.approved_cap
                    or any(row.get("number") != index or row.get("status_code") is None
                           for index, row in enumerate(requests, start=1))
                    or data.get("campaign_allocation", {}).get("total_cap") != self.approved_cap
                    or data.get("campaign_allocation", {}).get("traffic_cap") != 400):
                raise RuntimeError("campaign is not eligible for safe resume; ledger unchanged")
            resumed_at = datetime.now(timezone.utc).isoformat()
            history = data.setdefault("resume_history", [])
            history.append({
                "resumed_at_utc": resumed_at,
                "previous_authorized_until_utc": data.get("authorized_until_utc"),
                "previous_stop_reason": data.get("stop_reason"),
                "previous_preflight_diagnostic": data.get("preflight_diagnostic"),
                "new_authorized_until_utc": authorized_until,
                "previous_limiter_probe_cap": data.get("campaign_allocation", {}).get("limiter_probe_max"),
                "new_limiter_probe_cap": limiter_probe_cap,
            })
            data["campaign_allocation"]["limiter_probe_max"] = limiter_probe_cap
            data.update({
                "authorized_until_utc": authorized_until,
                "last_resumed_at_utc": resumed_at,
                "bindings": bindings,
                "stop_reason": "campaign_resumed_with_existing_ledger",
            })
            outcomes = data.setdefault("scenario_outcomes", {})
            burst = outcomes.get("short_burst")
            if (isinstance(burst, dict)
                    and (burst.get("achieved_requests_per_second") or 0) < 20):
                burst.setdefault("attempt_count", 1 if "sent" in burst else 0)
                burst["status"] = "pending"
                burst["assessment"] = "prior achieved rate was below the 20 req/s target; one newly authorized attempt only"
            limiter = outcomes.get("shared_limiter")
            if isinstance(limiter, dict):
                limiter.setdefault("attempt_count", 1 if "requests_sent" in limiter else 0)
                limiter["status"] = "pending"
                limiter["assessment"] = "prior attempt did not complete the minimum expected admission/rejection sequence"
            self._save(data)

    def reserve(self, method: str, target: str) -> int:
        if not target.startswith("/") or "?" in target or "#" in target:
            raise ValueError("ledger targets must be path-only, without query or fragment")
        with self._locked():
            data = self._load()
            number = data["campaign_requests_used"] + 1
            if number > self.approved_cap:
                raise RuntimeError("approved campaign request cap is exhausted")
            data["requests"].append({
                "number": number,
                "method": method.upper(),
                "target": target,
                "issued_at_utc": datetime.now(timezone.utc).isoformat(),
                "status_code": None,
            })
            data["campaign_requests_used"] = number
            data["campaign_requests_remaining"] = self.approved_cap - number
            self._save(data)
            return number

    def complete(self, number: int, status_code: int | None, **observations) -> None:
        with self._locked():
            data = self._load()
            entry = next((row for row in data["requests"] if row["number"] == number), None)
            if entry is None or entry["status_code"] is not None:
                raise RuntimeError("request reservation is missing or already completed")
            entry["status_code"] = status_code
            entry.update(_sanitize_result(observations))
            self._save(data)

    def remaining(self) -> int:
        with self._locked():
            data = self._load()
            return data["campaign_requests_remaining"]

    def snapshot(self) -> dict:
        with self._locked():
            return self._load()

    def update(self, **fields) -> None:
        with self._locked():
            data = self._load()
            data.update(fields)
            self._save(data)

    def _load(self) -> dict:
        if not self.path.exists():
            raise RuntimeError("campaign report has not been initialized")
        data = json.loads(self.path.read_text())
        if data.get("campaign_id") != self.campaign_id or data.get("approved_campaign_cap") != self.approved_cap:
            raise RuntimeError("campaign ledger binding mismatch; refusing to reset or continue")
        return data

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(data, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.lock_path.open("a+")
        os.chmod(self.lock_path, 0o600)
        fcntl.flock(handle, fcntl.LOCK_EX)
        return _FileLock(handle)


class _FileLock:
    def __init__(self, handle):
        self.handle = handle

    def __enter__(self):
        return self

    def __exit__(self, *_):
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()


def run_segment(
    send: Callable[[float], dict],
    *,
    rate_per_second: int,
    duration_seconds: int,
    max_requests: int,
    max_in_flight: int,
    request_timeout_seconds: float,
    stop: Callable[[], str | None],
) -> dict:
    """Schedule at a fixed cadence; skip missed slots and never catch up."""
    if min(rate_per_second, duration_seconds, max_requests, max_in_flight, request_timeout_seconds) <= 0:
        raise ValueError("segment bounds must be positive")
    started = time.monotonic()
    deadline = started + duration_seconds
    sent = 0
    results: list[dict] = []
    pending: dict[Future, float] = {}
    next_slot = started
    stop_cause = None
    max_in_flight_observed = 0
    with ThreadPoolExecutor(max_workers=max_in_flight) as pool:
        while time.monotonic() < deadline and sent < max_requests:
            stop_cause = stop()
            if stop_cause:
                break
            now = time.monotonic()
            if now >= next_slot and len(pending) < max_in_flight:
                pending[pool.submit(send, request_timeout_seconds)] = now
                sent += 1
                max_in_flight_observed = max(max_in_flight_observed, len(pending))
                next_slot = advance_schedule_slot(next_slot, now, 1 / rate_per_second)
                continue
            if pending:
                done, _ = wait(pending, timeout=min(0.05, max(0, next_slot - now)), return_when=FIRST_COMPLETED)
                for future in done:
                    pending.pop(future)
                    try:
                        results.append(_sanitize_result(future.result()))
                    except Exception as exc:
                        results.append({"outcome": "transport_error", "error_type": type(exc).__name__})
            else:
                time.sleep(min(0.05, max(0, next_slot - now)))
        scheduled_elapsed = min(time.monotonic() - started, duration_seconds)
        if pending:
            done, _ = wait(pending)
            for future in done:
                try:
                    results.append(_sanitize_result(future.result()))
                except Exception as exc:
                    results.append({"outcome": "transport_error", "error_type": type(exc).__name__})
    return {
        "sent": sent,
        "completed": len(results),
        "elapsed_seconds": time.monotonic() - started,
        "achieved_requests_per_second": round(sent / scheduled_elapsed, 3) if scheduled_elapsed else 0,
        "max_in_flight_observed": max_in_flight_observed,
        "stop_reason": stop_cause or ("request_limit" if sent >= max_requests else "duration"),
        "results": results,
    }


def _sanitize_result(result: dict) -> dict:
    """Keep only bounded, non-sensitive observations; never persist bodies/errors."""
    allowed = {
        "service", "status_code", "latency_ms", "gateway_throttled",
        "lambda_throttled", "limiter_outcome", "cold_start", "outcome",
        "error_type", "limiter_retry_header", "http_429",
        "non_limiter_429", "auth_limiter_429", "sensitive_content_observed",
    }
    clean = {key: value for key, value in result.items() if key in allowed}
    if clean.get("service") not in (None, "auth", "core"):
        clean.pop("service")
    if clean.get("limiter_outcome") not in (None, "accepted", "rejected", "not_applicable"):
        clean.pop("limiter_outcome")
    if clean.get("outcome") not in (None, "transport_error"):
        clean.pop("outcome")
    if clean.get("error_type") is not None and not isinstance(clean["error_type"], str):
        clean.pop("error_type")
    for key in ("gateway_throttled", "lambda_throttled", "cold_start", "limiter_retry_header",
                "non_limiter_429", "auth_limiter_429", "sensitive_content_observed"):
        if key in clean and not isinstance(clean[key], bool):
            clean.pop(key)
    return clean


INFRA_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = INFRA_ROOT.parent
HANDOFF_PATH = INFRA_ROOT / "artifacts/validation/spec10-handoff.json"
API_TIMEOUT_SECONDS = 15
# PostgreSQL hides backend_type for other roles. Count RDS's own sessions in the total.
SAMPLE_SQL = """
SELECT json_build_object(
  'sampled_at_utc', clock_timestamp(),
  'connections', (SELECT COALESCE(sum(numbackends), 0) FROM pg_stat_database),
  'auth_runtime', count(*) FILTER (WHERE usename = 'auth_runtime'),
  'core_runtime', count(*) FILTER (WHERE usename = 'core_runtime'),
  'auth_migrator', count(*) FILTER (WHERE usename = 'auth_migrator'),
  'core_migrator', count(*) FILTER (WHERE usename = 'core_migrator'),
  'admin', count(*) FILTER (WHERE usename = 'gootip_auth'),
  'operator', count(*) FILTER (WHERE usename = 'gootip_dev_operator'),
  'unknown_consumers', count(*) FILTER (WHERE
    (usename NOT IN ('auth_runtime','core_runtime','auth_migrator','core_migrator','gootip_auth','gootip_dev_operator')
      OR usename IS NULL)
    AND (usename, datname) IS DISTINCT FROM ('rdsadmin'::name, 'rdsadmin'::name)),
  'tls', (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
  'tls_version', (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid())
)::text FROM pg_stat_activity
WHERE backend_type = 'client backend'
   OR (backend_type IS NULL AND datname IS NOT NULL AND usename IS NOT NULL)
""".strip()


def _run_private(command: list[str], *, timeout: int = 30) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            command, cwd=INFRA_ROOT, check=True, capture_output=True,
            text=True, timeout=timeout,
        )
    except Exception:
        raise RuntimeError("A required private operator helper failed; inspect its sanitized output locally.") from None


def _operator_password() -> str:
    result = _run_private([str(INFRA_ROOT / "scripts/db_access.sh"), "password"])
    value = result.stdout.strip()
    if not value:
        raise RuntimeError("The approved operator credential helper returned no value.")
    return value


def _handoff_artifact_hash(value: str) -> str:
    match = re.search(r"\bSHA-256\s+([0-9a-f]{64})\b", value)
    if not match:
        raise RuntimeError("SPEC 10 handoff artifact hash is missing or malformed.")
    return match.group(1)


def _parse_signin_limiter(enabled: str, rules: str) -> dict:
    if enabled.strip().lower() != "true":
        raise RuntimeError("The deployed Auth limiter is not enabled in the reviewed dev configuration.")
    route = "/sign-in/email"
    matches = []
    try:
        for entry in rules.split(","):
            pattern, window, maximum = entry.strip().split(":")
            parsed_window, parsed_maximum = int(window), int(maximum)
            if parsed_window <= 0 or parsed_maximum <= 0:
                raise ValueError
            if fnmatch.fnmatchcase(route, pattern):
                matches.append({"path_pattern": pattern, "window_seconds": parsed_window,
                                "maximum_requests": parsed_maximum})
    except (ValueError, TypeError):
        raise RuntimeError("The reviewed Auth rate-limit rule is malformed.") from None
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one reviewed rule matching /sign-in/email.")
    rule = matches[0]
    rule.update({
        "request_path": "/api/auth/sign-in/email",
        "expected_minimal_sequence": {
            "accepted": rule["maximum_requests"],
            "rejected": 1,
            "accepted_http_status": 401,
            "rejected_http_status": 429,
            "rejected_requires_retry_header": True,
        },
        "basis": "Better Auth custom path rule; verify max admissions then one over-limit request in one window",
    })
    return rule


def _configured_signin_limiter() -> dict:
    tfvars = (INFRA_ROOT / "environments/dev.tfvars").read_text()
    enabled = re.search(r"(?m)^\s*auth_rate_limit_enabled\s*=\s*(true|false)\s*$", tfvars)
    rules = re.search(r'(?m)^\s*auth_rate_limit_rules\s*=\s*"([^"]+)"\s*$', tfvars)
    if not enabled or not rules:
        raise RuntimeError("Reviewed dev Auth limiter settings are missing.")
    return _parse_signin_limiter(enabled.group(1), rules.group(1))


def _traffic_requests_used(outcomes: dict) -> int:
    normal = outcomes.get("normal_use", {})
    used = sum(normal.get(service, {}).get("sent", 0) for service in ("core", "auth"))
    burst = outcomes.get("short_burst", {})
    used += burst.get("sent", 0)
    used += sum(attempt.get("sent", 0) for attempt in burst.get("attempt_history", []))
    return used


def _remaining_burst_budget(outcomes: dict) -> int:
    return min(100, max(0, 400 - _traffic_requests_used(outcomes)))


def _may_attempt_scenario(outcome: dict) -> bool:
    return outcome.get("status", "pending") == "pending" and outcome.get("attempt_count", 0) < 2


def _attempt_summary(outcome: dict) -> dict:
    return {key: outcome.get(key) for key in (
        "sent", "completed", "elapsed_seconds", "achieved_requests_per_second",
        "max_in_flight_observed", "stop_reason", "status", "assessment",
        "requests_sent", "accepted", "rejected", "unclassified_429",
    ) if key in outcome}


def _classify_psql_failure(stderr: str) -> str:
    message = stderr.casefold()
    if any(term in message for term in ("certificate", "ssl", "tls", "verify-full")):
        return "tls_verification_failed"
    if any(term in message for term in ("password authentication failed", "no password supplied")):
        return "database_authentication_failed"
    if any(term in message for term in ("permission denied", "does not exist", "column ")):
        return "sql_permission_or_query_failed"
    if "connection refused" in message:
        return "database_connection_refused"
    if any(term in message for term in ("timeout expired", "connection timed out")):
        return "database_connection_timeout"
    if "no route to host" in message:
        return "database_network_unreachable"
    if "could not connect" in message:
        return "database_connectivity_failed"
    return "psql_failed_unclassified"


class SafePreflightError(RuntimeError):
    def __init__(self, category: str):
        self.category = category
        super().__init__(f"verified TLS preflight failed: {category}")


def _verified_tls_preflight(psql: str, dsn: str, env: dict, *, retry_window: int = 30) -> dict:
    query = (
        "SELECT json_build_object('username', current_user, 'ssl', ssl, "
        "'tls_version', version)::text FROM pg_stat_ssl WHERE pid=pg_backend_pid()"
    )
    deadline = time.monotonic() + retry_window
    category = "database_connectivity_failed"
    while True:
        try:
            result = subprocess.run(
                [psql, dsn, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query],
                env=env, capture_output=True, text=True, timeout=7,
            )
        except subprocess.TimeoutExpired:
            result = None
            category = "database_connection_timeout"
        if result is not None and result.returncode == 0:
            try:
                row = json.loads(result.stdout.strip())
            except (json.JSONDecodeError, AttributeError):
                raise SafePreflightError("unexpected_preflight_result") from None
            if (row.get("username") != "gootip_dev_operator" or row.get("ssl") is not True
                    or not row.get("tls_version")):
                raise SafePreflightError("unexpected_database_identity_or_tls")
            return row
        if result is not None:
            category = _classify_psql_failure(result.stderr)
        if category not in {
            "database_connectivity_failed", "database_connection_refused",
            "database_connection_timeout", "database_network_unreachable",
        } or time.monotonic() >= deadline:
            raise SafePreflightError(category)
        time.sleep(2)


def _git_bindings(handoff: dict) -> dict:
    git = shutil.which("git")
    if not git:
        raise RuntimeError("git is required to bind the campaign to current sources.")
    paths = ["gootip-auth", "gootip-core"]
    paths.extend(str(path.relative_to(PROJECT_ROOT)) for path in INFRA_ROOT.glob("*.tf"))
    paths.extend([
        "gootip-infra/environments/dev.tfvars",
        "gootip-infra/.terraform.lock.hcl",
    ])
    status = subprocess.run(
        [git, "status", "--porcelain", "--", *paths], cwd=PROJECT_ROOT,
        capture_output=True, text=True, check=True,
    ).stdout
    if status:
        raise RuntimeError("Application or deployed Terraform inputs have local changes; resolve binding drift first.")
    revision = subprocess.run(
        [git, "rev-parse", "HEAD"], cwd=PROJECT_ROOT,
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    builds = handoff["runtime_tls_limitation"]["implemented_change"]["builds"]
    artifact_hashes = {}
    for service, filename in (("auth", "gootip-auth/lambda.zip"), ("core", "gootip-core/lambda.zip")):
        artifact = PROJECT_ROOT / filename
        if not artifact.is_file():
            raise RuntimeError(f"The {service} deployment artifact is missing; rebuild approval is outside this campaign.")
        digest = subprocess.run(
            ["shasum", "-a", "256", str(artifact)], capture_output=True,
            text=True, check=True,
        ).stdout.split()[0]
        expected = _handoff_artifact_hash(builds[service])
        if digest != expected:
            raise RuntimeError(f"The {service} artifact differs from the completed SPEC 10 handoff.")
        artifact_hashes[service] = digest
    configuration = {}
    for path in [*INFRA_ROOT.glob("*.tf"), INFRA_ROOT / "environments/dev.tfvars",
                 INFRA_ROOT / ".terraform.lock.hcl"]:
        configuration[str(path.relative_to(PROJECT_ROOT))] = subprocess.run(
            ["shasum", "-a", "256", str(path)], capture_output=True,
            text=True, check=True,
        ).stdout.split()[0]
    script_hash = subprocess.run(
        ["shasum", "-a", "256", str(Path(__file__).resolve())],
        capture_output=True, text=True, check=True,
    ).stdout.split()[0]
    return {"source_revision": revision, "artifact_sha256": artifact_hashes,
            "configuration_sha256": configuration, "validation_script_sha256": script_hash,
            "terraform_inputs_clean": True}


class SqlMonitor:
    def __init__(self, dsn: str, env: dict, ledger: CampaignLedger):
        self.dsn, self.env, self.ledger = dsn, env, ledger
        self.samples: list[dict] = []
        self.last_sample_at = 0.0
        self.error = False
        self.process = None
        self.thread = None
        self.ready = threading.Event()
        self.lock = threading.Lock()

    def start(self) -> dict:
        psql = shutil.which("psql")
        if not psql:
            raise RuntimeError("psql is required for the verified-TLS SQL monitor.")
        tls_row = _verified_tls_preflight(psql, self.dsn, self.env)
        self.process = subprocess.Popen(
            [psql, self.dsn, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=self.env, text=True, bufsize=1,
        )
        self.process.stdin.write(SAMPLE_SQL + ";\n\\watch 2\n")
        self.process.stdin.flush()
        self.thread = threading.Thread(target=self._read, name="spec10-1-sql-monitor", daemon=True)
        self.thread.start()
        if not self.ready.wait(10):
            raise RuntimeError("The SQL monitor did not produce a readiness sample.")
        with self.lock:
            initial = dict(self.samples[-1])
        if initial.get("unknown_consumers", 0) != 0:
            self.ledger.update(status="pending", stop_reason="unreconciled_database_consumers",
                               initial_connection_sample=initial)
            raise RuntimeError("Unreconciled active database consumers were observed; no campaign traffic sent.")
        if any(initial.get(role, 0) for role in ("auth_migrator", "core_migrator", "admin")):
            self.ledger.update(status="pending", stop_reason="migration_or_admin_consumer_active",
                               initial_connection_sample=initial)
            raise RuntimeError("A migration/Admin database consumer is active; no campaign traffic sent.")
        if initial.get("operator", 0) > 2:
            self.ledger.update(status="pending", stop_reason="operator_connection_allowance_exceeded",
                               initial_connection_sample=initial)
            raise RuntimeError("The operator connection allowance is exceeded; no campaign traffic sent.")
        if initial.get("connections", 50) >= 50:
            self.ledger.update(status="pending", stop_reason="sql_connection_cutoff",
                               initial_connection_sample=initial)
            raise RuntimeError("The SQL connection cutoff is already reached; no campaign traffic sent.")
        return {**initial, "verified_tls": tls_row}

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    sample = json.loads(line.strip())
                except (json.JSONDecodeError, TypeError):
                    continue
                sample = {key: sample.get(key) for key in (
                    "sampled_at_utc", "connections", "auth_runtime", "core_runtime",
                    "auth_migrator", "core_migrator", "admin", "operator", "unknown_consumers",
                )}
                with self.lock:
                    self.samples.append(sample)
                    self.last_sample_at = time.monotonic()
                self.ledger.update(connection_samples=self.samples[-120:])
                self.ready.set()
        except Exception:
            self.error = True
        if self.process.poll() not in (None, 0):
            self.error = True

    def snapshot(self) -> tuple[dict | None, float, bool]:
        with self.lock:
            sample = dict(self.samples[-1]) if self.samples else None
            return sample, self.last_sample_at, self.error or self.process.poll() not in (None, 0)

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.thread:
            self.thread.join(timeout=5)


class TrafficHealth:
    def __init__(self, monitor: SqlMonitor):
        self.monitor = monitor
        self.lock = threading.Lock()
        self.unexpected_5xx_streak = 0
        self.latencies: dict[str, list[tuple[float, float]]] = {"auth": [], "core": []}
        self.high_p95_since: dict[str, float | None] = {"auth": None, "core": None}
        self.transport_error = False
        self.sensitive_content = False
        self.authorized_until: datetime | None = None

    def record(self, service: str, status: int | None, latency_ms: float):
        with self.lock:
            if status is None:
                self.transport_error = True
            elif 500 <= status <= 599:
                self.unexpected_5xx_streak += 1
            else:
                self.unexpected_5xx_streak = 0
            if status is not None and 200 <= status < 300:
                self.latencies[service].append((time.monotonic(), latency_ms))

    def stop_reason(self) -> str | None:
        sample, last_sample, failed = self.monitor.snapshot()
        now = time.monotonic()
        if self.authorized_until and datetime.now(timezone.utc) >= self.authorized_until:
            return "authorization_window_expired"
        if failed or sample is None or now - last_sample > 5:
            return "sql_monitor_unavailable"
        if sample.get("connections") is None or sample["connections"] >= 50:
            return "sql_connection_cutoff"
        if sample.get("unknown_consumers", 0):
            return "unreconciled_database_consumers"
        with self.lock:
            if self.transport_error:
                return "request_transport_error"
            if self.sensitive_content:
                return "sensitive_content_observed"
            if self.unexpected_5xx_streak >= 3:
                return "unexpected_5xx_streak"
            for service, entries in self.latencies.items():
                recent = [latency for at, latency in entries if now - at <= 30]
                if len(recent) < 20:
                    self.high_p95_since[service] = None
                    continue
                p95 = sorted(recent)[math.ceil(0.95 * len(recent)) - 1]
                if p95 > 2000:
                    if self.high_p95_since[service] is None:
                        self.high_p95_since[service] = now
                    elif now - self.high_p95_since[service] >= 30:
                        return "successful_request_p95_cutoff"
                else:
                    self.high_p95_since[service] = None
        return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class CampaignRunner:
    def __init__(self, ledger: CampaignLedger, origin: str, email: str, password: str,
                 health: TrafficHealth, opener: urllib.request.OpenerDirector):
        self.ledger, self.origin, self.email, self.password = ledger, origin, email, password
        self.health, self.opener = health, opener

    def request(self, service: str, method: str, path: str, *, body=None,
                limiter_probe: bool = False, timeout: float = API_TIMEOUT_SECONDS) -> dict:
        number = self.ledger.reserve(method, urllib.parse.urlsplit(path).path)
        started = time.monotonic()
        status = None
        limiter_header = False
        sensitive_content = False
        try:
            headers = {"Accept": "application/json", "Origin": "http://localhost:3000"}
            if body is not None:
                headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(self.origin + path, data=data, headers=headers, method=method)
            try:
                response = self.opener.open(req, timeout=timeout)
            except urllib.error.HTTPError as error:
                response = error
            status = response.code
            limiter_header = bool(response.headers.get("x-retry-after") or response.headers.get("retry-after"))
            response_body = response.read(65536)
            response.close()
            if service == "core" and status is not None and 200 <= status < 300:
                try:
                    payload = json.loads(response_body)
                    sensitive_content = _has_sensitive_key(payload)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
            latency = (time.monotonic() - started) * 1000
            outcome = "accepted" if limiter_probe and status == 401 else (
                "rejected" if limiter_probe and status == 429 and limiter_header else None
            )
            auth_limiter_route = service == "auth" and path.startswith("/api/auth/sign-in/")
            self.ledger.complete(
                number, status, service=service, latency_ms=round(latency, 2),
                http_429=(status == 429), limiter_outcome=outcome,
                limiter_retry_header=limiter_header if limiter_probe else None,
                auth_limiter_429=(status == 429 and auth_limiter_route),
                non_limiter_429=(status == 429 and not auth_limiter_route),
                sensitive_content_observed=sensitive_content,
            )
            self.health.record(service, status, latency)
            if sensitive_content:
                with self.health.lock:
                    self.health.sensitive_content = True
            return {"service": service, "status_code": status, "latency_ms": round(latency, 2),
                    "limiter_outcome": outcome, "limiter_retry_header": limiter_header}
        except Exception as exc:
            latency = (time.monotonic() - started) * 1000
            self.ledger.complete(number, status, service=service, latency_ms=round(latency, 2),
                                 outcome="transport_error", error_type=type(exc).__name__)
            self.health.record(service, None, latency)
            return {"service": service, "status_code": status, "latency_ms": round(latency, 2),
                    "outcome": "transport_error", "error_type": type(exc).__name__}

    def sign_in(self) -> dict:
        return self.request("auth", "POST", "/api/auth/sign-in/email",
                            body={"email": self.email, "password": self.password})


def _port_open(port: int = 15432) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _has_sensitive_key(value) -> bool:
    forbidden = {"password", "secret", "token", "email", "emailverified", "userid"}
    if isinstance(value, dict):
        return any(str(key).replace("_", "").lower() in forbidden or _has_sensitive_key(item)
                   for key, item in value.items())
    if isinstance(value, list):
        return any(_has_sensitive_key(item) for item in value)
    return False


def _campaign_main(args) -> int:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", args.campaign_id):
        raise RuntimeError("Campaign ID must be a short filesystem-safe identifier.")
    expiry = datetime.fromisoformat(args.authorized_until.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    if (expiry.tzinfo is None or expiry.utcoffset() != timezone.utc.utcoffset(expiry)
            or now >= expiry or expiry > now + timedelta(minutes=30)
            or args.approved_cap != 500 or args.traffic_cap != 400):
        raise RuntimeError("Campaign authorization is expired or does not match the confirmed 500/400 caps.")
    if not HANDOFF_PATH.is_file():
        raise RuntimeError("The private SPEC 10 handoff is missing; no campaign started.")
    handoff = json.loads(HANDOFF_PATH.read_text())
    if handoff.get("status") != "spec10_complete_accepted_no_required_criteria_pending":
        raise RuntimeError("SPEC 10 handoff is not in the accepted completed state.")
    bindings = _git_bindings(handoff)
    limiter_rule = _configured_signin_limiter()
    report_path = INFRA_ROOT / "artifacts/validation" / f"{args.campaign_id}.json"
    ledger = CampaignLedger(report_path, args.campaign_id, args.approved_cap)
    expected_limiter = limiter_rule["expected_minimal_sequence"]
    probe_sequence_size = expected_limiter["accepted"] + expected_limiter["rejected"]
    prior_probe_count = 0
    if args.resume:
        prior_probe_count = sum(
            row.get("limiter_outcome") is not None
            for row in ledger.snapshot().get("requests", [])
        )
    limiter_probe_cap = max(8, prior_probe_count + probe_sequence_size)
    metadata = {
        "spec": "SPEC 10.1",
        "status": "pending",
        "started_at_utc": now.isoformat(),
        "authorized_until_utc": expiry.isoformat(),
        "campaign_allocation": {"total_cap": 500, "traffic_cap": 400,
                                "normal_target_max": 300, "burst_target_max": 100,
                                "limiter_probe_max": 8},
        "verified_shared_limiter_rule": limiter_rule,
        "bindings": bindings,
        "reused_deployment_bindings": {
            "auth_core_reserved_concurrency": [5, 5],
            "auth_core_pool_maximum": [2, 2],
            "api_gateway_stage_rate_burst": [10, 20],
            "tls": "private verified-full; refreshed connection checked by SQL monitor",
            "current_binding_source": "SPEC 10 handoff; tracked deployment inputs unchanged and artifact hashes matched",
        },
        "reused_evidence": {"spec10_handoff": "artifacts/validation/spec10-handoff.json",
                             "recovery_ledger_used": 64, "recovery_ledger_remaining": 36,
                             "historical_spec10_consumption": "unknown_not_reconstructed"},
        "scenario_outcomes": {},
        "deferred": ["multi_environment_aws_atomicity_unobserved", "cold_start_benchmark_not_forced"],
        "credentials_or_tokens_recorded": False,
    }
    if args.resume:
        ledger.resume(authorized_until=expiry.isoformat(), bindings=bindings,
                      limiter_probe_cap=limiter_probe_cap)
        ledger.update(
            verified_shared_limiter_rule=limiter_rule,
            limiter_probe_allocation_update={
                "previous_attempt_requests": prior_probe_count,
                "new_minimal_sequence_requests": probe_sequence_size,
                "revised_campaign_probe_cap": limiter_probe_cap,
                "reason": "explicitly authorized fresh rule-window check; existing limiter window has expired",
            },
        )
    else:
        ledger.initialize(metadata)
    current_scenarios = ledger.snapshot().get("scenario_outcomes", {})
    pending_attempts = [current_scenarios.get(name, {}) for name in ("short_burst", "shared_limiter")]
    if args.resume and all(
        scenario.get("status") != "pending" or scenario.get("attempt_count", 0) >= 2
        for scenario in pending_attempts
    ):
        raise RuntimeError("No explicitly authorized pending scenario attempt remains; no API request sent.")

    psql = shutil.which("psql")
    if not psql:
        ledger.update(stop_reason="psql_missing")
        raise RuntimeError("psql is required; campaign report retained with no traffic sent.")
    db_script = str(INFRA_ROOT / "scripts/db_access.sh")
    info = _run_private([db_script, "info"])
    db_host = next((line.split(": ", 1)[1] for line in info.stdout.splitlines()
                    if line.startswith("Certificate hostname: ")), None)
    ca_path = INFRA_ROOT / ".db-access/rds-ca-bundle.pem"
    if not db_host or not ca_path.is_file():
        ledger.update(stop_reason="verified_tls_binding_missing")
        raise RuntimeError("Reviewed RDS TLS hostname/CA is unavailable; no traffic sent.")

    tunnel = None
    monitor = None
    signed_in = False
    opener = urllib.request.build_opener(
        NoRedirect, urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    cookie_jar = next(handler.cookiejar for handler in opener.handlers
                       if isinstance(handler, urllib.request.HTTPCookieProcessor))
    user_email = ""
    user_password = ""
    operator_password = ""
    try:
        if not _port_open():
            tunnel = subprocess.Popen(
                [db_script, "tunnel"], cwd=INFRA_ROOT, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            until = time.monotonic() + 90
            while time.monotonic() < until and not _port_open():
                if tunnel.poll() is not None:
                    raise RuntimeError("Private DB tunnel did not start; no campaign traffic sent.")
                time.sleep(0.25)
            if not _port_open():
                raise RuntimeError("Private DB tunnel readiness timed out; no campaign traffic sent.")

        operator_password = _operator_password()
        dsn = (f"host={db_host} hostaddr=127.0.0.1 port=15432 dbname=gootip "
               f"user=gootip_dev_operator sslmode=verify-full sslrootcert={ca_path} connect_timeout=5")
        db_env = os.environ.copy()
        db_env["PGPASSWORD"] = operator_password
        monitor = SqlMonitor(dsn, db_env, ledger)
        initial = monitor.start()
        ledger.update(status="running", initial_connection_sample=initial)
        operator_password = ""

        user_email = input("Existing dev test identity email (private terminal): ").strip()
        user_password = getpass.getpass("That identity's password (hidden): ")
        if not user_email or not user_password:
            raise RuntimeError("An existing test identity is required; no traffic sent.")
        origin = handoff["api_origin"].rstrip("/")
        if not origin.startswith("https://"):
            raise RuntimeError("The reused API origin is not HTTPS; no traffic sent.")
        health = TrafficHealth(monitor)
        health.authorized_until = expiry
        if datetime.now(timezone.utc) >= expiry:
            raise RuntimeError("The authorized execution window expired before the first application request.")
        runner = CampaignRunner(ledger, origin, user_email, user_password, health, opener)
        sign_in = runner.sign_in()
        if sign_in["status_code"] != 200 or not cookie_jar:
            raise RuntimeError("Existing test identity sign-in failed; no retry attempted.")
        signed_in = True
        sign_in_started = time.monotonic()
        user_password = ""
        runner.password = ""
        token = runner.request("auth", "GET", "/api/auth/token")
        if token["status_code"] != 200:
            raise RuntimeError("Auth JWT/session setup failed; stop without retry.")

        def perform(service, path):
            return runner.request(service, "GET", path)

        outcomes = ledger.snapshot().get("scenario_outcomes", {})
        normal = outcomes.get("normal_use", {})
        normal_passed = all(normal.get(service, {}).get("status") == "passed" for service in ("core", "auth"))
        normal_stop = None
        if normal and not normal_passed:
            normal_stop = "previous_normal_scenario_not_passed; automatic repeat disabled"
        elif not normal:
            core_normal = iter(("/api/products?limit=1", "/api/categories?limit=1"))
            auth_normal = iter(("/api/auth/get-session", "/api/auth/token"))
            with ThreadPoolExecutor(max_workers=2) as pool:
                core_future = pool.submit(run_segment, lambda timeout: perform("core", next(core_normal)),
                    rate_per_second=4, duration_seconds=60, max_requests=240, max_in_flight=5,
                    request_timeout_seconds=API_TIMEOUT_SECONDS, stop=health.stop_reason)
                auth_future = pool.submit(run_segment, lambda timeout: perform("auth", next(auth_normal)),
                    rate_per_second=1, duration_seconds=60, max_requests=60, max_in_flight=5,
                    request_timeout_seconds=API_TIMEOUT_SECONDS, stop=health.stop_reason)
            normal = {"core": core_future.result(), "auth": auth_future.result()}
            normal_stop = next((part["stop_reason"] for part in normal.values()
                                if part["stop_reason"] not in ("duration", "request_limit")), None)
            for part in normal.values():
                codes = [row.get("status_code") for row in part["results"]]
                part["status"] = (
                    "failed" if part["stop_reason"] not in ("duration", "request_limit")
                    or any(code not in (200, 429) for code in codes)
                    else "passed" if codes else "pending"
                )
            normal["combined_achieved_requests_per_second"] = round(
                sum(normal[service]["sent"] for service in ("core", "auth")) / 60, 3)
            outcomes["normal_use"] = normal
            ledger.update(scenario_outcomes=outcomes)

        burst = outcomes.get("short_burst", {})
        burst_attempts = burst.get("attempt_count", 0)
        if normal_stop is None and _may_attempt_scenario(burst):
            used_before = _traffic_requests_used(outcomes)
            burst_limit = _remaining_burst_budget(outcomes)
            history = burst.get("attempt_history", [])
            if "sent" in burst:
                history = [*history, _attempt_summary(burst)]
            burst = {"attempt_count": burst_attempts + 1, "attempt_history": history}
            outcomes["short_burst"] = burst
            ledger.update(scenario_outcomes=outcomes)
            if burst_limit:
                result = run_segment(lambda timeout: perform("core", "/api/products?limit=1"),
                    rate_per_second=20, duration_seconds=5, max_requests=burst_limit, max_in_flight=5,
                    request_timeout_seconds=API_TIMEOUT_SECONDS, stop=health.stop_reason)
                codes = [row.get("status_code") for row in result["results"]]
                rate = result["achieved_requests_per_second"]
                if result["stop_reason"] not in ("duration", "request_limit") or any(code not in (200, 429) for code in codes):
                    status, assessment = "failed", "health stop or unexpected HTTP response"
                elif rate < 20:
                    status = "pending"
                    assessment = (
                        "in_flight_limit_and_response_latency_limited; concurrency was not raised"
                        if result["max_in_flight_observed"] == 5 else "target_rate_not_achieved"
                    )
                else:
                    status, assessment = "passed", "20 req/s target achieved within duration and concurrency bounds"
                outcomes["short_burst"] = {
                    **result, "status": status, "assessment": assessment,
                    "target_requests_per_second": 20, "attempt_count": burst_attempts + 1,
                    "attempt_history": history, "traffic_cap_remaining_before_attempt": burst_limit,
                }
            else:
                outcomes["short_burst"].update(status="pending", assessment="campaign traffic cap exhausted")
            ledger.update(scenario_outcomes=outcomes)

        limiter = outcomes.get("shared_limiter", {})
        limiter_attempts = limiter.get("attempt_count", 0)
        if normal_stop is None and _may_attempt_scenario(limiter):
            # The successful sign-in consumes one quota slot; wait out that rule window first.
            cooldown = limiter_rule["window_seconds"] + 0.25 - (time.monotonic() - sign_in_started)
            while cooldown > 0:
                stop = health.stop_reason()
                if stop:
                    break
                time.sleep(min(0.2, cooldown))
                cooldown = limiter_rule["window_seconds"] + 0.25 - (time.monotonic() - sign_in_started)
            else:
                stop = None
            if cooldown > 0:
                outcomes["shared_limiter"].update(status="pending", stop_reason=stop,
                                                    assessment="stopped before probe by health monitor")
            else:
                counter_before = int(subprocess.run(
                    [psql, dsn, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
                     'SELECT count(*) FROM auth."rateLimit"'], env=db_env,
                    capture_output=True, text=True, timeout=10, check=True,
                ).stdout.strip())
                history = limiter.get("attempt_history", [])
                if "requests_sent" in limiter:
                    history = [*history, _attempt_summary(limiter)]
                limiter = {"attempt_count": limiter_attempts + 1, "attempt_history": history}
                outcomes["shared_limiter"] = limiter
                ledger.update(scenario_outcomes=outcomes)
                expected = limiter_rule["expected_minimal_sequence"]
                sequence_size = expected["accepted"] + expected["rejected"]
                limiter_calls = run_segment(
                    lambda timeout: runner.request(
                        "auth", "POST", "/api/auth/sign-in/email",
                        body={"email": user_email, "password": secrets.token_urlsafe(24)},
                        limiter_probe=True, timeout=timeout,
                    ),
                    rate_per_second=10, duration_seconds=min(5, limiter_rule["window_seconds"]),
                    max_requests=sequence_size, max_in_flight=min(5, sequence_size),
                    request_timeout_seconds=10, stop=health.stop_reason,
                )
                counter_after = int(subprocess.run(
                    [psql, dsn, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
                     'SELECT count(*) FROM auth."rateLimit"'], env=db_env,
                    capture_output=True, text=True, timeout=10, check=True,
                ).stdout.strip())
                accepted = sum(row.get("limiter_outcome") == "accepted" for row in limiter_calls["results"])
                rejected = sum(row.get("limiter_outcome") == "rejected" for row in limiter_calls["results"])
                unclassified = sum(row.get("status_code") == 429 and row.get("limiter_outcome") != "rejected"
                                   for row in limiter_calls["results"])
                exact = (accepted == expected["accepted"] and rejected == expected["rejected"]
                         and unclassified == 0 and limiter_calls["sent"] == sequence_size)
                status = ("passed" if exact else "pending" if limiter_calls["sent"] < sequence_size else "failed")
                outcomes["shared_limiter"] = {
                    **limiter_calls, "status": status, "attempt_count": limiter_attempts + 1,
                    "attempt_history": history, "accepted": accepted, "rejected": rejected,
                    "unclassified_429": unclassified,
                    "counter_rows_before": counter_before, "counter_rows_after": counter_after,
                    "verified_rule": limiter_rule,
                    "accept_reject_justification": (
                        f"Rule allows {expected['accepted']} requests per {limiter_rule['window_seconds']}-second window; "
                        f"the next request should be rejected with HTTP 429 and Retry-After."
                    ),
                    "multi_environment_atomicity": "deferred_unobserved",
                }
                ledger.update(scenario_outcomes=outcomes)

        signout = runner.request("auth", "POST", "/api/auth/sign-out", body={}) if signed_in else None
        signed_in = False
        monitor.close()
        final_samples = monitor.samples[-120:] if monitor else []
        traffic_paths = {"/api/products", "/api/categories", "/api/auth/get-session", "/api/auth/token"}
        all_traffic = [
            row for row in ledger.snapshot().get("requests", [])
            if row.get("target") in traffic_paths and row.get("service") in ("auth", "core")
        ]
        latency_summary = {}
        for service in ("auth", "core"):
            successful = sorted(
                row["latency_ms"] for row in all_traffic
                if row.get("service") == service and row.get("status_code") is not None
                and 200 <= row["status_code"] < 300 and isinstance(row.get("latency_ms"), (int, float))
            )
            latency_summary[service] = {
                "successful_requests": len(successful),
                "min_ms": successful[0] if successful else None,
                "max_ms": successful[-1] if successful else None,
                "p95_ms": successful[math.ceil(0.95 * len(successful)) - 1] if len(successful) >= 20 else None,
                "p95_status": "measured" if len(successful) >= 20 else "insufficient_sample",
            }
        throttle_summary = {
            service: sum(1 for row in all_traffic
                         if row.get("service") == service and row.get("status_code") == 429)
            for service in ("auth", "core")
        }
        scenario_states = [part.get("status", "pending") for outcome in outcomes.values()
                           for part in (outcome.values() if outcome is normal else [outcome])
                           if isinstance(part, dict)]
        if signout and signout["status_code"] != 200:
            final_status = "failed"
        elif any(value == "failed" for value in scenario_states):
            final_status = "failed"
        elif not scenario_states or any(value == "pending" for value in scenario_states):
            final_status = "pending"
        else:
            final_status = "passed"
        ledger.update(
            status=final_status,
            scenario_outcomes=outcomes,
            successful_request_latency=latency_summary,
            non_limiter_429_counts={"source": "gateway_or_lambda_not_individually_attributed",
                                    "by_service": throttle_summary},
            sign_out_status=signout["status_code"] if signout else None,
            session_cleanup="passed" if signout and signout["status_code"] == 200 else "failed",
            final_connection_samples=final_samples,
            observed_cold_starts="not_observed; no forced cold starts or log sweep",
            credentials_or_tokens_recorded=False,
        )
        print(json.dumps({"campaign_id": args.campaign_id, "status": final_status,
                          "requests_used": 500 - ledger.remaining(), "remaining": ledger.remaining(),
                          "report": str(report_path), "credentials_or_tokens_recorded": False}))
        return 0 if final_status == "passed" else 1
    except KeyboardInterrupt:
        ledger.update(status="pending", stop_reason="operator_interrupt")
        raise RuntimeError("Interrupted; report preserved and cleanup will run.") from None
    except Exception as exc:
        category = getattr(exc, "category", None)
        ledger.update(
            status="pending",
            stop_reason=(f"sql_preflight_{category}" if category else "preflight_or_execution_failed"),
            **({"preflight_diagnostic": {
                "status": "failed", "category": category,
                "application_requests_sent": 0, "raw_sql_error_persisted": False,
            }} if category else {}),
        )
        raise
    finally:
        if signed_in:
            try:
                cleanup = runner.request("auth", "POST", "/api/auth/sign-out", body={})
                ledger.update(session_cleanup=("passed" if cleanup["status_code"] == 200 else "failed"),
                              sign_out_status=cleanup["status_code"])
            except Exception:
                ledger.update(session_cleanup="sign_out_failed")
        if monitor:
            monitor.close()
        if tunnel and tunnel.poll() is None:
            try:
                os.killpg(tunnel.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
            try:
                tunnel.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(tunnel.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    tunnel.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(tunnel.pid, signal.SIGKILL)
                    tunnel.wait(timeout=5)
        user_email = user_password = operator_password = ""
        if "runner" in locals():
            runner.email = runner.password = ""
        if "db_env" in locals():
            db_env["PGPASSWORD"] = ""
        try:
            cookie_jar.clear()
        except Exception:
            pass


def _diagnose_main(args) -> int:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", args.campaign_id):
        raise RuntimeError("Campaign ID must be a short filesystem-safe identifier.")
    report_path = INFRA_ROOT / "artifacts/validation" / f"{args.campaign_id}.json"
    if not report_path.is_file():
        raise RuntimeError("Existing campaign report not found; diagnosis will not create a campaign.")
    report = json.loads(report_path.read_text())
    if report.get("campaign_id") != args.campaign_id or report.get("campaign_requests_used") != 0:
        raise RuntimeError("Diagnosis requires the matching campaign with zero application requests; ledger unchanged.")
    expiry = datetime.fromisoformat(report["authorized_until_utc"])
    if datetime.now(timezone.utc) >= expiry:
        raise RuntimeError("The authorized campaign window expired; request a new window before live diagnosis.")

    psql = shutil.which("psql")
    if not psql:
        raise RuntimeError("psql is required; no AWS request made.")
    db_script = str(INFRA_ROOT / "scripts/db_access.sh")
    info = _run_private([db_script, "info"])
    db_host = next((line.split(": ", 1)[1] for line in info.stdout.splitlines()
                    if line.startswith("Certificate hostname: ")), None)
    ca_path = INFRA_ROOT / ".db-access/rds-ca-bundle.pem"
    if not db_host or not ca_path.is_file():
        raise RuntimeError("Reviewed RDS TLS hostname/CA is unavailable.")

    tunnel = None
    password = ""
    env = os.environ.copy()
    try:
        if not _port_open():
            tunnel = subprocess.Popen(
                [db_script, "tunnel"], cwd=INFRA_ROOT, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            )
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline and not _port_open():
                if tunnel.poll() is not None:
                    raise RuntimeError("Private DB tunnel did not start.")
                time.sleep(0.25)
            if not _port_open():
                raise RuntimeError("Private DB tunnel readiness timed out.")
        password = _operator_password()
        env["PGPASSWORD"] = password
        dsn = (f"host={db_host} hostaddr=127.0.0.1 port=15432 dbname=gootip "
               f"user=gootip_dev_operator sslmode=verify-full sslrootcert={ca_path} connect_timeout=5")
        result = subprocess.run(
            [psql, dsn, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
             "SELECT json_build_object('username', current_user, 'ssl', ssl, 'tls_version', version)::text FROM pg_stat_ssl WHERE pid=pg_backend_pid()"],
            env=env, capture_output=True, text=True, timeout=10,
        )
        if result.returncode:
            category = _classify_psql_failure(result.stderr)
        else:
            try:
                row = json.loads(result.stdout.strip())
                category = ("verified_tls_preflight_passed"
                            if row.get("username") == "gootip_dev_operator"
                            and row.get("ssl") is True and row.get("tls_version")
                            else "unexpected_database_identity_or_tls")
            except (json.JSONDecodeError, AttributeError):
                category = "unexpected_preflight_result"
        ledger = CampaignLedger(report_path, args.campaign_id, report["approved_campaign_cap"])
        ledger.update(preflight_diagnostic={
            "checked_at_utc": datetime.now(timezone.utc).isoformat(),
            "status": "passed" if category == "verified_tls_preflight_passed" else "failed",
            "category": category,
            "psql_returncode": result.returncode,
            "application_requests_sent": 0,
            "raw_sql_error_persisted": False,
        })
        print(json.dumps({"campaign_id": args.campaign_id, "diagnosis": category,
                          "application_requests_sent": 0, "report": str(report_path)}))
        return 0 if category == "verified_tls_preflight_passed" else 1
    finally:
        env["PGPASSWORD"] = ""
        password = ""
        if tunnel and tunnel.poll() is None:
            try:
                os.killpg(tunnel.pid, signal.SIGINT)
                tunnel.wait(timeout=10)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(tunnel.pid, signal.SIGTERM)
                    tunnel.wait(timeout=5)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    campaign = subparsers.add_parser("run", help="run the one bounded dev campaign")
    campaign.add_argument("--campaign-id", required=True)
    campaign.add_argument("--approved-cap", type=int, required=True)
    campaign.add_argument("--traffic-cap", type=int, required=True)
    campaign.add_argument("--authorized-until", required=True,
                          help="UTC ISO-8601 expiry explicitly authorized for this run")
    campaign.add_argument("--resume", action="store_true",
                          help="resume the matching pending campaign without resetting its ledger")
    diagnose = subparsers.add_parser("diagnose", help="classify the failed TLS preflight without application requests")
    diagnose.add_argument("--campaign-id", required=True)
    args = parser.parse_args()
    if args.command == "run":
        return _campaign_main(args)
    if args.command == "diagnose":
        return _diagnose_main(args)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"SPEC 10.1 campaign stopped: {exc}", file=sys.stderr)
        sys.exit(1)
