from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dev_api_validation import (
    CampaignLedger,
    SafePreflightError,
    _classify_psql_failure,
    _parse_signin_limiter,
    _may_attempt_scenario,
    _handoff_artifact_hash,
    _has_sensitive_key,
    _sanitize_result,
    advance_schedule_slot,
    run_segment,
    stop_reason,
    _verified_tls_preflight,
    _traffic_requests_used,
    _remaining_burst_budget,
)


class CampaignLedgerTests(unittest.TestCase):
    def test_reserves_before_request_and_persists_remaining(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = CampaignLedger(Path(directory) / "campaign.json", "run-1", 2)
            ledger.initialize({"status": "running"})
            number = ledger.reserve("get", "/api/products")
            self.assertEqual(number, 1)
            self.assertEqual(ledger.remaining(), 1)
            ledger.complete(number, 200)
            self.assertEqual(json.loads(ledger.path.read_text())["requests"][0]["status_code"], 200)

    def test_refuses_exhaustion_mismatch_and_query_string(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "campaign.json"
            ledger = CampaignLedger(path, "run-1", 1)
            ledger.initialize({})
            ledger.reserve("GET", "/api/products")
            with self.assertRaises(RuntimeError):
                ledger.reserve("GET", "/api/products")
            with self.assertRaises(ValueError):
                ledger.reserve("GET", "/api/products?limit=1")
            with self.assertRaises(RuntimeError):
                CampaignLedger(path, "run-2", 1).remaining()

    def test_parallel_reservations_keep_one_persistent_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = CampaignLedger(Path(directory) / "campaign.json", "run-1", 20)
            ledger.initialize({})
            with ThreadPoolExecutor(max_workers=10) as pool:
                numbers = list(pool.map(lambda _: ledger.reserve("GET", "/api/products"), range(20)))
            self.assertEqual(sorted(numbers), list(range(1, 21)))
            self.assertEqual(ledger.remaining(), 0)

    def test_resume_preserves_zero_request_ledger_and_records_new_window(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "campaign.json"
            ledger = CampaignLedger(path, "run-1", 500)
            ledger.initialize({
                "status": "pending",
                "authorized_until_utc": "2026-11-01T18:44:49+00:00",
                "stop_reason": "sql_preflight_database_connectivity_failed",
                "preflight_diagnostic": {"category": "database_connectivity_failed"},
                "campaign_allocation": {"total_cap": 500, "traffic_cap": 400},
            })
            before = json.loads(path.read_text())
            ledger.resume(authorized_until="2026-11-01T18:44:49+00:00", bindings={"revision": "new"},
                          limiter_probe_cap=8)
            after = json.loads(path.read_text())
            self.assertEqual(after["campaign_id"], before["campaign_id"])
            self.assertEqual(after["requests"], before["requests"])
            self.assertEqual(after["campaign_requests_used"], 0)
            self.assertEqual(after["campaign_requests_remaining"], 500)
            self.assertEqual(after["resume_history"][0]["previous_preflight_diagnostic"],
                             before["preflight_diagnostic"])
            self.assertEqual(after["authorized_until_utc"], "2026-11-01T18:44:49+00:00")

    def test_resume_preserves_completed_requests_and_counter(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "campaign.json"
            ledger = CampaignLedger(path, "run-1", 500)
            ledger.initialize({
                "status": "pending",
                "authorized_until_utc": "2026-11-01T18:44:49+00:00",
                "campaign_allocation": {"total_cap": 500, "traffic_cap": 400},
            })
            number = ledger.reserve("POST", "/api/auth/sign-in/email")
            ledger.complete(number, 200)
            before = json.loads(path.read_text())
            ledger.resume(authorized_until="2026-11-01T18:44:49Z", bindings={}, limiter_probe_cap=8)
            after = json.loads(path.read_text())
            self.assertEqual(after["requests"], before["requests"])
            self.assertEqual(after["campaign_requests_used"], 1)
            self.assertEqual(after["campaign_requests_remaining"], 499)

    def test_resume_refuses_incomplete_request_without_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "campaign.json"
            ledger = CampaignLedger(path, "run-1", 2)
            ledger.initialize({"status": "pending", "authorized_until_utc": "2026-11-01T18:44:49+00:00",
                               "campaign_allocation": {"total_cap": 2, "traffic_cap": 400}})
            number = ledger.reserve("GET", "/api/products")
            before = path.read_text()
            with self.assertRaises(RuntimeError):
                ledger.resume(authorized_until="2026-11-01T18:44:49+00:00", bindings={}, limiter_probe_cap=8)
            self.assertEqual(path.read_text(), before)

    def test_resume_keeps_317_accounting_skips_passed_normal_and_reopens_only_pending_work(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "campaign.json"
            ledger = CampaignLedger(path, "run-1", 500)
            ledger.initialize({
                "status": "pending",
                "authorized_until_utc": "2026-11-01T18:44:49+00:00",
                "campaign_allocation": {"total_cap": 500, "traffic_cap": 400, "limiter_probe_max": 8},
                "scenario_outcomes": {
                    "normal_use": {"core": {"status": "passed"}, "auth": {"status": "passed"}},
                    "short_burst": {"status": "passed", "sent": 10,
                                    "achieved_requests_per_second": 2.0},
                    "shared_limiter": {"status": "pending", "requests_sent": 5},
                },
            })
            report = json.loads(path.read_text())
            report["requests"] = [
                {"number": number, "status_code": 200, "limiter_outcome": None}
                for number in range(1, 318)
            ]
            report["campaign_requests_used"] = 317
            report["campaign_requests_remaining"] = 183
            path.write_text(json.dumps(report))

            ledger.resume(authorized_until="2026-11-01T18:58:00+00:00", bindings={"revision": "new"},
                          limiter_probe_cap=9)
            resumed = ledger.snapshot()
            self.assertEqual(resumed["campaign_requests_used"], 317)
            self.assertEqual(resumed["campaign_requests_remaining"], 183)
            self.assertEqual(resumed["scenario_outcomes"]["normal_use"]["core"]["status"], "passed")
            self.assertEqual(resumed["scenario_outcomes"]["short_burst"]["status"], "pending")
            self.assertEqual(resumed["scenario_outcomes"]["short_burst"]["attempt_count"], 1)
            self.assertEqual(resumed["campaign_allocation"]["limiter_probe_max"], 9)


class ScheduleTests(unittest.TestCase):
    def test_missed_slots_are_skipped_instead_of_caught_up(self):
        self.assertEqual(advance_schedule_slot(1.0, 2.0, 0.1), 2.1)
        self.assertEqual(advance_schedule_slot(1.95, 2.0, 0.1), 2.05)


class StopAndScheduleTests(unittest.TestCase):
    def test_stop_conditions(self):
        self.assertEqual(stop_reason(monitor_available=False, connections=None, unexpected_5xx_streak=0), "sql_monitor_unavailable")
        self.assertEqual(stop_reason(monitor_available=True, connections=50, unexpected_5xx_streak=0), "sql_connection_cutoff")
        self.assertEqual(stop_reason(monitor_available=True, connections=4, unexpected_5xx_streak=3), "unexpected_5xx_streak")
        self.assertIsNone(stop_reason(monitor_available=True, connections=4, unexpected_5xx_streak=0))
        self.assertIsNone(stop_reason(monitor_available=True, connections=4, unexpected_5xx_streak=0, p95_ms=2500, p95_over_limit_seconds=29))
        self.assertEqual(stop_reason(monitor_available=True, connections=4, unexpected_5xx_streak=0, p95_ms=2500, p95_over_limit_seconds=30), "successful_request_p95_cutoff")

    def test_scheduler_stops_without_catchup(self):
        calls = []
        result = run_segment(
            lambda timeout: (calls.append(timeout) or {"status_code": 200, "response_body": "discard me"}),
            rate_per_second=20,
            duration_seconds=1,
            max_requests=3,
            max_in_flight=1,
            request_timeout_seconds=2,
            stop=lambda: None,
        )
        self.assertEqual(result["sent"], 3)
        self.assertEqual(result["stop_reason"], "request_limit")
        self.assertEqual(len(calls), 3)
        self.assertEqual(result["results"][0], {"status_code": 200})

    def test_redaction_drops_bodies_and_detects_sensitive_core_fields(self):
        self.assertEqual(_sanitize_result({"status_code": 200, "response_body": "secret"}), {"status_code": 200})
        self.assertTrue(_has_sensitive_key({"data": [{"email": "private@example.test"}]}))
        self.assertFalse(_has_sensitive_key({"data": [{"name": "public catalog item"}]}))

    def test_extracts_artifact_hash_from_handoff_text(self):
        digest = "a" * 64
        self.assertEqual(_handoff_artifact_hash(f"artifact.zip; SHA-256 {digest}"), digest)
        with self.assertRaises(RuntimeError):
            _handoff_artifact_hash("artifact.zip; no digest")

    def test_signin_rule_selects_minimal_over_limit_sequence(self):
        rule = _parse_signin_limiter(
            "true", "/sign-in/*:10:3,/sign-up/*:10:3,/request-password-reset:60:3"
        )
        self.assertEqual(rule["window_seconds"], 10)
        self.assertEqual(rule["maximum_requests"], 3)
        self.assertEqual(rule["expected_minimal_sequence"]["accepted"], 3)
        self.assertEqual(rule["expected_minimal_sequence"]["rejected"], 1)
        with self.assertRaises(RuntimeError):
            _parse_signin_limiter("false", "/sign-in/*:10:3")
        with self.assertRaises(RuntimeError):
            _parse_signin_limiter("true", "/sign-up/*:10:3")

    def test_traffic_cap_remaining_is_campaign_wide_and_preserves_attempts(self):
        outcomes = {
            "normal_use": {"core": {"sent": 236}, "auth": {"sent": 60}},
            "short_burst": {"sent": 10, "attempt_history": [{"sent": 2}]},
        }
        self.assertEqual(_traffic_requests_used(outcomes), 308)
        self.assertEqual(_remaining_burst_budget(outcomes), 92)
        self.assertFalse(_may_attempt_scenario({"status": "passed"}))
        self.assertTrue(_may_attempt_scenario({"status": "pending", "attempt_count": 1}))
        self.assertFalse(_may_attempt_scenario({"status": "pending", "attempt_count": 2}))

    def test_classifies_database_errors_without_preserving_raw_text(self):
        self.assertEqual(_classify_psql_failure("certificate verify failed"), "tls_verification_failed")
        self.assertEqual(_classify_psql_failure("password authentication failed"), "database_authentication_failed")
        self.assertEqual(_classify_psql_failure("connection refused"), "database_connection_refused")
        self.assertEqual(_classify_psql_failure("timeout expired"), "database_connection_timeout")
        self.assertEqual(_classify_psql_failure("unrecognized diagnostic"), "psql_failed_unclassified")

    def test_tls_preflight_retries_only_transient_connectivity_and_sanitizes_failures(self):
        success_json = json.dumps({"username": "gootip_dev_operator", "ssl": True, "tls_version": "TLSv1.3"})
        results = [
            subprocess.CompletedProcess([], 2, "", "connection refused"),
            subprocess.CompletedProcess([], 0, success_json, ""),
        ]
        with patch("dev_api_validation.subprocess.run", side_effect=results) as run, \
             patch("dev_api_validation.time.sleep"):
            row = _verified_tls_preflight("psql", "dsn", {}, retry_window=10)
        self.assertTrue(row["ssl"])
        self.assertEqual(run.call_count, 2)

        with patch("dev_api_validation.subprocess.run", return_value=subprocess.CompletedProcess([], 2, "", "certificate verify failed")) as run:
            with self.assertRaises(SafePreflightError) as error:
                _verified_tls_preflight("psql", "dsn", {}, retry_window=10)
        self.assertEqual(error.exception.category, "tls_verification_failed")
        self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
