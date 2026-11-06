#!/usr/bin/env python3
"""Validate every rendered Gootip policy with IAM Access Analyzer ValidatePolicy.

This is the remote half of the SPEC 02.3 contract. The local half stays in
``check_iam_policy_guardrails.py``: sizes, attachments, inline policies, and the
wildcard review all run without a network call, and this tool only runs once
those pass. It performs no IAM mutation, no plan, and no apply.

Contract:

* only ``ValidatePolicy`` is called. ``ListAnalyzers`` is never called, so the
  tool works in an account that has no analyzer configured and needs no extra
  authorization;
* every finding page is read. ``ValidatePolicy`` paginates, so the tool follows
  ``nextToken`` to exhaustion instead of trusting the first page;
* ``ERROR`` and ``SECURITY_WARNING`` findings fail the run. ``GENERAL_WARNING``
  and ``SUGGESTION`` findings are reported with their code and never fail
  silently.

The caller must hold ``access-analyzer:ValidatePolicy`` in the region. That is
the SPEC 02.3 Diagnostics grant on ``GootipBootstrapAdmin`` while it is applied,
or any other authorized principal outside that window. Use ``--profile`` to say
which; it defaults to the MFA-backed bootstrap session.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from iam_policy_evaluator import (  # noqa: E402
    APPLICATION_MAXIMUM,
    BOOTSTRAP_CREDENTIAL_OPERATIONS,
    BOOTSTRAP_DIAGNOSTICS,
    BOOTSTRAP_MAXIMUM,
    BOOTSTRAP_ROLE_SECRET_MAXIMUM,
    BOOTSTRAP_STANDING,
    BOOTSTRAP_TRANSITION,
    IsolatedRoot,
    iter_resources,
    render_plan,
)

DEFAULT_PROFILE = "gootip-bootstrap-admin"
DEFAULT_REGION = "us-east-2"

# SPEC 02.3: findings that fail validation, and findings that are reported with
# their disposition but do not fail automatically.
FAILING_TYPES = ("ERROR", "SECURITY_WARNING")
REPORTED_TYPES = ("GENERAL_WARNING", "SUGGESTION")

# Every configuration this repository can produce. Validating all of them means
# a policy is checked before it is ever applied, not only after the fact.
RENDERED_ROOTS: tuple[tuple[str, IsolatedRoot], ...] = (
    ("bootstrap-standing", BOOTSTRAP_STANDING),
    ("bootstrap-maximum", BOOTSTRAP_MAXIMUM),
    ("bootstrap-credential-operations", BOOTSTRAP_CREDENTIAL_OPERATIONS),
    ("bootstrap-transition", BOOTSTRAP_TRANSITION),
    ("bootstrap-role-secret-maximum", BOOTSTRAP_ROLE_SECRET_MAXIMUM),
    ("bootstrap-diagnostics", BOOTSTRAP_DIAGNOSTICS),
    ("application-maximum", APPLICATION_MAXIMUM),
)


def rendered_policies() -> list[dict[str, Any]]:
    """Return every distinct rendered policy, deduplicated by document."""
    documents: dict[str, dict[str, Any]] = {}
    for label, root in RENDERED_ROOTS:
        for resource in iter_resources(render_plan(root)):
            if resource.get("type") != "aws_iam_policy":
                continue
            document = resource["values"]["policy"]
            key = json.dumps(json.loads(document), sort_keys=True)
            entry = documents.setdefault(
                key,
                {"name": resource["values"]["name"], "roots": [], "document": document},
            )
            if label not in entry["roots"]:
                entry["roots"].append(label)
    return sorted(documents.values(), key=lambda entry: entry["name"])


def validate_document(document: str, profile: str, region: str) -> tuple[list[dict[str, Any]], int]:
    """Return every ValidatePolicy finding for one document and the page count.

    The CLI disables its own auto-pagination so the loop is explicit and
    countable: every ``nextToken`` is followed, so a document with more than one
    page of findings can never be reported as clean from a partial read.
    """
    findings: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "policy.json"
        path.write_text(document)
        token: str | None = None
        pages = 0
        while True:
            command = [
                "aws", "accessanalyzer", "validate-policy",
                "--policy-document", f"file://{path}",
                "--policy-type", "IDENTITY_POLICY",
                "--profile", profile,
                "--region", region,
                "--no-paginate",
                "--output", "json",
            ]
            if token:
                command += ["--starting-token", token]
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode != 0:
                raise SystemExit(
                    f"ValidatePolicy failed for the profile {profile}: {result.stderr.strip()}"
                )
            payload = json.loads(result.stdout)
            findings.extend(payload.get("findings", []))
            pages += 1
            token = payload.get("nextToken")
            if not token:
                return findings, pages


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profile",
        default=DEFAULT_PROFILE,
        help=f"AWS profile holding access-analyzer:ValidatePolicy (default: {DEFAULT_PROFILE}).",
    )
    parser.add_argument("--region", default=DEFAULT_REGION)
    args = parser.parse_args(argv)

    policies = rendered_policies()
    print(f"Rendering {len(RENDERED_ROOTS)} configurations -> {len(policies)} distinct policies")
    print(f"Validating with the profile {args.profile} in {args.region}")
    print(f"Access Analyzer ListAnalyzers is not called")
    print()

    failing: list[str] = []
    advisory: list[str] = []
    for policy in policies:
        findings, pages = validate_document(policy["document"], args.profile, args.region)
        kinds: dict[str, int] = {}
        for finding in findings:
            kind = finding["findingType"]
            kinds[kind] = kinds.get(kind, 0) + 1
        blocked = sorted(kind for kind in kinds if kind in FAILING_TYPES)
        if blocked:
            failing.append(policy["name"])
        elif kinds:
            advisory.append(policy["name"])
        print(
            f"  {policy['name']:50} pages={pages} "
            f"{json.dumps(kinds, sort_keys=True) if kinds else 'no findings':42} "
            f"{'FAIL' if blocked else 'OK'}"
        )
        for finding in findings:
            print(
                f"      {finding['findingType']} {finding['issueCode']}: "
                f"{finding['findingDetails'].strip()[:110]}"
            )

    print()
    print(
        f"policies validated: {len(policies)}; "
        f"clean: {len(policies) - len(failing) - len(advisory)}; "
        f"reported only: {len(advisory)}; blocking: {len(failing)}"
    )
    if failing:
        print(f"FAIL: blocking findings in {sorted(failing)}")
        return 1
    print("PASS: no ERROR or SECURITY_WARNING in any rendered policy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
