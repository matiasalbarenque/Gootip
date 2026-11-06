#!/usr/bin/env python3
"""Enforce the Gootip IAM policy capacity and coverage guardrails.

The checker renders every Gootip customer managed policy in both Terraform roots
through the shared isolated evaluator and enforces:

* a 4,500-character warning and 5,500-character failure budget per policy
  (measured on the rendered document with whitespace removed);
* an eight-attachment warning and ten-attachment failure budget per role,
  counting every managed policy attachment and excluding permissions boundaries;
* complete coverage: every declared ``aws_iam_policy`` must be rendered, no
  policy identity may be duplicated, and no inline policy is permitted;
* one reviewed wildcard justification per wildcard action or resource;
* unique statement IDs inside each policy document.

It prints a deterministic summary that contains only Terraform addresses, policy
names, counts, and finding codes. No account ID, ARN, plan, state, or policy
document is printed or written.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping


sys.path.insert(0, str(Path(__file__).resolve().parent))

from iam_policy_evaluator import (  # noqa: E402
    APPLICATION_MAXIMUM,
    BOOTSTRAP_DIAGNOSTICS,
    BOOTSTRAP_CREDENTIAL_OPERATIONS,
    BOOTSTRAP_MAXIMUM,
    BOOTSTRAP_ROLE_SECRET_MAXIMUM,
    BOOTSTRAP_STANDING,
    BOOTSTRAP_TRANSITION,
    FIXTURE_ACCOUNT_ID,
    IsolatedRoot,
    iter_resources,
    normalized_statement,
    render_plan,
)


SIZE_WARNING = 4_500
SIZE_FAILURE = 5_500
AWS_SIZE_LIMIT = 6_144
ATTACHMENT_WARNING = 8
ATTACHMENT_FAILURE = 10

# SPEC 10 transition gate. The temporary creation/read/retirement grants render
# with all current exact role-secret ARNs; keep the core below both repository and
# AWS limits. The 5,800 transition ceiling accommodates the exact ListPolicyVersions
# recovery grant while retaining 344 characters of headroom under AWS's 6,144 limit.
TRANSITION_POLICY_ADDRESS = "aws_iam_policy.bootstrap_permissions"
TRANSITION_SIZE_LIMIT = 5_800
ROLE_SECRET_TRANSITION_SIZE_LIMIT = 5_500

# The temporary transition carries exact policy creation plus the read/retirement
# grants needed to refresh and remove foundation-read. All disappear in cleanup.
TRANSITION_RETAINED_SIDS = frozenset(
    {
        "CreateExactSplitPolicies",
        "ReadExactFoundationRetirementTargets",
        "DeleteExactRetiredFoundationReadPolicy",
        "ListVersionsExactRetiredFoundationReadPolicy",
    }
)
TRANSITION_WITHDRAWN_SIDS = frozenset(
    {
        "ManageExactHumanRolesAndPolicies",
        "ManageExactSplitPolicyTags",
        "CreateExactAdministrativePassRolePolicy",
    }
)

POLICY_RESOURCE_TYPE = "aws_iam_policy"
INLINE_POLICY_RESOURCE_TYPES = (
    "aws_iam_role_policy",
    "aws_iam_user_policy",
    "aws_iam_group_policy",
)
ROLE_ATTACHMENT_TYPES = ("aws_iam_role_policy_attachment", "aws_iam_policy_attachment")
CREDENTIAL_LIFECYCLE_INLINE_ADDRESS = "aws_iam_role_policy.credential_role_lifecycle"
CREDENTIAL_LIFECYCLE_POLICY_NAME = "GootipCredentialRoleLifecycle"
CREDENTIAL_OPERATION_POLICY_ADDRESSES = {
    "aws_iam_policy.credential_operator_permissions",
    "aws_iam_policy.credential_provisioner_permissions",
}
CREDENTIAL_LIFECYCLE_STATEMENTS = {
    "ManageExactCredentialProvisionerRole": (
        {
            "iam:AttachRolePolicy",
            "iam:CreateRole",
            "iam:DeleteRole",
            "iam:DetachRolePolicy",
            "iam:GetRole",
            "iam:ListAttachedRolePolicies",
            "iam:ListInstanceProfilesForRole",
            "iam:ListRolePolicies",
            "iam:TagRole",
            "iam:UntagRole",
            "iam:UpdateAssumeRolePolicy",
            "iam:UpdateRole",
        },
        f"arn:aws:iam::{FIXTURE_ACCOUNT_ID}:role/gootip/operations/GootipCredentialProvisioner",
    ),
    "ManageExactCredentialProvisionerPolicy": (
        {
            "iam:CreatePolicy",
            "iam:CreatePolicyVersion",
            "iam:DeletePolicy",
            "iam:DeletePolicyVersion",
            "iam:GetPolicy",
            "iam:GetPolicyVersion",
            "iam:ListPolicyTags",
            "iam:ListPolicyVersions",
            "iam:SetDefaultPolicyVersion",
            "iam:TagPolicy",
            "iam:UntagPolicy",
        },
        f"arn:aws:iam::{FIXTURE_ACCOUNT_ID}:policy/gootip/operations/GootipCredentialProvisionerPermissions",
    ),
    "ManageExactCredentialOperatorRole": (
        {
            "iam:AttachRolePolicy",
            "iam:CreateRole",
            "iam:DeleteRole",
            "iam:DetachRolePolicy",
            "iam:GetRole",
            "iam:ListAttachedRolePolicies",
            "iam:ListInstanceProfilesForRole",
            "iam:ListRolePolicies",
            "iam:TagRole",
            "iam:UntagRole",
            "iam:UpdateAssumeRolePolicy",
            "iam:UpdateRole",
        },
        f"arn:aws:iam::{FIXTURE_ACCOUNT_ID}:role/gootip/operations/GootipCredentialOperator",
    ),
    "ManageExactCredentialOperatorPolicy": (
        {
            "iam:CreatePolicy",
            "iam:CreatePolicyVersion",
            "iam:DeletePolicy",
            "iam:DeletePolicyVersion",
            "iam:GetPolicy",
            "iam:GetPolicyVersion",
            "iam:ListPolicyTags",
            "iam:ListPolicyVersions",
            "iam:SetDefaultPolicyVersion",
            "iam:TagPolicy",
            "iam:UntagPolicy",
        },
        f"arn:aws:iam::{FIXTURE_ACCOUNT_ID}:policy/gootip/operations/GootipCredentialOperatorPermissions",
    ),
}

DECLARED_POLICY_PATTERN = re.compile(r'resource\s+"aws_iam_policy"\s+"([A-Za-z0-9_]+)"')
INDEX_SUFFIX_PATTERN = re.compile(r"\[\d+\]$")
INSTANCE_SUFFIX_PATTERN = re.compile(r"\[[^\]]+\]$")

# Every wildcard action or resource in a Gootip customer managed policy must be
# recorded here with the AWS authorization reason that forces it. The key is the
# physical policy name, the statement ID, and the wildcard field. A wildcard
# without an entry, or an entry without a wildcard, fails the check.
REVIEWED_WILDCARDS: dict[tuple[str, str, str], str] = {
    ("GootipApplicationRuntimeBoundary", "DenyIamAndStsEscalation", "Resource"):
        "IAM and STS escalation denies must cover every resource.",
    ("GootipApplicationRuntimeBoundary", "DenyHumanAndStateBucketAccess", "Resource"):
        "The deny must cover every object version in the state bucket.",
    ("GootipApplicationRuntimeBoundary", "AllowOnlyApprovedRuntimeLogStreams", "Resource"):
        "Lambda log streams share a fixed log-group prefix with dynamic suffixes.",
    ("GootipApplicationRuntimeBoundary", "AllowLambdaVpcInterfaceOperationsInConfiguredRegion", "Resource"):
        "Lambda VPC interface actions have no resource-level scope.",
    ("GootipBootstrapDiagnosticsPermissions", "LookupFoundationCloudTrailEventsInRegion", "Resource"):
        "cloudtrail:LookupEvents has no resource-level scope.",
    ("GootipBootstrapDiagnosticsPermissions", "ValidateGootipPoliciesInConfiguredRegion", "Resource"):
        "access-analyzer:ValidatePolicy has no resource-level scope.",
    ("GootipBootstrapAdminPermissions", "ListKmsAliasesInFoundationRegion", "Resource"):
        "kms:ListAliases has no resource-level scope.",
    ("GootipBootstrapAdminPermissions", "RemoveSourceUserFromAccountGroups", "Resource"):
        "RemoveUserFromGroup evaluates against group ARNs unknown before cutover.",
    ("GootipBootstrapAdminPermissions", "ManageExactApprovedSecretContainers", "Resource"):
        "The role-secret containers are addressed by name pattern until both reviewed ARNs exist.",
    ("GootipDatabaseOperatorPermissions", "DiscoverTaggedDbTunnelResources", "Resource"):
        "EC2 and Instance Connect discovery actions have no resource-level authorization scope.",
    ("GootipDatabaseOperatorPermissions", "StartAndStopTaggedDbTunnelInstance", "Resource"):
        "Instance start and stop are scoped by the reviewed resource tags on the instance ARN pattern.",
    ("GootipDatabaseOperatorPermissions", "SendPublicKeyToTaggedDbTunnelInstance", "Resource"):
        "Public-key delivery is scoped by the reviewed resource tags on the instance ARN pattern.",
    ("GootipDatabaseOperatorPermissions", "OpenTunnelToTaggedDbTunnelEndpoint", "Resource"):
        "Tunnel creation is scoped by resource tags, remote port, and duration on the endpoint ARN pattern.",
    ("GootipTerraformDeployPermissions", "DenySecretsManagerMutationAndValues", "Resource"):
        "The deny must cover every secret.",
    ("GootipTerraformDeployPermissions", "DenyNonRdsSecretsManagerCreateAndTag", "NotResource"):
        "The deny targets every secret except the RDS-managed pattern.",
    ("GootipTerraformDeployApiGatewayPermissions", "TagOnlyNewGootipHttpApi", "Resource"):
        "API Gateway v2 authorizes CreateApi tagging on /tags/<encoded API ARN>; the API-ID wildcard is limited to /v2/apis and exact Gootip request tags.",
    ("GootipTerraformDeployAuthMigrationsPermissions", "CreateTaggedAuthMigrationsLogGroup", "Resource"):
        "CloudWatch Logs does not propagate request tags to its composed create authorization; Region, request tags, and TagKeys bound the single create action.",
    ("GootipTerraformDeployObservabilityPermissions", "CreateObsLogGroups", "Resource"):
        "CloudWatch Logs requires Resource * for CreateLogGroup; exact Region, three Name values, required Gootip tags, and TagKeys bound creation.",
    ("GootipTerraformDeployApplicationPermissions", "CreateApiObsLogGroups", "Resource"):
        "CloudWatch Logs requires Resource * for CreateLogGroup; exact Region, Core log-group name, required Gootip tags, and TagKeys bound creation.",
    ("GootipTerraformDeployApplicationPermissions", "ManageApiFunctions", "Resource"):
        "Only the exact Core function and shared RDS CA layer are named; the layer ARN requires a version wildcard.",
    ("GootipTerraformDeployObservabilityPermissions", "ManageObsEmail", "Resource"):
        "SNS assigns the subscription ID at Subscribe time; this ARN pattern is confined to subscriptions of the exact Gootip alarm topic.",
    ("GootipTerraformDeployObservabilityPermissions", "ReadBillingPrefs", "Resource"):
        "billing:GetBillingPreferences has no resource type; it is read-only and constrained to the global Budgets/Billing API Region.",
    ("GootipTerraformDeployAuthMigrationsPermissions", "DescribeDevLogGroups", "Resource"):
        "logs:DescribeLogGroups has no resource-level scope; the Region condition is the boundary.",
    ("GootipTerraformDeployCoreMigrationsPermissions", "CreateTaggedCoreMigrationsLogGroup", "Resource"):
        "CloudWatch Logs log-group creation is Region-scoped and requires the exact Core name and request tags.",
    ("GootipTerraformDeployCoreMigrationsPermissions", "DescribeCoreMigrationsLogGroupsInRegion", "Resource"):
        "logs:DescribeLogGroups has no resource-level scope; the Region condition is the boundary.",
    ("GootipTerraformDeployCoreMigrationsPermissions", "ReadExactCoreMigrationsVersions", "Resource"):
        "Published Lambda version reads use the exact function ARN with a version suffix.",
    (
        "GootipTerraformDeployApplicationPermissions",
        "ReadAuthApiLogStreams",
        "Resource",
    ): "CloudWatch assigns stream names dynamically; access is limited to streams in the two exact Auth API log groups.",
    ("GootipTerraformDeployCoreMigrationsPermissions", "ReadExactRdsCaLayerVersionsForCoreMigrations", "Resource"):
        "The migration function reads versions only from the shared RDS CA layer.",
    ("gootip-auth-dev-logs", "WriteOnlyOwnLogStreams", "Resource"):
        "CloudWatch log stream ARNs require a wildcard suffix under the exact managed group.",
    ("lambda_db_config-logs", "WriteOnlyOwnLogStreams", "Resource"):
        "CloudWatch log stream ARNs require a wildcard suffix under the exact managed group.",
    ("gootip-dev-auth-migrations-logs", "WriteOnlyOwnLogStreams", "Resource"):
        "CloudWatch log stream ARNs require a wildcard suffix under the exact managed group.",
    ("gootip-dev-core-migrations-logs", "WriteOnlyOwnLogStreams", "Resource"):
        "CloudWatch log stream ARNs require a wildcard suffix under the exact managed group.",
    ("gootip-auth-dev-vpc", "AllowLambdaVpcInterfaceOperationsInConfiguredRegion", "Resource"):
        "Lambda VPC interface actions have no resource-level scope.",
    ("gootip-auth-dev-vpc", "DenyFunctionCodeVpcInterfaceOperations", "Resource"):
        "The source-function conditional deny must cover every interface action resource.",
    ("lambda_db_config-vpc", "AllowLambdaVpcInterfaceOperationsInConfiguredRegion", "Resource"):
        "Lambda VPC interface actions have no resource-level scope.",
    ("lambda_db_config-vpc", "DenyFunctionCodeVpcInterfaceOperations", "Resource"):
        "The source-function conditional deny must cover every interface action resource.",
    ("gootip-dev-auth-migrations-vpc", "AllowLambdaVpcInterfaceOperationsInConfiguredRegion", "Resource"):
        "Lambda VPC interface actions have no resource-level scope.",
    ("gootip-dev-auth-migrations-vpc", "DenyFunctionCodeVpcInterfaceOperations", "Resource"):
        "The source-function conditional deny must cover every interface action resource.",
    ("gootip-dev-core-migrations-vpc", "AllowLambdaVpcInterfaceOperationsInConfiguredRegion", "Resource"):
        "Lambda VPC interface actions have no resource-level scope.",
    ("gootip-dev-core-migrations-vpc", "DenyFunctionCodeVpcInterfaceOperations", "Resource"):
        "The source-function conditional deny must cover every interface action resource.",
    ("gootip-core-dev-logs", "WriteOnlyOwnLogStreams", "Resource"):
        "CloudWatch log stream ARNs require a wildcard suffix under the exact managed group.",
    ("gootip-core-dev-vpc", "AllowLambdaVpcInterfaceOperationsInConfiguredRegion", "Resource"):
        "Lambda VPC interface actions have no resource-level scope.",
    ("gootip-core-dev-vpc", "DenyFunctionCodeVpcInterfaceOperations", "Resource"):
        "The source-function conditional deny must cover every interface action resource.",
    ("GootipTerraformDeployAuthMigrationsPermissions", "ManageDevLogTags", "Resource"):
        "Temporary logging shortcut until the auth-migrations log group ARN replaces the Region-scoped tag operations.",
    ("GootipTerraformDeployAuthMigrationsPermissions", "ReadExactAuthMigrationsVersions", "Resource"):
        "Version-qualified Lambda reads use an exact function ARN with a version suffix pattern.",
    ("GootipTerraformDeployNetworkPermissions", "RevokeIngressAndDeleteTaggedFoundationSecurityGroups", "Resource"):
        "Ingress revoke and delete are scoped by resource tags rather than a fixed ARN.",
    ("GootipTerraformDeployNetworkPermissions", "CreateFoundationNetworkResources", "Resource"):
        "EC2 create APIs cannot name future VPC resources.",
    ("GootipTerraformDeployNetworkPermissions", "TagFoundationNetworkResources", "Resource"):
        "CreateTags targets resources that do not exist yet.",
    ("GootipTerraformDeployNetworkPermissions", "ReadAndAssociateFoundationNetworkResources", "Resource"):
        "Network associations and reads have no stable ARNs before the foundation exists.",
    ("GootipTerraformDeployNetworkPermissions", "RevokeEgressOnlyFromTaggedFoundationSecurityGroups", "Resource"):
        "Egress revoke is scoped by resource tags rather than a fixed ARN.",
    ("GootipTerraformDeployNetworkPermissions", "RunTaggedDbTunnelInstance", "Resource"):
        "The tagged instance and root volume do not exist when RunInstances authorizes them.",
    ("GootipTerraformDeployNetworkPermissions", "CreateDbTunnelInfrastructure", "Resource"):
        "The primary network interface does not exist when RunInstances is authorized.",
    ("GootipTerraformDeployNetworkPermissions", "UseDbTunnelSecurityGroups", "Resource"):
        "RunInstances and endpoint creation authorize against the two named tunnel security groups by tags.",
    ("GootipTerraformDeployNetworkPermissions", "CreateDbTunnelEndpointNetworkInterfaces", "Resource"):
        "The endpoint network interface is created in a subnet selected at apply time.",
    ("GootipTerraformDeployNetworkPermissions", "TagDbTunnelEndpointNetworkInterfaces", "Resource"):
        "The endpoint service tags its own network interface with the reviewed purpose tag set.",
    ("GootipTerraformDeployNetworkPermissions", "ReadDbTunnelResources", "Resource"):
        "EC2 tunnel discovery actions have no resource-level scope.",
    ("GootipTerraformDeployNetworkPermissions", "ManageTaggedDbTunnelResources", "Resource"):
        "Start, stop, update, and termination are scoped by resource tags on the instance pattern.",
    ("GootipTerraformDeployNetworkPermissions", "ManageTaggedDbTunnelEndpoint", "Resource"):
        "Endpoint update and deletion are scoped by resource tags on the endpoint pattern.",
    ("GootipTerraformDeployDatabasePermissions", "ReadFoundationRdsAccountAttributes", "Resource"):
        "rds:DescribeAccountAttributes has no resource-level scope.",
    ("GootipTerraformDeployDatabasePermissions", "CreateProtectedFoundationRdsResources", "Resource"):
        "RDS create APIs cannot name future resources.",
    ("GootipTerraformDeployDatabasePermissions", "AllowRdsEngineAndOrderableDiscovery", "Resource"):
        "RDS engine and orderable discovery have no resource type.",
    ("GootipTerraformDeployDatabasePermissions", "DiscoverGootipRdsInstancesInRegion", "Resource"):
        "RDS instance discovery uses the account and Region DB pattern.",
    ("GootipTerraformDeployDatabasePermissions", "CreateOnlyRdsManagedMasterSecret", "Resource"):
        "The RDS-managed secret name is generated after DB creation.",
    ("GootipTerraformDeployDatabasePermissions", "TagOnlyRdsManagedMasterSecrets", "Resource"):
        "The RDS-managed secret name is generated after DB creation.",
    ("GootipTerraformDeployDatabasePermissions", "ReadUpgradeRdsSnapshotMetadataInRegion", "Resource"):
        "rds:DescribeDBSnapshots has no resource-level scope; the Region condition is the boundary.",
    ("GootipTerraformDeployDatabasePermissions", "ReadUpgradeRdsPendingMaintenanceInRegion", "Resource"):
        "rds:DescribePendingMaintenanceActions has no resource-level scope; the Region condition is the boundary.",
    ("GootipTerraformDeployPermissions", "ReadExactRdsCaLayerVersions", "Resource"):
        "Layer version reads use the fixed layer name plus a version suffix.",
    ("GootipTerraformDeployPermissions", "ReadCloudWatchMetricDataInRegion", "Resource"):
        "Standard CloudWatch metric reads require Resource *; the configured Region is the boundary.",
    ("GootipTerraformDeployPermissions", "ReadFoundationServiceQuotas", "Resource"):
        "servicequotas:ListServiceQuotas has no resource-level scope.",
    ("GootipTerraformDeployPermissions", "ReadFreeTierEligibilityAndUsage", "Resource"):
        "Free Tier reads have no resource-level scope.",
    ("GootipSourceUserAssumeOnlyBoundary", "AllowMfaSessionCreation", "Resource"):
        "sts:GetSessionToken has no resource-level scope.",
    ("GootipSourceUserAssumeOnlyBoundary", "DenyEverythingExceptMfaSessionAndApprovedRoleAssumption", "Resource"):
        "The boundary deny must cover every resource.",
}


def classify_size(size: int) -> str:
    """Classify a policy's non-whitespace size as healthy, warning, or failure."""
    if size >= SIZE_FAILURE:
        return "failure"
    if size >= SIZE_WARNING:
        return "warning"
    return "healthy"


def classify_attachments(count: int) -> str:
    """Classify a role's managed-policy attachment count."""
    if count > ATTACHMENT_FAILURE:
        return "failure"
    if count >= ATTACHMENT_WARNING:
        return "warning"
    return "healthy"


def exceeds_aws_limit(size: int) -> bool:
    """Whether a policy exceeds the AWS customer managed-policy hard limit."""
    return size > AWS_SIZE_LIMIT


def normalize_address(address: str) -> str:
    """Strip a numeric count index while preserving distinct for_each keys."""
    return INDEX_SUFFIX_PATTERN.sub("", address)


def declaration_address(address: str) -> str:
    """Return the Terraform declaration address for any resource instance."""
    return INSTANCE_SUFFIX_PATTERN.sub("", address)


def declared_policy_addresses(root: Path) -> set[str]:
    """Return every ``aws_iam_policy`` address declared in a Terraform root."""
    addresses: set[str] = set()
    for path in sorted(root.glob("*.tf")):
        for name in DECLARED_POLICY_PATTERN.findall(path.read_text()):
            addresses.add(f"{POLICY_RESOURCE_TYPE}.{name}")
    return addresses


def rendered_inline_policies(plan: Mapping[str, Any]) -> set[str]:
    """Return every inline policy that the plan actually materializes.

    Coverage is measured on the rendered plan rather than the source text, so a
    reviewed, count-gated temporary inline policy that is disabled in the
    approved configuration (for example ``role_secret_creation`` with its flag
    off) is not reported, while any inline policy that is actually in effect is.
    """
    return {
        normalize_address(resource["address"])
        for resource in iter_resources(plan)
        if resource.get("type") in INLINE_POLICY_RESOURCE_TYPES
    }


def non_whitespace_length(text: str) -> int:
    """Count the characters IAM counts against the managed-policy quota."""
    return sum(1 for character in text if not character.isspace())


def statement_wildcards(document: Mapping[str, Any]) -> set[tuple[str, str]]:
    """Return the ``(Sid, field)`` wildcards in a rendered policy document."""
    wildcards: set[tuple[str, str]] = set()
    for statement in document.get("Statement", []):
        normalized = normalized_statement(statement)
        sid = normalized.get("Sid")
        for field in ("Action", "NotAction"):
            for element in normalized.get(field, []):
                if element == "*" or element.endswith(":*"):
                    wildcards.add((sid, field))
        for field in ("Resource", "NotResource"):
            for element in normalized.get(field, []):
                if "*" in element:
                    wildcards.add((sid, field))
    return wildcards


def duplicate_sids(document: Mapping[str, Any]) -> set[str]:
    """Return statement IDs that appear more than once in a policy document."""
    seen: set[str] = set()
    duplicates: set[str] = set()
    for statement in document.get("Statement", []):
        sid = statement.get("Sid")
        if sid in seen:
            duplicates.add(sid)
        seen.add(sid)
    return duplicates


def attachment_counts(plan: Mapping[str, Any]) -> dict[str, int]:
    """Count managed-policy attachments per role name."""
    counts: dict[str, int] = {}
    for resource in iter_resources(plan):
        if resource.get("type") not in ROLE_ATTACHMENT_TYPES:
            continue
        values = resource.get("values", {})
        roles = values.get("roles") if resource.get("type") == "aws_iam_policy_attachment" else None
        role_names = list(roles) if roles else [values.get("role")]
        for role in role_names:
            if role:
                counts[role] = counts.get(role, 0) + 1
    return counts


def role_boundaries(plan: Mapping[str, Any]) -> dict[str, Any]:
    """Return the declared permissions boundary per role name (reported separately)."""
    boundaries: dict[str, Any] = {}
    for resource in iter_resources(plan):
        if resource.get("type") == "aws_iam_role":
            values = resource.get("values", {})
            boundaries[values.get("name")] = values.get("permissions_boundary")
    return boundaries


class Report:
    """Collects deterministic findings and renders the summary."""

    def __init__(self) -> None:
        self.failures: list[str] = []
        self.warnings: list[str] = []
        self.lines: list[str] = []
        self.observed_wildcards: set[tuple[str, str, str]] = set()

    def evaluate_root(self, spec: IsolatedRoot) -> None:
        self.evaluate_plan(spec.name, spec.source_root, render_plan(spec))

    def evaluate_plan(self, name: str, source_root: Path, plan: Mapping[str, Any]) -> None:
        declared = declared_policy_addresses(source_root)
        rendered: dict[str, Mapping[str, Any]] = {}
        for resource in iter_resources(plan):
            if resource.get("type") == POLICY_RESOURCE_TYPE:
                rendered[normalize_address(resource["address"])] = resource

        rendered_declarations = {
            declaration_address(address) for address in rendered
        }

        self.lines.append(f"root: {name}")

        unrendered = declared - rendered_declarations
        if name != "bootstrap-credential-operations":
            # These count-gated policies are checked together in their dedicated
            # credential-operations render, not expected in every other fixture.
            unrendered -= CREDENTIAL_OPERATION_POLICY_ADDRESSES
        for address in sorted(unrendered):
            self.failures.append(f"UNRENDERED_POLICY {address}")
        for address in sorted(rendered_declarations - declared):
            self.failures.append(f"UNDECLARED_POLICY {address}")
        inline_addresses = rendered_inline_policies(plan)
        if name == "bootstrap-credential-operations":
            if inline_addresses != {CREDENTIAL_LIFECYCLE_INLINE_ADDRESS}:
                self.failures.append(
                    f"CREDENTIAL_LIFECYCLE_INLINE_COVERAGE expected={CREDENTIAL_LIFECYCLE_INLINE_ADDRESS} "
                    f"actual={sorted(inline_addresses)}"
                )
            for resource in iter_resources(plan):
                if normalize_address(resource.get("address", "")) == CREDENTIAL_LIFECYCLE_INLINE_ADDRESS:
                    self._check_credential_lifecycle_inline(resource)
        else:
            for address in sorted(inline_addresses):
                self.failures.append(f"INLINE_POLICY {address}")

        identities: dict[tuple[Any, Any], str] = {}
        for address in sorted(rendered):
            resource = rendered[address]
            values = resource.get("values", {})
            policy_name = values.get("name")
            identity = (values.get("path"), policy_name)
            if identity in identities:
                self.failures.append(
                    f"DUPLICATE_POLICY_IDENTITY {address} name={policy_name} also={identities[identity]}"
                )
            identities[identity] = address

            policy_text = values.get("policy")
            if not isinstance(policy_text, str):
                self.failures.append(f"UNKNOWN_POLICY_DOCUMENT {address} name={policy_name}")
                continue

            document = json.loads(policy_text)
            size = non_whitespace_length(policy_text)
            self.lines.append(
                f"  policy {address} name={policy_name} size={size} "
                f"statements={len(document.get('Statement', []))}"
            )
            self._check_size(address, policy_name, size)
            self._check_sids(address, policy_name, document)
            self._check_wildcards(address, policy_name, document)

        for role, count in sorted(attachment_counts(plan).items()):
            self._check_attachments(role, count)
        for role, boundary in sorted(role_boundaries(plan).items()):
            if boundary:
                self.lines.append(f"  boundary role={role} present")

    def check_transition_core(self, plan: Mapping[str, Any]) -> None:
        """Gate the SPEC 03.1 transition core against its size and SID contract.

        Apply A sends the retained core with the temporary split-creation grant,
        the largest document this repository produces. It must stay below the
        repository transition limit and below the AWS hard limit, and it must
        carry exactly the two transition SIDs: the new grant plus the single
        retained lifecycle statement. This render is not evaluated like a
        standing root because the transition is expected to use the 4,500-5,499
        warning band.
        """
        for resource in iter_resources(plan):
            if normalize_address(resource.get("address", "")) != TRANSITION_POLICY_ADDRESS:
                continue
            policy_text = resource.get("values", {}).get("policy")
            if not isinstance(policy_text, str):
                self.failures.append(f"UNKNOWN_TRANSITION_POLICY {TRANSITION_POLICY_ADDRESS}")
                return
            document = json.loads(policy_text)
            statements = document.get("Statement", [])
            size = non_whitespace_length(policy_text)
            self.lines.append(
                f"  transition {TRANSITION_POLICY_ADDRESS} size={size} "
                f"limit={TRANSITION_SIZE_LIMIT} aws_limit={AWS_SIZE_LIMIT} "
                f"statements={len(statements)}"
            )
            if size >= TRANSITION_SIZE_LIMIT:
                self.failures.append(
                    f"TRANSITION_POLICY_SIZE_FAILURE {TRANSITION_POLICY_ADDRESS} "
                    f"size={size} limit={TRANSITION_SIZE_LIMIT}"
                )
            if exceeds_aws_limit(size):
                self.failures.append(
                    f"TRANSITION_POLICY_SIZE_OVER_AWS_LIMIT {TRANSITION_POLICY_ADDRESS} "
                    f"size={size} limit={AWS_SIZE_LIMIT}"
                )
            sids = {statement.get("Sid") for statement in statements}
            missing = TRANSITION_RETAINED_SIDS - sids
            if missing:
                self.failures.append(
                    f"TRANSITION_MISSING_SIDS {TRANSITION_POLICY_ADDRESS} missing={sorted(missing)}"
                )
            unexpected = TRANSITION_WITHDRAWN_SIDS & sids
            if unexpected:
                self.failures.append(
                    f"TRANSITION_UNEXPECTED_SIDS {TRANSITION_POLICY_ADDRESS} "
                    f"present={sorted(unexpected)}"
                )
            return
        self.failures.append(f"MISSING_TRANSITION_POLICY {TRANSITION_POLICY_ADDRESS}")

    def check_role_secret_maximum(self, plan: Mapping[str, Any]) -> None:
        """Gate every policy in the maximum role-secret handoff render.

        Supplying the two exact role-secret ARNs grows the bootstrap core's secret
        statements and the application runtime boundary to their largest approved
        shape. Every managed policy in that render must stay below the repository
        transition limit and below the AWS hard limit, so the SPEC 03 handoff can
        never reintroduce the quota failure the split removed.
        """
        worst = ("", 0)
        for resource in iter_resources(plan):
            if resource.get("type") != "aws_iam_policy":
                continue
            policy_text = resource.get("values", {}).get("policy")
            if not isinstance(policy_text, str):
                self.failures.append(
                    f"UNKNOWN_ROLE_SECRET_MAXIMUM_POLICY {normalize_address(resource['address'])}"
                )
                continue
            address = normalize_address(resource["address"])
            size = non_whitespace_length(policy_text)
            if size > worst[1]:
                worst = (address, size)
            policy_name = resource.get("values", {}).get("name")
            limit = (
                AWS_SIZE_LIMIT
                if policy_name == "GootipTerraformDeployObservabilityPermissions"
                else ROLE_SECRET_TRANSITION_SIZE_LIMIT
            )
            if size >= limit:
                self.failures.append(
                    f"ROLE_SECRET_MAXIMUM_SIZE_FAILURE {address} "
                    f"size={size} limit={limit}"
                )
            if exceeds_aws_limit(size):
                self.failures.append(
                    f"ROLE_SECRET_MAXIMUM_OVER_AWS_LIMIT {address} "
                    f"size={size} limit={AWS_SIZE_LIMIT}"
                )
        self.lines.append(
            f"  role-secret-maximum largest {worst[0]} size={worst[1]} "
            f"limit={AWS_SIZE_LIMIT} aws_limit={AWS_SIZE_LIMIT}"
        )

    def _check_size(self, address: str, policy_name: Any, size: int) -> None:
        limit = (
            AWS_SIZE_LIMIT
            if policy_name == "GootipTerraformDeployObservabilityPermissions"
            else SIZE_FAILURE
        )
        verdict = "failure" if size >= limit else "warning" if size >= SIZE_WARNING else "healthy"
        if verdict == "failure":
            self.failures.append(
                f"POLICY_SIZE_FAILURE {address} name={policy_name} size={size} limit={limit}"
            )
        elif verdict == "warning":
            self.warnings.append(
                f"POLICY_SIZE_WARNING {address} name={policy_name} size={size} warn={SIZE_WARNING}"
            )
        if exceeds_aws_limit(size):
            self.failures.append(
                f"POLICY_SIZE_OVER_AWS_LIMIT {address} name={policy_name} size={size} limit={AWS_SIZE_LIMIT}"
            )

    def _check_sids(self, address: str, policy_name: Any, document: Mapping[str, Any]) -> None:
        for sid in sorted(duplicate_sids(document)):
            self.failures.append(f"DUPLICATE_SID {address} name={policy_name} sid={sid}")

    def _check_wildcards(self, address: str, policy_name: Any, document: Mapping[str, Any]) -> None:
        observed = {(policy_name, sid, field) for sid, field in statement_wildcards(document)}
        self.observed_wildcards |= observed
        for key in sorted(observed, key=str):
            if key not in REVIEWED_WILDCARDS:
                _, sid, field = key
                self.failures.append(
                    f"UNREVIEWED_WILDCARD {address} name={policy_name} sid={sid} field={field}"
                )

    def _check_attachments(self, role: str, count: int) -> None:
        self.lines.append(f"  attachments role={role} count={count}")
        verdict = classify_attachments(count)
        if verdict == "failure":
            self.failures.append(
                f"ATTACHMENT_FAILURE role={role} count={count} limit={ATTACHMENT_FAILURE}"
            )
        elif verdict == "warning":
            self.warnings.append(
                f"ATTACHMENT_WARNING role={role} count={count} warn={ATTACHMENT_WARNING}"
            )

    def _check_credential_lifecycle_inline(self, resource: Mapping[str, Any]) -> None:
        """Allow only the reviewed temporary grant on exact credential ARNs."""
        address = normalize_address(resource.get("address", ""))
        policy_text = resource.get("values", {}).get("policy")
        if not isinstance(policy_text, str):
            self.failures.append(f"UNKNOWN_INLINE_POLICY {address}")
            return
        document = json.loads(policy_text)
        statements = {
            item.get("Sid"): normalized_statement(item)
            for item in document.get("Statement", [])
        }
        expected = {
            sid: {
                "Sid": sid,
                "Effect": "Allow",
                "Action": sorted(actions),
                "Resource": [resource_arn],
            }
            for sid, (actions, resource_arn) in CREDENTIAL_LIFECYCLE_STATEMENTS.items()
        }
        if statements != expected:
            self.failures.append(f"CREDENTIAL_LIFECYCLE_SCOPE_FAILURE {address}")
        size = non_whitespace_length(policy_text)
        if size >= SIZE_FAILURE:
            self.failures.append(
                f"INLINE_POLICY_SIZE_FAILURE {address} size={size} limit={SIZE_FAILURE}"
            )
        self._check_sids(address, CREDENTIAL_LIFECYCLE_POLICY_NAME, document)

    def check_stale_reviews(self) -> None:
        for key in sorted(set(REVIEWED_WILDCARDS) - self.observed_wildcards, key=str):
            name, sid, field = key
            self.failures.append(f"STALE_WILDCARD_REVIEW name={name} sid={sid} field={field}")

    def evaluate_diagnostics_inventory(self, plan: Mapping[str, Any]) -> None:
        """Check only the SPEC 02.3 diagnostics policy from its own render.

        The diagnostics inventory belongs to SPEC 02.3 and is disabled in every
        SPEC 03.1 render, so it is evaluated on its own rather than duplicated
        across the bootstrap roots. Its findings still feed the shared size,
        statement-ID, and wildcard review.
        """
        policy_name = "GootipBootstrapDiagnosticsPermissions"
        self.lines.append("root: bootstrap-diagnostics (SPEC 02.3 scope)")
        for resource in iter_resources(plan):
            if resource.get("type") != POLICY_RESOURCE_TYPE:
                continue
            values = resource.get("values", {})
            if values.get("name") != policy_name:
                continue
            policy_text = values.get("policy")
            if not isinstance(policy_text, str):
                self.failures.append(
                    f"UNKNOWN_POLICY_DOCUMENT {resource['address']} name={policy_name}"
                )
                continue
            address = normalize_address(resource["address"])
            document = json.loads(policy_text)
            size = non_whitespace_length(policy_text)
            self.lines.append(
                f"  policy {address} name={policy_name} size={size} "
                f"statements={len(document.get('Statement', []))}"
            )
            self._check_size(address, policy_name, size)
            self._check_sids(address, policy_name, document)
            self._check_wildcards(address, policy_name, document)


def informational_standing_sizes() -> dict[str, int]:
    """Policy sizes at the standing configuration (foundation expansion off).

    This is informational only: it never relaxes the maximum-configuration
    checks and exists to record the deploy policy's base capacity while its
    foundation expansion is deferred to a later specification.
    """
    sizes: dict[str, int] = {}
    for resource in iter_resources(render_plan(BOOTSTRAP_STANDING)):
        if resource.get("type") != POLICY_RESOURCE_TYPE:
            continue
        values = resource.get("values", {})
        policy_text = values.get("policy")
        if isinstance(policy_text, str):
            sizes[normalize_address(resource["address"])] = non_whitespace_length(policy_text)
    return sizes


def main() -> int:
    report = Report()
    report.evaluate_root(BOOTSTRAP_MAXIMUM)
    report.evaluate_root(BOOTSTRAP_CREDENTIAL_OPERATIONS)
    report.evaluate_root(APPLICATION_MAXIMUM)
    report.evaluate_diagnostics_inventory(render_plan(BOOTSTRAP_DIAGNOSTICS))
    report.check_transition_core(render_plan(BOOTSTRAP_TRANSITION))
    report.check_role_secret_maximum(render_plan(BOOTSTRAP_ROLE_SECRET_MAXIMUM))
    report.check_stale_reviews()

    print("IAM policy guardrail report")
    print("\n".join(report.lines))

    for warning in report.warnings:
        print(f"warning: {warning}")
    for failure in report.failures:
        print(f"failure: {failure}")

    deploy_standing = informational_standing_sizes().get("aws_iam_policy.deployment_permissions")
    if deploy_standing is not None:
        print(
            "informational: aws_iam_policy.deployment_permissions "
            f"size={deploy_standing} with foundation_policy_expansion_enabled=false"
        )

    summary = f"policies checked with warnings={len(report.warnings)} failures={len(report.failures)}"
    print(summary)
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
