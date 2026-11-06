"""Offline contract tests for the Access Analyzer policy validator."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import validate_policies as validator  # noqa: E402


class ValidateDocumentTests(unittest.TestCase):
    def test_follows_every_findings_page(self):
        pages = [
            {"findings": [{"issueCode": "FIRST"}], "nextToken": "page-2"},
            {"findings": [{"issueCode": "SECOND"}]},
        ]
        calls = []

        def run(command, **_kwargs):
            calls.append(command)
            return mock.Mock(returncode=0, stdout=json.dumps(pages[len(calls) - 1]), stderr="")

        with mock.patch.object(validator.subprocess, "run", side_effect=run):
            findings, count = validator.validate_document("{}", "mfa", "us-east-2")

        self.assertEqual(count, 2)
        self.assertEqual([item["issueCode"] for item in findings], ["FIRST", "SECOND"])
        self.assertIn("--no-paginate", calls[0])
        self.assertIn("--starting-token", calls[1])
        self.assertIn("page-2", calls[1])

    def test_aws_error_fails_closed(self):
        failure = mock.Mock(returncode=255, stdout="", stderr="AccessDenied")
        with mock.patch.object(validator.subprocess, "run", return_value=failure):
            with self.assertRaisesRegex(SystemExit, "ValidatePolicy failed"):
                validator.validate_document("{}", "mfa", "us-east-2")


class ValidatorMainTests(unittest.TestCase):
    @staticmethod
    def policy():
        return {"name": "example", "document": "{}"}

    def test_renders_before_any_aws_request(self):
        with mock.patch.object(validator, "rendered_policies", side_effect=RuntimeError("render")), \
             mock.patch.object(validator.subprocess, "run") as aws:
            with self.assertRaisesRegex(RuntimeError, "render"):
                validator.main([])
        aws.assert_not_called()

    def test_blocking_finding_fails(self):
        finding = {"findingType": "SECURITY_WARNING", "issueCode": "BLOCK", "findingDetails": "details"}
        with mock.patch.object(validator, "rendered_policies", return_value=[self.policy()]), \
             mock.patch.object(validator, "validate_document", return_value=([finding], 1)):
            self.assertEqual(validator.main([]), 1)

    def test_advisory_finding_is_reported_without_failure(self):
        finding = {"findingType": "GENERAL_WARNING", "issueCode": "REVIEW", "findingDetails": "details"}
        with mock.patch.object(validator, "rendered_policies", return_value=[self.policy()]), \
             mock.patch.object(validator, "validate_document", return_value=([finding], 1)):
            self.assertEqual(validator.main([]), 0)


if __name__ == "__main__":
    unittest.main()
