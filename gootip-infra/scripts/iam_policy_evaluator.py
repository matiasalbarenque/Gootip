#!/usr/bin/env python3
"""Shared isolated Terraform evaluator for Gootip IAM policy guardrails.

The evaluator renders IAM policy documents from a Terraform root inside a
temporary directory that never touches AWS or canonical state:

* only an explicit ``local`` backend and empty local state are used;
* provider credentials are fake and metadata lookup is disabled;
* ``-refresh=false`` prevents any AWS read or write;
* references that only become known after apply are replaced with deterministic
  non-sensitive fixtures supplied by the caller.

It is the single rendering boundary shared by the Core/State split comparator
(``bootstrap/scripts/compare_bootstrap_policy_split.py``) and the IAM policy
guardrail checker (``scripts/check_iam_policy_guardrails.py``).
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterator, Mapping


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP_ROOT = REPOSITORY_ROOT / "bootstrap"
APPLICATION_ROOT = REPOSITORY_ROOT

# Provider plugin cache reused across isolated renders. When the caller sets
# TF_PLUGIN_CACHE_DIR it is honored unchanged; otherwise this conventional
# machine-wide cache is used and created on demand.
DEFAULT_PLUGIN_CACHE_DIR = Path.home() / ".terraform.d" / "plugin-cache"

# Generated into every isolated root so a plan never needs a configured backend
# or real credentials. The unused ``source_user`` alias is harmless for roots
# that do not reference it.
TERRAFORM_CONFIGURATION = '''terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "local" {}
}
'''

PROVIDER_CONFIGURATION = '''provider "aws" {
  region                      = var.aws_region
  access_key                  = "testing"
  secret_key                  = "testing"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  skip_region_validation      = true
}

provider "aws" {
  alias                       = "source_user"
  region                      = var.aws_region
  access_key                  = "testing"
  secret_key                  = "testing"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  skip_region_validation      = true
}
'''

# Files that must never be copied into an isolated root: backend configuration,
# saved plans, state, provider plugins, and local audit evidence.
EXCLUDED_SOURCE_FILES = frozenset(
    {"backend.tf", "backend.tf.example", "terraform.tfstate"}
)


@dataclass(frozen=True)
class IsolatedRoot:
    """Describes how one Terraform root is rendered in isolation.

    ``source_files`` are copied verbatim (minus ``substitutions``); ``variables``
    become ``-var`` flags; ``substitutions`` replace post-apply references with
    deterministic fixtures.
    """

    name: str
    source_root: Path
    source_files: tuple[str, ...]
    variables: Mapping[str, str] = field(default_factory=dict)
    substitutions: Mapping[str, str] = field(default_factory=dict)


# The bootstrap control-plane root. The split comparator renders it with the
# baseline-derived application-secret ARN substituted at call time.
BOOTSTRAP_CORE_STATE = IsolatedRoot(
    name="bootstrap",
    source_root=BOOTSTRAP_ROOT,
    source_files=("iam.tf", "secrets.tf", "state.tf", "variables.tf"),
    variables={
        "deployment_application_client_security_group_id": "sg-0123456789abcdef0",
        "deployment_db_tunnel_ami_id": "ami-0123456789abcdef0",
        "deployment_db_tunnel_subnet_id": "subnet-0123456789abcdef0",
        "account_resource_phase_enabled": "true",
        "eligibility_gate_passed": "true",
        "cutover_prerequisites_verified": "false",
        "source_user_cutover_enabled": "false",
    },
)

# Deterministic, non-sensitive fixtures for references that only become known
# after apply. They satisfy each root's variable validations and never leave the
# isolated temporary directory.
FIXTURE_ACCOUNT_ID = "123456789012"
FIXTURE_APPLICATION_SECRET_ARN = (
    f"arn:aws:secretsmanager:us-east-2:{FIXTURE_ACCOUNT_ID}:secret:gootip-auth-dev-AbC123"
)
FIXTURE_RDS_MASTER_SECRET_ARN = (
    f"arn:aws:secretsmanager:us-east-2:{FIXTURE_ACCOUNT_ID}:secret:rds!db-1a2b3c4d-5e6f-7a8b-9c0d-abcdef"
)
FIXTURE_SECRETS_MANAGER_KMS_KEY_ARN = (
    f"arn:aws:kms:us-east-2:{FIXTURE_ACCOUNT_ID}:key/e0638b06-ad54-4317-9670-694aaa5fc422"
)
FIXTURE_RUNTIME_BOUNDARY_ARN = (
    f"arn:aws:iam::{FIXTURE_ACCOUNT_ID}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary"
)
FIXTURE_AUTH_RUNTIME_SECRET_ARN = (
    f"arn:aws:secretsmanager:us-east-2:{FIXTURE_ACCOUNT_ID}:secret:gootip-dev-auth-runtime-Ab1Cd2"
)
FIXTURE_AUTH_MIGRATOR_SECRET_ARN = (
    f"arn:aws:secretsmanager:us-east-2:{FIXTURE_ACCOUNT_ID}:secret:gootip-dev-auth-migrator-Ef3Gh4"
)
FIXTURE_CORE_MIGRATOR_SECRET_ARN = (
    f"arn:aws:secretsmanager:us-east-2:{FIXTURE_ACCOUNT_ID}:secret:gootip-dev-core-migrator-Mn7Op8"
)
FIXTURE_CORE_RUNTIME_SECRET_ARN = (
    f"arn:aws:secretsmanager:us-east-2:{FIXTURE_ACCOUNT_ID}:secret:gootip-dev-core-runtime-Qr9St0"
)
FIXTURE_DB_OPERATOR_SECRET_ARN = (
    f"arn:aws:secretsmanager:us-east-2:{FIXTURE_ACCOUNT_ID}:secret:gootip-dev-db-operator-Ij5Kl6"
)

# Maximum approved configuration of the bootstrap control-plane root: every
# conditional policy and statement is present.
BOOTSTRAP_MAXIMUM = IsolatedRoot(
    name="bootstrap-maximum",
    source_root=BOOTSTRAP_ROOT,
    source_files=("iam.tf", "secrets.tf", "state.tf", "variables.tf"),
    variables={
        "deployment_application_client_security_group_id": "sg-0123456789abcdef0",
        "deployment_db_tunnel_ami_id": "ami-0123456789abcdef0",
        "deployment_db_tunnel_subnet_id": "subnet-0123456789abcdef0",
        "aws_account_id": FIXTURE_ACCOUNT_ID,
        "account_resource_phase_enabled": "true",
        "eligibility_gate_passed": "true",
        "cutover_prerequisites_verified": "true",
        "source_user_cutover_enabled": "true",
        "foundation_policy_expansion_enabled": "true",
        "secretsmanager_vpc_endpoint_id": "vpce-0123456789abcdef0",
        "application_secret_arn": FIXTURE_APPLICATION_SECRET_ARN,
        "rds_master_secret_arn": FIXTURE_RDS_MASTER_SECRET_ARN,
        "db_operator_secret_arn": FIXTURE_DB_OPERATOR_SECRET_ARN,
        "secrets_manager_kms_key_arn": FIXTURE_SECRETS_MANAGER_KMS_KEY_ARN,
    },
    substitutions={
        "aws_secretsmanager_secret.application[0].arn": json.dumps(FIXTURE_APPLICATION_SECRET_ARN),
    },
)

# Standing approved configuration of the bootstrap root: the transient
# foundation policy expansion is disabled. Used only for informational capacity
# reporting; it never relaxes the maximum-configuration checks.
BOOTSTRAP_STANDING = IsolatedRoot(
    name="bootstrap-standing",
    source_root=BOOTSTRAP_ROOT,
    source_files=("iam.tf", "secrets.tf", "state.tf", "variables.tf"),
    variables={
        "deployment_application_client_security_group_id": "sg-0123456789abcdef0",
        "deployment_db_tunnel_ami_id": "ami-0123456789abcdef0",
        "deployment_db_tunnel_subnet_id": "subnet-0123456789abcdef0",
        "aws_account_id": FIXTURE_ACCOUNT_ID,
        "account_resource_phase_enabled": "true",
        "eligibility_gate_passed": "true",
        "cutover_prerequisites_verified": "true",
        "source_user_cutover_enabled": "true",
        "foundation_policy_expansion_enabled": "false",
        "application_secret_arn": FIXTURE_APPLICATION_SECRET_ARN,
        "rds_master_secret_arn": FIXTURE_RDS_MASTER_SECRET_ARN,
        "db_operator_secret_arn": FIXTURE_DB_OPERATOR_SECRET_ARN,
        "secrets_manager_kms_key_arn": FIXTURE_SECRETS_MANAGER_KMS_KEY_ARN,
    },
    substitutions={
        "aws_secretsmanager_secret.application[0].arn": json.dumps(FIXTURE_APPLICATION_SECRET_ARN),
    },
)

# Render the optional human credential-operation roles separately so their
# managed policies remain covered without changing the standing/root maxima.
BOOTSTRAP_CREDENTIAL_OPERATIONS = replace(
    BOOTSTRAP_MAXIMUM,
    name="bootstrap-credential-operations",
    variables={
        **BOOTSTRAP_MAXIMUM.variables,
        "credential_role_lifecycle_enabled": "true",
        "credential_provisioner_role_enabled": "true",
        "credential_operator_role_enabled": "true",
        "auth_runtime_secret_arn": FIXTURE_AUTH_RUNTIME_SECRET_ARN,
        "core_runtime_secret_arn": FIXTURE_CORE_RUNTIME_SECRET_ARN,
    },
)

# SPEC 02.3 scope: the bootstrap diagnostics policy with its own read-only
# inventory flag enabled. Those statements belong to SPEC 02.3 and SPEC 03.1
# never renders them, so their capacity and wildcard review happen here instead
# of in the two bootstrap roots above.
BOOTSTRAP_DIAGNOSTICS = replace(
    BOOTSTRAP_MAXIMUM,
    name="bootstrap-diagnostics",
    variables={**BOOTSTRAP_MAXIMUM.variables, "diagnostics_inventory_enabled": "true"},
)

# SPEC 10 transition scope: the temporary creation, exact read/refresh, and
# foundation-read retirement grants coexist with all current exact role-secret
# ARNs. This checks the current partial-state recovery transition rather than the
# historical SPEC 03.1 apply-A configuration.
BOOTSTRAP_TRANSITION_VARIABLES = {
    **BOOTSTRAP_MAXIMUM.variables,
    "auth_runtime_secret_arn": FIXTURE_AUTH_RUNTIME_SECRET_ARN,
    "auth_migrator_secret_arn": FIXTURE_AUTH_MIGRATOR_SECRET_ARN,
    "core_runtime_secret_arn": FIXTURE_CORE_RUNTIME_SECRET_ARN,
    "core_migrator_secret_arn": FIXTURE_CORE_MIGRATOR_SECRET_ARN,
}
BOOTSTRAP_TRANSITION_VARIABLES["split_policy_creation_enabled"] = "true"
BOOTSTRAP_TRANSITION = replace(
    BOOTSTRAP_MAXIMUM,
    name="bootstrap-transition",
    variables=BOOTSTRAP_TRANSITION_VARIABLES,
)

# Maximum approved bootstrap configuration after the SPEC 03 role-secret ARN
# handoff: both exact role-secret ARNs are supplied, so the core's secret
# statements and the application runtime boundary carry them instead of the
# reviewed name patterns. With the transition render this is the largest document
# the repository produces, so the checker gates it against both size ceilings. It
# is not evaluated like a standing root because supplying the exact ARNs replaces
# the reviewed name-pattern wildcards, which would make the standing wildcard
# review stale.
BOOTSTRAP_ROLE_SECRET_MAXIMUM = replace(
    BOOTSTRAP_MAXIMUM,
    name="bootstrap-role-secret-maximum",
    variables={
        **BOOTSTRAP_MAXIMUM.variables,
        "auth_runtime_secret_arn": FIXTURE_AUTH_RUNTIME_SECRET_ARN,
        "auth_migrator_secret_arn": FIXTURE_AUTH_MIGRATOR_SECRET_ARN,
    },
)

# Maximum approved configuration of the application root: the deferred runtime
# policy and its attachments are present.
APPLICATION_MAXIMUM = IsolatedRoot(
    name="application-maximum",
    source_root=APPLICATION_ROOT,
    source_files=("iam.tf", "variables.tf"),
    variables={
        "aws_account_id": FIXTURE_ACCOUNT_ID,
        "application_runtime_deployment_enabled": "true",
        "core_runtime_deployment_enabled": "true",
        "better_auth_url": "https://auth.example.test",
        "app_secret_arn": FIXTURE_APPLICATION_SECRET_ARN,
        "application_runtime_boundary_arn": FIXTURE_RUNTIME_BOUNDARY_ARN,
        "rds_final_snapshot_identifier": "gootip-dev-final",
        "db_config_deployment_enabled": "true",
        "db_master_secret_arn": FIXTURE_RDS_MASTER_SECRET_ARN,
        "auth_runtime_secret_arn": FIXTURE_AUTH_RUNTIME_SECRET_ARN,
        "auth_migrator_secret_arn": FIXTURE_AUTH_MIGRATOR_SECRET_ARN,
        "db_operator_secret_arn": FIXTURE_DB_OPERATOR_SECRET_ARN,
        "auth_migrations_deployment_enabled": "true",
        "core_migrations_deployment_enabled": "true",
        "core_migrator_secret_arn": FIXTURE_CORE_MIGRATOR_SECRET_ARN,
        "core_runtime_secret_arn": FIXTURE_CORE_RUNTIME_SECRET_ARN,
        "core_migrations_runtime_boundary_arn": FIXTURE_RUNTIME_BOUNDARY_ARN,
        "alarm_notification_email": "observability-test@example.com",
        "rds_max_connections": "81",
        "monthly_cost_budget_usd": "10",
        "monthly_cost_budget_actual_threshold_percent": "80",
        "aws_billing_region": "us-east-1",
    },
    substitutions={
        "aws_db_instance.main.master_user_secret[0].secret_arn": json.dumps(
            FIXTURE_RDS_MASTER_SECRET_ARN
        ),
    },
)


def normalize(value: Any) -> Any:
    """Normalize IAM's order-insensitive statement fields for comparison."""
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return sorted(
            (normalize(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True)
        )
    return value


def normalized_statement(statement: Mapping[str, Any]) -> Any:
    """Reduce a statement to its IAM semantic fields, order-insensitively."""
    fields = ("Sid", "Effect", "Action", "Resource", "Condition", "NotAction", "NotResource")
    normalized = {field: statement[field] for field in fields if field in statement}
    for field in ("Action", "Resource", "NotAction", "NotResource"):
        if field in normalized and not isinstance(normalized[field], list):
            normalized[field] = [normalized[field]]
    return normalize(normalized)


def statements_by_sid(policy_document: Mapping[str, Any]) -> dict[str, Any]:
    """Index a rendered policy document's statements by their statement ID."""
    return {
        statement["Sid"]: normalized_statement(statement)
        for statement in policy_document.get("Statement", [])
    }


def iter_resources(plan: Mapping[str, Any]) -> Iterator[Mapping[str, Any]]:
    """Yield every planned resource, walking nested modules."""
    planned = plan.get("planned_values", {})
    root_module = planned.get("root_module", {})
    yield from _iter_module_resources(root_module)


def _iter_module_resources(module: Mapping[str, Any]) -> Iterator[Mapping[str, Any]]:
    yield from module.get("resources", [])
    for child in module.get("child_modules", []):
        yield from _iter_module_resources(child)


def resources_by_type(plan: Mapping[str, Any], resource_type: str) -> list[Mapping[str, Any]]:
    """Return every planned resource of ``resource_type``."""
    return [resource for resource in iter_resources(plan) if resource.get("type") == resource_type]


def policy_from_plan(plan: Mapping[str, Any], address: str) -> dict[str, Any]:
    """Return a rendered IAM policy document for a planned ``aws_iam_policy``."""
    for resource in iter_resources(plan):
        if resource.get("address") == address:
            return json.loads(resource["values"]["policy"])
    raise KeyError(f"The plan does not materialize {address}.")


def render_plan(
    isolated_root: IsolatedRoot,
    *,
    variables: Mapping[str, str] | None = None,
    substitutions: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Render an isolated root and return its Terraform plan as JSON.

    The temporary directory and every generated artifact are removed on success
    and failure. No AWS request is performed.
    """
    configured = replace(
        isolated_root,
        variables={**isolated_root.variables, **(variables or {})},
        substitutions={**isolated_root.substitutions, **(substitutions or {})},
    )
    return render_plans([configured])[configured.name]


def render_plans(isolated_roots: list[IsolatedRoot]) -> dict[str, dict[str, Any]]:
    """Render named configurations, sharing one initialized directory per source group."""
    groups: dict[tuple[Path, tuple[str, ...], tuple[tuple[str, str], ...]], list[IsolatedRoot]] = defaultdict(list)
    for root in isolated_roots:
        groups[(root.source_root, root.source_files, tuple(sorted(root.substitutions.items())))].append(root)
    plans: dict[str, dict[str, Any]] = {}
    for (source_root, source_files, substitutions), roots in groups.items():
        representative = roots[0]
        with tempfile.TemporaryDirectory(prefix=f"iam-policy-{representative.name}-") as temporary:
            directory = Path(temporary)
            _write_isolated_root(representative, directory, dict(substitutions))
            subprocess.run(
                ["terraform", "init", "-reconfigure"], cwd=directory, check=True,
                env=plugin_cache_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            for root in roots:
                _run_terraform_plan(directory, root.variables, initialize=False)
                plans[root.name] = _read_plan(directory)
    return plans


def _write_isolated_root(
    isolated_root: IsolatedRoot, directory: Path, substitutions: Mapping[str, str]
) -> None:
    for filename in isolated_root.source_files:
        if filename in EXCLUDED_SOURCE_FILES:
            raise ValueError(f"{filename} is never copied into an isolated root.")
        contents = (isolated_root.source_root / filename).read_text()
        for reference, fixture in substitutions.items():
            contents = contents.replace(reference, fixture)
        (directory / filename).write_text(contents)

    (directory / "main.tf").write_text(TERRAFORM_CONFIGURATION)
    (directory / "providers.tf").write_text(PROVIDER_CONFIGURATION)


def plugin_cache_env() -> dict[str, str]:
    """Return the subprocess environment with an absolute provider cache.

    The caller's TF_PLUGIN_CACHE_DIR wins when it is non-empty; otherwise the
    default machine-wide cache is used. A relative value is normalized against
    the current directory so Terraform and this process agree on one absolute
    path, and the directory is created if missing.
    """
    env = dict(os.environ)
    cache = env.get("TF_PLUGIN_CACHE_DIR") or str(DEFAULT_PLUGIN_CACHE_DIR)
    cache = os.path.abspath(os.path.expanduser(cache))
    Path(cache).mkdir(parents=True, exist_ok=True)
    env["TF_PLUGIN_CACHE_DIR"] = cache
    return env


def _run_terraform_plan(directory: Path, variables: Mapping[str, str], *, initialize: bool = True) -> None:
    if initialize:
        subprocess.run(
            ["terraform", "init", "-reconfigure"], cwd=directory, check=True,
            env=plugin_cache_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    command = ["terraform", "plan", "-refresh=false", "-out=policy.tfplan"]
    command.extend(f"-var={name}={value}" for name, value in variables.items())
    subprocess.run(
        command,
        cwd=directory,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _read_plan(directory: Path) -> dict[str, Any]:
    output = subprocess.check_output(
        ["terraform", "show", "-json", "policy.tfplan"], cwd=directory
    )
    return json.loads(output)
