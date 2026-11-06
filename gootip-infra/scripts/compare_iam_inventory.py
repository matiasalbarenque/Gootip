#!/usr/bin/env python3
"""Compare current Terraform IAM configuration, canonical state, and live IAM."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from iam_policy_evaluator import normalize  # noqa: E402

REPOSITORY_ROOT = SCRIPTS.parent
TERRAFORM_ROOTS = (REPOSITORY_ROOT, REPOSITORY_ROOT / "bootstrap")
IAM_RESOURCE_TYPES = {
    "aws_iam_policy", "aws_iam_role", "aws_iam_role_policy_attachment",
    "aws_iam_policy_attachment", "aws_iam_role_policy",
}


def check_configuration_plan(plan: Mapping[str, Any]) -> None:
    """Require the effective IAM configuration to match state before live reads."""
    if plan.get("errored") or plan.get("complete") is False:
        raise ValueError("Terraform configuration plan is incomplete or errored")
    for resource in plan.get("resource_changes", []):
        if resource.get("mode") == "data" or resource.get("type") not in IAM_RESOURCE_TYPES:
            continue
        if resource["change"]["actions"] != ["no-op"]:
            raise ValueError(
                f"Configuration differs from canonical state at {resource['address']}"
            )


def check_configuration(root: Path, profile: str | None, var_files: list[str]) -> None:
    """Render the current configuration without refreshing or applying resources."""
    env = {**os.environ, **({"AWS_PROFILE": profile} if profile else {})}
    with tempfile.TemporaryDirectory(prefix="iam-inventory-") as directory:
        plan_path = str(Path(directory) / "configuration.tfplan")
        command = [
            "terraform", f"-chdir={root}", "plan", "-input=false",
            "-refresh=false", "-lock-timeout=30s", f"-out={plan_path}",
        ]
        command.extend(f"-var-file={path}" for path in var_files)
        subprocess.run(command, check=True, capture_output=True, text=True, env=env)
        result = subprocess.run(
            ["terraform", f"-chdir={root}", "show", "-json", plan_path],
            check=True, capture_output=True, text=True, env=env,
        )
        check_configuration_plan(json.loads(result.stdout))
    print(f"configuration {root.name}: IAM matches canonical state")


def state_resources(state: Mapping[str, Any]):
    """Yield managed state resource instances, including nested modules."""
    def walk(resources):
        for resource in resources:
            for instance in resource.get("instances", []):
                yield resource, instance.get("attributes", {})
            yield from walk(resource.get("module_resources", []))

    yield from walk(state.get("resources", []))


def canonical_inventory(states: list[Mapping[str, Any]]):
    policies: dict[str, tuple[str, Mapping[str, Any]]] = {}
    roles: dict[str, set[str]] = {}
    for state in states:
        for resource, values in state_resources(state):
            kind = resource.get("type")
            address = resource.get("address", kind or "unknown")
            if kind == "aws_iam_policy":
                arn, document = values.get("arn"), values.get("policy")
                if not isinstance(arn, str) or not isinstance(document, str):
                    raise ValueError(f"Canonical state lacks policy ARN/document at {address}")
                if arn in policies:
                    raise ValueError(f"Duplicate canonical policy identity at {address}")
                policies[arn] = (values.get("name", address), json.loads(document))
            elif kind == "aws_iam_role":
                name, path = values.get("name"), values.get("path", "")
                if isinstance(name, str) and path.startswith("/gootip/"):
                    roles.setdefault(name, set())
            elif kind == "aws_iam_role_policy_attachment":
                role, arn = values.get("role"), values.get("policy_arn")
                if isinstance(role, str) and isinstance(arn, str):
                    roles.setdefault(role, set()).add(arn)
            elif kind == "aws_iam_policy_attachment":
                arn = values.get("policy_arn")
                for role in values.get("roles", []):
                    if isinstance(role, str) and isinstance(arn, str):
                        roles.setdefault(role, set()).add(arn)
    if not policies:
        raise ValueError("No canonical Gootip managed policies found in Terraform state")
    if not roles:
        raise ValueError("No canonical Gootip roles found in Terraform state")
    return policies, roles


def command_json(command: list[str]) -> Any:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def live_policy_document(arn: str, profile: str | None) -> Mapping[str, Any]:
    prefix = ["aws"] + (["--profile", profile] if profile else [])
    metadata = command_json(prefix + ["iam", "get-policy", "--policy-arn", arn])
    version_id = metadata["Policy"]["DefaultVersionId"]
    version = command_json(
        prefix
        + [
            "iam", "get-policy-version", "--policy-arn", arn,
            "--version-id", version_id,
        ]
    )
    document = version["PolicyVersion"]["Document"]
    return json.loads(document) if isinstance(document, str) else document


def live_role_attachments(role: str, profile: str | None) -> set[str]:
    command = ["aws"] + (["--profile", profile] if profile else []) + [
        "iam", "list-attached-role-policies", "--role-name", role,
    ]
    payload = command_json(command)
    return {item["PolicyArn"] for item in payload.get("AttachedPolicies", [])}


def terraform_state(root: Path, profile: str | None) -> Mapping[str, Any]:
    env = None
    if profile:
        env = {**os.environ, "AWS_PROFILE": profile}
    result = subprocess.run(
        ["terraform", f"-chdir={root}", "state", "pull"],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return json.loads(result.stdout)


def compare_inventory(
    policies: Mapping[str, tuple[str, Mapping[str, Any]]],
    roles: Mapping[str, set[str]],
    get_policy_document,
    get_role_attachments,
) -> int:
    failures = 0
    for arn, (name, expected) in sorted(policies.items(), key=lambda item: item[1][0]):
        actual = get_policy_document(arn)
        matches = normalize(actual) == normalize(expected)
        print(f"policy {name}: {'MATCH' if matches else 'DRIFT'}")
        failures += not matches
    for role, expected in sorted(roles.items()):
        actual = get_role_attachments(role)
        missing, extra = expected - actual, actual - expected
        matches = not missing and not extra
        print(
            f"role {role}: attachments={len(actual)} "
            f"{'MATCH' if matches else 'DRIFT'}"
        )
        if missing:
            print(f"  missing Terraform attachments: {len(missing)}")
        if extra:
            print(f"  additional live attachments: {len(extra)}")
        failures += not matches
    print(f"policies={len(policies)} roles={len(roles)} drift={failures}")
    return 1 if failures else 0


def compare(
    profile: str | None,
    application_var_files: list[str],
    bootstrap_var_files: list[str],
) -> int:
    for root, var_files in zip(TERRAFORM_ROOTS, (application_var_files, bootstrap_var_files)):
        check_configuration(root, profile, var_files)
    states = [terraform_state(root, profile) for root in TERRAFORM_ROOTS]
    policies, roles = canonical_inventory(states)
    return compare_inventory(
        policies,
        roles,
        lambda arn: live_policy_document(arn, profile),
        lambda role: live_role_attachments(role, profile),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", help="AWS CLI profile for read-only IAM calls")
    for root in ("application", "bootstrap"):
        parser.add_argument(
            f"--{root}-var-file", action="append",
            help="Effective var file, relative to that Terraform root; repeat in precedence order. "
                 "Defaults to environments/dev.tfvars.",
        )
    args = parser.parse_args()
    try:
        return compare(
            args.profile,
            args.application_var_file or ["environments/dev.tfvars"],
            args.bootstrap_var_file or ["environments/dev.tfvars"],
        )
    except (KeyError, TypeError, ValueError, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError):
            print("IAM inventory comparison failed: a read-only command failed", file=sys.stderr)
        else:
            print(f"IAM inventory comparison failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
