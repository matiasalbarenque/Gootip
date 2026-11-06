#!/usr/bin/env python3
"""Verify the SPEC 03.1 managed-policy split preserves effective permissions.

Rendering is delegated to the shared isolated evaluator so the semantic
equivalence check and the capacity checks in
``scripts/check_iam_policy_guardrails.py`` share one Terraform boundary. No
canonical Terraform state is read and no AWS request is performed.

The recorded pre-split baseline fixture at
``bootstrap/tests/fixtures/03.1-presplit-role-unions.json`` captures the union of
every managed policy attached to each role before the split. It is versioned, so
this tool runs without any gitignored local evidence. It renders the post-split
configuration and proves, statement by statement:

* the deployment role union preserves that partition plus only the exact,
  recorded SPEC 04 and SPEC 05.2 amendments;
* the admin role union preserves the reviewed split-policy lifecycle additions
  plus only the exact, recorded later capability statements;
* the standing configuration carries no temporary customer-managed-policy
  creation grant (``split_policy_creation_enabled`` off by default).

The fixture was recorded from the commit immediately before the split and is
never regenerated from the post-split state. Its ``account_id`` must equal the
evaluator's ``FIXTURE_ACCOUNT_ID``, so a real Account ID can never be introduced.
"""

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from iam_policy_evaluator import (  # noqa: E402
    BOOTSTRAP_MAXIMUM,
    FIXTURE_ACCOUNT_ID,
    FIXTURE_DB_OPERATOR_SECRET_ARN,
    iter_resources,
    render_plan,
)

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "tests/fixtures/03.1-presplit-role-unions.json"

# The admin role union: the retained core plus the capability policies that
# together carry what the pre-split core and State policy carried.
ADMIN_POLICIES = (
    "GootipBootstrapAdminPermissions",
    "GootipBootstrapPolicyAdminPermissions",
    "GootipBootstrapStatePermissions",
    "GootipBootstrapDiagnosticsPermissions",
    "GootipBootstrapDeploymentPolicyAdminPermissions",
)
# The deployment role union: the retained core (including consolidated
# foundation-read statements), the network/database capabilities, and the
# pre-existing SPEC 03 administrative PassRole policy.
DEPLOY_POLICIES = (
    "GootipTerraformDeployPermissions",
    "GootipTerraformDeployNetworkPermissions",
    "GootipTerraformDeployDatabasePermissions",
    "GootipTerraformDeployAdministrativePassRole",
)

# Statements that legitimately name the split policy ARNs so the admin role can
# attach, detach, version, and tag them. Their grants are unchanged; only the
# set of addressed policy ARNs grows.
LIFECYCLE_SIDS = ("ManageExactHumanRolesAndPolicies", "ManageExactSplitPolicyTags")

# The split policies still active after the later foundation-read consolidation.
SPLIT_POLICY_NAMES = (
    "GootipBootstrapPolicyAdminPermissions",
    "GootipTerraformDeployNetworkPermissions",
    "GootipTerraformDeployDatabasePermissions",
)

# Later reviewed capabilities add two exact deployment policies to the existing
# admin lifecycle statement. Keep them separate from the SPEC 03.1 split set,
# whose paths and presence are checked below.
LIFECYCLE_ADDITION_POLICY_NAMES = SPLIT_POLICY_NAMES + (
    "GootipTerraformDeployAuthMigrationsPermissions",
    "GootipTerraformDeployDbConfigPermissions",
    "GootipTerraformDeployCoreMigrationsPermissions",
    "GootipTerraformDeployObservabilityPermissions",
    "GootipTerraformDeployApplicationPermissions",
    "GootipTerraformDeployApiGatewayPermissions",
    "GootipTerraformDeployAdministrativePassRole",
    "GootipBootstrapDeploymentPolicyAdminPermissions",
)

# SPEC 05.1 adds one exact human role and its one exact secret-read policy. Both
# are managed by two exact capability statements instead of the shared human-role
# lifecycle statement, so the temporary SPEC 03.1 transition core keeps its
# reviewed size.
DATABASE_OPERATOR_ROLE_ARN = (
    "arn:aws:iam::123456789012:role/gootip/operations/GootipDatabaseOperator"
)
DATABASE_OPERATOR_POLICY_ARN = (
    "arn:aws:iam::123456789012:policy/gootip/operations/GootipDatabaseOperatorPermissions"
)
DATABASE_OPERATOR_STATEMENTS = {
    "ManageExactDatabaseOperatorRole": {
        "Effect": "Allow",
        "Action": [
            "iam:AttachRolePolicy",
            "iam:CreateRole",
            "iam:DetachRolePolicy",
            "iam:GetRole",
            "iam:ListAttachedRolePolicies",
            "iam:ListRolePolicies",
            "iam:TagRole",
            "iam:UpdateAssumeRolePolicy",
            "iam:UpdateRole",
        ],
        "Resource": DATABASE_OPERATOR_ROLE_ARN,
    },
    "ManageExactDatabaseOperatorPolicy": {
        "Effect": "Allow",
        "Action": [
            "iam:CreatePolicy",
            "iam:CreatePolicyVersion",
            "iam:DeletePolicyVersion",
            "iam:GetPolicy",
            "iam:GetPolicyVersion",
            "iam:ListPolicyTags",
            "iam:ListPolicyVersions",
            "iam:SetDefaultPolicyVersion",
            "iam:TagPolicy",
            "iam:UntagPolicy",
        ],
        "Resource": DATABASE_OPERATOR_POLICY_ARN,
    },
}

# Exact post-split additions from SPEC 04 and SPEC 05.2. These documents are
# deliberately recorded here rather than derived from the rendered policies;
# otherwise a Terraform policy broadening would approve itself.
REVIEWED_ADDED_STATEMENTS = {
    "ModifyExactSecretsManagerVpcEndpointPolicy": {
        "Effect": "Allow",
        "Action": "ec2:ModifyVpcEndpoint",
        "Resource": "arn:aws:ec2:us-east-2:123456789012:vpc-endpoint/vpce-0123456789abcdef0",
        "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-2"}},
    },
    "ReadCloudWatchMetricDataInRegion": {
        "Effect": "Allow",
        "Action": "cloudwatch:GetMetricData",
        "Resource": "*",
        "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-2"}},
    },
    "ManageExactDeploymentPolicyTags": {
        "Effect": "Allow",
        "Action": ["iam:ListPolicyTags", "iam:TagPolicy", "iam:UntagPolicy"],
        "Resource": [
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployObservabilityPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployDbConfigPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployCoreMigrationsPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployAuthMigrationsPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployApplicationPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployApiGatewayPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployAdministrativePassRole",
        ],
    },
    "ManageExactDeploymentPolicies": {
        "Effect": "Allow",
        "Action": [
            "iam:CreatePolicy",
            "iam:CreatePolicyVersion",
            "iam:DeletePolicyVersion",
            "iam:GetPolicy",
            "iam:GetPolicyVersion",
            "iam:ListPolicyVersions",
            "iam:SetDefaultPolicyVersion",
        ],
        "Resource": [
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployObservabilityPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployDbConfigPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployCoreMigrationsPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployAuthMigrationsPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployApplicationPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployApiGatewayPermissions",
            "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployAdministrativePassRole",
        ],
    },
    "CreateExactAuthMigrationsDeploymentPolicy": {
        "Effect": "Allow",
        "Action": [
            "iam:CreatePolicy",
            "iam:ListPolicyTags",
            "iam:TagPolicy",
            "iam:UntagPolicy",
        ],
        "Resource": "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployAuthMigrationsPermissions",
    },
    "CreateExactCoreMigrationsDeploymentPolicy": {
        "Effect": "Allow",
        "Action": [
            "iam:CreatePolicy",
            "iam:ListPolicyTags",
            "iam:TagPolicy",
            "iam:UntagPolicy",
        ],
        "Resource": "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployCoreMigrationsPermissions",
    },
    "ManageExactCoreMigrationsDeploymentPolicy": {
        "Effect": "Allow",
        "Action": [
            "iam:CreatePolicyVersion",
            "iam:DeletePolicyVersion",
            "iam:GetPolicy",
            "iam:GetPolicyVersion",
            "iam:ListPolicyVersions",
            "iam:SetDefaultPolicyVersion",
        ],
        "Resource": "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployCoreMigrationsPermissions",
    },
    "CreateExactDbConfigDeploymentPolicy": {
        "Effect": "Allow",
        "Action": [
            "iam:CreatePolicy",
            "iam:ListPolicyTags",
            "iam:TagPolicy",
            "iam:UntagPolicy",
        ],
        "Resource": "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployDbConfigPermissions",
    },
    "CreateExactObservabilityDeploymentPolicy": {
        "Effect": "Allow",
        "Action": [
            "iam:CreatePolicy",
            "iam:ListPolicyTags",
            "iam:TagPolicy",
            "iam:UntagPolicy",
        ],
        "Resource": "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployObservabilityPermissions",
    },
    "ManageExactObservabilityDeploymentPolicy": {
        "Effect": "Allow",
        "Action": [
            "iam:CreatePolicyVersion",
            "iam:DeletePolicyVersion",
            "iam:GetPolicy",
            "iam:GetPolicyVersion",
            "iam:ListPolicyVersions",
            "iam:SetDefaultPolicyVersion",
        ],
        "Resource": "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployObservabilityPermissions",
    },
    "CreateDbTunnelEndpointNetworkInterfaces": {
        "Effect": "Allow",
        "Action": "ec2:CreateNetworkInterface",
        "Resource": [
            "arn:aws:ec2:us-east-2:123456789012:network-interface/*",
            "arn:aws:ec2:us-east-2:123456789012:subnet/*",
        ],
        "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-2"}},
    },
    "CreateDbTunnelInfrastructure": {
        "Effect": "Allow",
        "Action": ["ec2:CreateInstanceConnectEndpoint", "ec2:RunInstances"],
        "Resource": [
            "arn:aws:ec2:us-east-2::image/ami-0123456789abcdef0",
            "arn:aws:ec2:us-east-2:123456789012:instance-connect-endpoint/*",
            "arn:aws:ec2:us-east-2:123456789012:network-interface/*",
            "arn:aws:ec2:us-east-2:123456789012:subnet/subnet-0123456789abcdef0",
        ],
        "Condition": {
            "ArnEqualsIfExists": {
                "ec2:Subnet": "arn:aws:ec2:us-east-2:123456789012:subnet/subnet-0123456789abcdef0"
            },
            "StringEquals": {"aws:RequestedRegion": "us-east-2"},
        },
    },
    "ManageTaggedDbTunnelEndpoint": {
        "Effect": "Allow",
        "Action": [
            "ec2:DeleteInstanceConnectEndpoint",
            "ec2:ModifyInstanceConnectEndpoint",
        ],
        "Resource": "arn:aws:ec2:us-east-2:123456789012:instance-connect-endpoint/*",
        "Condition": {
            "StringEquals": {
                "aws:ResourceTag/env": "dev",
                "aws:ResourceTag/managed_by": "terraform",
                "aws:ResourceTag/project": "gootip",
                "aws:ResourceTag/purpose": "db-tunnel",
            }
        },
    },
    "ManageTaggedDbTunnelResources": {
        "Effect": "Allow",
        "Action": [
            "ec2:ModifyInstanceAttribute",
            "ec2:ModifyInstanceMetadataOptions",
            "ec2:StartInstances",
            "ec2:StopInstances",
            "ec2:TerminateInstances",
        ],
        "Resource": "arn:aws:ec2:us-east-2:123456789012:instance/*",
        "Condition": {
            "StringEquals": {
                "aws:ResourceTag/env": "dev",
                "aws:ResourceTag/managed_by": "terraform",
                "aws:ResourceTag/project": "gootip",
                "aws:ResourceTag/purpose": "db-tunnel",
            }
        },
    },
    "ReadDbTunnelResources": {
        "Effect": "Allow",
        "Action": [
            "ec2:DescribeImages",
            "ec2:DescribeInstanceAttribute",
            "ec2:DescribeInstanceConnectEndpoints",
            "ec2:DescribeInstanceCreditSpecifications",
            "ec2:DescribeInstanceStatus",
            "ec2:DescribeInstanceTypes",
            "ec2:DescribeInstances",
            "ec2:DescribeSecurityGroupRules",
            "ec2:DescribeVolumes",
        ],
        "Resource": "*",
        "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-2"}},
    },
    "RevokeIngressAndDeleteTaggedFoundationSecurityGroups": {
        "Effect": "Allow",
        "Action": [
            "ec2:DeleteSecurityGroup",
            "ec2:RevokeSecurityGroupIngress",
        ],
        "Resource": "arn:aws:ec2:us-east-2:123456789012:security-group/*",
        "Condition": {
            "StringEquals": {
                "aws:ResourceTag/env": "dev",
                "aws:ResourceTag/managed_by": "terraform",
                "aws:ResourceTag/project": "gootip",
            }
        },
    },
    "RunTaggedDbTunnelInstance": {
        "Effect": "Allow",
        "Action": "ec2:RunInstances",
        "Resource": [
            "arn:aws:ec2:us-east-2:123456789012:instance/*",
            "arn:aws:ec2:us-east-2:123456789012:volume/*",
        ],
        "Condition": {
            "ForAllValues:StringEquals": {
                "aws:TagKeys": ["Name", "env", "managed_by", "project", "purpose"]
            },
            "Null": {"aws:TagKeys": "false"},
            "StringEquals": {
                "aws:RequestTag/env": "dev",
                "aws:RequestTag/managed_by": "terraform",
                "aws:RequestTag/project": "gootip",
                "aws:RequestTag/purpose": "db-tunnel",
                "aws:RequestedRegion": "us-east-2",
            },
        },
    },
    "TagDbTunnelEndpointNetworkInterfaces": {
        "Effect": "Allow",
        "Action": "ec2:CreateTags",
        "Resource": "arn:aws:ec2:us-east-2:123456789012:network-interface/*",
        "Condition": {
            "Null": {"aws:TagKeys": "false"},
            "StringEquals": {"aws:RequestedRegion": "us-east-2"},
        },
    },
    "UseDbTunnelSecurityGroups": {
        "Effect": "Allow",
        "Action": [
            "ec2:CreateInstanceConnectEndpoint",
            "ec2:CreateNetworkInterface",
            "ec2:RunInstances",
        ],
        "Resource": "arn:aws:ec2:us-east-2:123456789012:security-group/*",
        "Condition": {
            "ForAnyValue:StringEquals": {
                "aws:ResourceTag/Name": [
                    "gootip-dev-db-eice",
                    "gootip-dev-db-tunnel",
                ]
            },
            "StringEquals": {
                "aws:RequestedRegion": "us-east-2",
                "aws:ResourceTag/env": "dev",
                "aws:ResourceTag/managed_by": "terraform",
                "aws:ResourceTag/project": "gootip",
            },
        },
    },
    "ModifyExactGootipRdsInstanceForUpgrade": {
        "Effect": "Allow",
        "Action": "rds:ModifyDBInstance",
        "Resource": [
            "arn:aws:rds:us-east-2:123456789012:db:gootip-dev",
            "arn:aws:rds:us-east-2:123456789012:pg:gootip-dev-postgres18",
        ],
    },
    "CreateExactGootipPreUpgradeSnapshot": {
        "Effect": "Allow",
        "Action": "rds:CreateDBSnapshot",
        "Resource": [
            "arn:aws:rds:us-east-2:123456789012:db:gootip-dev",
            "arn:aws:rds:us-east-2:123456789012:snapshot:gootip-dev-pre-pg18-20261025",
        ],
    },
    "DeleteExactPostgres17ParameterGroup": {
        "Effect": "Allow",
        "Action": "rds:DeleteDBParameterGroup",
        "Resource": "arn:aws:rds:us-east-2:123456789012:pg:gootip-dev-postgres",
    },
    "ReadUpgradeRdsSnapshotMetadataInRegion": {
        "Effect": "Allow",
        "Action": "rds:DescribeDBSnapshots",
        "Resource": "*",
        "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-2"}},
    },
    "ReadUpgradeRdsPendingMaintenanceInRegion": {
        "Effect": "Allow",
        "Action": "rds:DescribePendingMaintenanceActions",
        "Resource": "*",
        "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-2"}},
    },
}

# The Region-scoped Availability Zone read is folded into the existing
# Region-scoped network-read statement. This is an exact action-set union, not a
# new resource or condition scope.
REVIEWED_STATEMENT_MERGES = {
    "ReadAvailabilityZonesInConfiguredRegion": (
        "ReadAndAssociateFoundationNetworkResources",
        "ec2:DescribeAvailabilityZones",
    ),
}

REVIEWED_ALTERED_STATEMENTS = {
    "ConfigureAndReadExactFoundationRdsResources": {
        "Effect": "Allow",
        "Action": [
            "rds:AddTagsToResource",
            "rds:DescribeDBInstances",
            "rds:DescribeDBParameterGroups",
            "rds:DescribeDBParameters",
            "rds:DescribeDBSubnetGroups",
            "rds:ListTagsForResource",
            "rds:ModifyDBParameterGroup",
        ],
        "Resource": [
            "arn:aws:rds:us-east-2:123456789012:db:gootip-dev",
            "arn:aws:rds:us-east-2:123456789012:pg:gootip-dev-postgres",
            "arn:aws:rds:us-east-2:123456789012:pg:gootip-dev-postgres18",
            "arn:aws:rds:us-east-2:123456789012:subgrp:gootip-dev",
        ],
    },
    "TagFoundationNetworkResources": {
        "Effect": "Allow",
        "Action": "ec2:CreateTags",
        "Resource": "*",
        "Condition": {
            "ForAllValues:StringEquals": {
                "aws:TagKeys": ["Name", "env", "managed_by", "project", "purpose"]
            },
            "StringEquals": {
                "aws:RequestTag/env": "dev",
                "aws:RequestTag/managed_by": "terraform",
                "aws:RequestTag/project": "gootip",
                "aws:RequestedRegion": "us-east-2",
            },
        },
    }
}

REVIEWED_STATEMENT_REPLACEMENTS = {
    "PassExactAdministrativeFunctionRole": (
        "PassExactPrivateFunctionRoles",
        {
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": [
                "arn:aws:iam::123456789012:role/gootip/administrative/gootip-db-config-dev-lambda",
                "arn:aws:iam::123456789012:role/gootip/application/gootip-dev-auth-migrations-lambda",
                "arn:aws:iam::123456789012:role/gootip/application/gootip-dev-core-migrations-lambda",
                "arn:aws:iam::123456789012:role/gootip/application/gootip-auth-dev-lambda",
                "arn:aws:iam::123456789012:role/gootip/application/gootip-core-dev-lambda",
            ],
            "Condition": {
                "StringEquals": {"iam:PassedToService": "lambda.amazonaws.com"}
            },
        },
    ),
    "CreateExactAdministrativePassRolePolicy": (
        "ManageExactDeploymentPolicies",
        {
            "Effect": "Allow",
            "Action": [
                "iam:CreatePolicy",
                "iam:CreatePolicyVersion",
                "iam:DeletePolicyVersion",
                "iam:GetPolicy",
                "iam:GetPolicyVersion",
                "iam:ListPolicyVersions",
                "iam:SetDefaultPolicyVersion",
            ],
            "Resource": [
                "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployObservabilityPermissions",
                "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployDbConfigPermissions",
                "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployCoreMigrationsPermissions",
                "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployAuthMigrationsPermissions",
                "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployApplicationPermissions",
                "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployApiGatewayPermissions",
                "arn:aws:iam::123456789012:policy/gootip/deployment/GootipTerraformDeployAdministrativePassRole",
            ],
        },
    )
}

# The SPEC 02.3 read-only diagnostics inventory is not part of this split: it
# renders only when diagnostics_inventory_enabled is true, which no SPEC 03.1
# apply sets. The comparator therefore allows no added statement at all, so any
# diagnostics statement appearing here would be an unreviewed scope change.

# SPEC 05.1 extends the three bootstrap manual-value statements with exactly one
# additional resource: the exact operator-secret ARN, once its container exists.
# The grant is otherwise unchanged, so the review accepts only that one ARN on
# the Resource/NotResource of these statements and nothing else.
DATABASE_OPERATOR_SECRET_SIDS = (
    "ManageExactApprovedSecretContainers",
    "OperateExactApprovedSecretValues",
    "DenyEveryOtherSecret",
)

# The temporary customer-managed-policy creation statement. It must never appear
# in the standing (flag-off) configuration.
TEMPORARY_GRANT_SID = "CreateExactSplitPolicies"

# SPEC 02.1 amendment, proven by IAM Access Analyzer ValidatePolicy: the recorded
# pre-split baseline carries s3:PutBucketEncryption, which is not a valid IAM
# action. The PutBucketEncryption API authorizes against
# s3:PutEncryptionConfiguration, so the recorded name granted no encryption-config
# write at all. The recorded baseline is deliberately never re-recorded: instead
# the comparator accepts this ONE substitution explicitly, in exactly the ONE
# statement that declares it, on the Action field only, and only when one action
# is lost and the recorded replacement is the only action gained. Any other
# pairing, statement, or field keeps failing, so the documented correction can
# never widen into silently rewritten history.
DOCUMENTED_ACTION_SUBSTITUTIONS = (
    ("s3:PutBucketEncryption", "s3:PutEncryptionConfiguration"),
)
DOCUMENTED_SUBSTITUTION_SIDS = ("ManageExactStateBucketConfiguration",)

def normalize(value: Any) -> Any:
    """Return a comparable form with Sid removed and every list order-insensitive."""
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in sorted(value.items()) if key != "Sid"}
    if isinstance(value, list):
        return sorted(
            (normalize(item) for item in value),
            key=lambda item: json.dumps(item, sort_keys=True),
        )
    return value


def policies_from_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Return every planned ``aws_iam_policy`` keyed by managed-policy name."""
    policies: dict[str, Any] = {}
    for resource in iter_resources(plan):
        if resource.get("type") != "aws_iam_policy":
            continue
        values = resource.get("values", {})
        # Strip the count index: the split policies are keyed by name, not address.
        address = resource["address"].split("[", 1)[0]
        policies[values["name"]] = {
            "address": address,
            "path": values.get("path"),
            "document": json.loads(values["policy"]),
        }
    return policies


def statements_by_sid(policy: dict[str, Any]) -> dict[str, Any]:
    return {statement.get("Sid"): statement for statement in policy["document"]["Statement"]}


def role_union(policies: dict[str, Any], names: tuple[str, ...]) -> dict[str, Any]:
    union: dict[str, Any] = {}
    for name in names:
        for sid, statement in statements_by_sid(policies[name]).items():
            if sid in union:
                raise SystemExit(f"Duplicate Sid {sid} across {names}.")
            union[sid] = statement
    return union


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, str):
        return [value]
    return list(value or [])


def _is_allowed_lifecycle_arn(value: Any) -> bool:
    """True when a reviewed policy ARN is added to an admin lifecycle statement."""
    if not isinstance(value, str):
        return False
    return value.rsplit("/", 1)[-1] in LIFECYCLE_ADDITION_POLICY_NAMES


def _is_allowed_database_operator_statement(sid: str, statement: dict[str, Any]) -> bool:
    expected = DATABASE_OPERATOR_STATEMENTS.get(sid)
    return expected is not None and normalize(statement) == normalize(expected)


def _is_reviewed_added_statement(sid: str, statement: dict[str, Any]) -> bool:
    expected = REVIEWED_ADDED_STATEMENTS.get(sid)
    return expected is not None and normalize(statement) == normalize(expected)


def _is_reviewed_altered_statement(sid: str, statement: dict[str, Any]) -> bool:
    expected = REVIEWED_ALTERED_STATEMENTS.get(sid)
    return expected is not None and normalize(statement) == normalize(expected)


def _is_documented_substitution(sid: str, field: str, lost: list[Any], gained: list[Any]) -> bool:
    """True only for the exact SPEC 02.1 action substitution in its own statement."""
    if sid not in DOCUMENTED_SUBSTITUTION_SIDS or field != "Action":
        return False
    return any(
        lost == [invalid] and gained == [valid]
        for invalid, valid in DOCUMENTED_ACTION_SUBSTITUTIONS
    )


def _is_allowed_database_operator_secret_addition(sid: str, field: str, value: Any) -> bool:
    """Allow only the exact SPEC 05.1 operator-secret ARN on the value statements."""
    return (
        sid in DATABASE_OPERATOR_SECRET_SIDS
        and field in ("Resource", "NotResource")
        and isinstance(value, str)
        and value == FIXTURE_DB_OPERATOR_SECRET_ARN
    )


def compare_union(
    label: str,
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    allow_lifecycle_additions: bool,
) -> list[str]:
    problems: list[str] = []

    removed_sids = set(before) - set(after)
    added_sids = set(after) - set(before)
    merged_targets: set[str] = set()
    for old_sid, (target_sid, merged_action) in REVIEWED_STATEMENT_MERGES.items():
        if old_sid not in removed_sids or target_sid not in after:
            continue
        old_statement = before[old_sid]
        target = after[target_sid]
        old_action = old_statement.get("Action")
        if (
            old_statement.get("Effect") == "Allow"
            and old_statement.get("Resource") == "*"
            and old_statement.get("Condition") == {"StringEquals": {"aws:RequestedRegion": "us-east-2"}}
            and old_action == merged_action
            and target.get("Effect") == "Allow"
            and target.get("Resource") == "*"
            and target.get("Condition") == old_statement.get("Condition")
            and merged_action in _as_list(target.get("Action"))
        ):
            removed_sids.remove(old_sid)
            merged_targets.add(target_sid)
            print(f"  allowed exact Region-scoped statement merge: {old_sid} -> {target_sid}")
    for old_sid, (new_sid, expected) in REVIEWED_STATEMENT_REPLACEMENTS.items():
        if (
            old_sid in removed_sids
            and new_sid in added_sids
            and normalize(after[new_sid]) == normalize(expected)
        ):
            removed_sids.remove(old_sid)
            added_sids.remove(new_sid)
            print(f"  allowed exact statement replacement: {old_sid} -> {new_sid}")

    removed = sorted(removed_sids)
    if removed:
        problems.append(f"{label}: removed statements {removed}.")

    # Later additions are accepted only when their complete normalized document
    # matches the reviewed statement recorded above.
    for sid in sorted(added_sids):
        if sid in DATABASE_OPERATOR_STATEMENTS and _is_allowed_database_operator_statement(
            sid, after[sid]
        ):
            print(f"  allowed exact SPEC 05.1 addition: {sid}")
        elif _is_reviewed_added_statement(sid, after[sid]):
            print(f"  allowed exact reviewed addition: {sid}")
        else:
            problems.append(f"{label}: added statement {sid}.")

    for sid in sorted(set(before) & set(after)):
        if normalize(before[sid]) == normalize(after[sid]):
            continue
        if sid in merged_targets:
            old_actions = set(_as_list(before[sid].get("Action")))
            new_actions = set(_as_list(after[sid].get("Action")))
            if (
                new_actions - old_actions == {"ec2:DescribeAvailabilityZones"}
                and old_actions - new_actions == set()
                and before[sid].get("Effect") == after[sid].get("Effect")
                and before[sid].get("Resource") == after[sid].get("Resource")
                and before[sid].get("Condition") == after[sid].get("Condition")
            ):
                continue
        if _is_reviewed_altered_statement(sid, after[sid]):
            print(f"  allowed exact reviewed alteration: {sid}")
            continue
        lifecycle_widenings = allow_lifecycle_additions and sid in LIFECYCLE_SIDS
        documented_substitution = sid in DOCUMENTED_SUBSTITUTION_SIDS
        database_operator_secret = sid in DATABASE_OPERATOR_SECRET_SIDS
        if not (
            lifecycle_widenings
            or documented_substitution
            or database_operator_secret
        ):
            problems.append(f"{label}: altered statement {sid}.")
            continue
        for field in sorted(set(before[sid]) | set(after[sid])):
            if field == "Sid":
                continue
            old, new = before[sid].get(field), after[sid].get(field)
            if normalize(old) == normalize(new):
                continue
            lost = sorted(set(_as_list(old)) - set(_as_list(new)))
            gained = sorted(set(_as_list(new)) - set(_as_list(old)))
            if documented_substitution and _is_documented_substitution(sid, field, lost, gained):
                print(f"  allowed documented {field} substitution: {lost[0]} -> {gained[0]}")
                continue
            if lost:
                problems.append(f"{label}: {sid}.{field} lost {lost}.")
            for value in gained:
                if lifecycle_widenings and _is_allowed_lifecycle_arn(value):
                    print(f"  allowed {sid}.{field} addition: {value.rsplit('/', 1)[-1]}")
                elif _is_allowed_database_operator_secret_addition(sid, field, value):
                    print("  allowed exact SPEC 05.1 operator-secret ARN addition")
                else:
                    problems.append(f"{label}: {sid}.{field} gained {value}.")
    return problems


def main() -> int:
    if not BASELINE.exists():
        print(f"Missing pre-split baseline fixture: {BASELINE}")
        print("Restore the versioned fixture; never regenerate it from the post-split state.")
        return 1

    baseline = json.loads(BASELINE.read_text())
    account_id = baseline.get("account_id")
    if account_id != FIXTURE_ACCOUNT_ID:
        print(
            f"Baseline account_id {account_id!r} is not the sanitized fixture "
            f"{FIXTURE_ACCOUNT_ID!r}; a real Account ID must never be recorded."
        )
        return 1

    plan = render_plan(BOOTSTRAP_MAXIMUM)
    policies = policies_from_plan(plan)

    expected = set(ADMIN_POLICIES) | set(DEPLOY_POLICIES)
    missing = sorted(expected - set(policies))
    if missing:
        print(f"The plan does not materialize {missing}.")
        return 1

    problems: list[str] = []

    print("Deployment role union (core with foundation reads + network + database + passrole)")
    problems += compare_union(
        "deploy union",
        baseline["deploy"],
        role_union(policies, DEPLOY_POLICIES),
        allow_lifecycle_additions=False,
    )

    print("Admin role union (core + policy-admin + state + diagnostics)")
    problems += compare_union(
        "admin union",
        baseline["admin"],
        role_union(policies, ADMIN_POLICIES),
        allow_lifecycle_additions=True,
    )

    # The standing configuration must not carry customer-managed-policy creation.
    for name in ADMIN_POLICIES:
        if TEMPORARY_GRANT_SID in statements_by_sid(policies[name]):
            problems.append(
                f"{name} carries the temporary {TEMPORARY_GRANT_SID} grant in the standing configuration."
            )

    # The split policies must be exactly the new managed policies, correctly pathed.
    for name in SPLIT_POLICY_NAMES:
        expected_path = "/gootip/deployment/" if name.startswith("GootipTerraformDeploy") else "/gootip/bootstrap/"
        if policies[name]["path"] != expected_path:
            problems.append(f"{name} path is {policies[name]['path']}, expected {expected_path}.")

    if problems:
        print("\nFAIL")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print("\nPASS: both role unions match the baseline plus exact reviewed amendments.")
    print("  deploy: original partition preserved; SPEC 04/05.2 changes match exactly")
    print("  admin: lifecycle resources and later capability statements match exactly")
    print("  standing configuration carries no temporary CreateExactSplitPolicies grant")
    print("  no SPEC 02.3 diagnostics statement renders in the SPEC 03.1 configuration")
    print("  the one documented SPEC 02.1 action substitution above is accepted explicitly;")
    print("    the recorded baseline itself is unchanged, so the correction stays auditable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
