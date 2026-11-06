#!/usr/bin/env python3
"""Standard-library unit tests for the IAM policy guardrail checker."""

from __future__ import annotations

import copy
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
COMPARATOR = Path(__file__).resolve().parents[2] / "bootstrap" / "scripts"
sys.path.insert(0, str(COMPARATOR))

import check_iam_policy_guardrails as guardrails  # noqa: E402
import compare_bootstrap_policy_split as comparator  # noqa: E402
import iam_policy_evaluator as evaluator  # noqa: E402


class AuthMigrationAliasPermissionTests(unittest.TestCase):
    """Keep same-account invoke authority in exact bootstrap identity policies."""

    def test_application_root_has_no_migration_resource_policy(self):
        source = (Path(__file__).resolve().parents[2] / "lambda.tf").read_text()

        self.assertNotIn('resource "aws_lambda_permission"', source)
        self.assertNotIn("lambda:AddPermission", source)
        self.assertNotIn("lambda:RemovePermission", source)


class AuthApiLambdaPermissionScopeTests(unittest.TestCase):
    """Keep exact API source ARNs in Lambda grants, not unsupported IAM keys."""

    def test_auth_add_permission_grant_uses_supported_principal_condition(self):
        source = (Path(__file__).resolve().parents[2] / "bootstrap" / "iam.tf").read_text()
        start = source.index('sid       = "ManageOnlyPreparedApiRoutePermissions"')
        end = source.index('\n  dynamic "statement"', start)
        statement = source[start:end]

        self.assertIn('actions   = ["lambda:AddPermission"]', statement)
        self.assertIn("resources = [local.auth_api_function_arn]", statement)
        self.assertIn('variable = "lambda:Principal"', statement)
        self.assertIn('values   = ["apigateway.amazonaws.com"]', statement)
        self.assertNotIn("lambda:SourceArn", statement)

    def test_auth_lambda_permissions_keep_three_exact_source_arns(self):
        source = (Path(__file__).resolve().parents[2] / "api-gateway.tf").read_text()

        for fragment in (
            'source_arn    = "${aws_apigatewayv2_api.main[0].execution_arn}/$default/*/api/auth"',
            'source_arn    = "${aws_apigatewayv2_api.main[0].execution_arn}/$default/*/api/auth/*"',
            'source_arn    = "${aws_apigatewayv2_api.main[0].execution_arn}/$default/GET/.well-known/openid-configuration"',
        ):
            self.assertIn(fragment, source)


class CoreApiLambdaPermissionArnTests(unittest.TestCase):
    """Avoid a doubled slash between the HTTP API route and Lambda ARN."""

    def test_core_route_source_arn_strips_route_leading_slash(self):
        source = (Path(__file__).resolve().parents[2] / "api-gateway.tf").read_text()
        start = source.index('resource "aws_lambda_permission" "core_route"')
        statement = source[start:]

        self.assertIn('trimprefix(replace(', statement)
        self.assertIn('), "/")}', statement)


class AuthRuntimeSecretScopeTests(unittest.TestCase):
    """SPEC 05: the auth runtime reads only the app and auth-runtime secrets.

    The full driver checks the rendered application plan. These source checks
    and the mocked materializer cleanup test also run in the fast cycle.
    """

    @staticmethod
    def document_block(source: str, header: str) -> str:
        """Return one policy-document block up to the next top-level block."""
        remainder = source[source.index(header) + len(header) :]
        ends = [
            index
            for marker in ('\ndata "', '\nresource "', '\noutput "')
            if (index := remainder.find(marker)) != -1
        ]
        return remainder[: min(ends)] if ends else remainder

    def test_runtime_policy_allows_only_the_two_approved_reads(self):
        source = (Path(__file__).resolve().parents[2] / "iam.tf").read_text()
        block = self.document_block(
            source, 'data "aws_iam_policy_document" "secrets_read" {'
        )
        start = block.index("resources = [")
        resources = block[start : block.index("]", start) + 1]

        # Exactly the application secret and the auth-runtime container: no
        # wildcard, no RDS master secret, no migrator/core or future secret.
        self.assertEqual(
            resources.split(),
            [
                "resources",
                "=",
                "[",
                "var.app_secret_arn,",
                "var.auth_runtime_secret_arn,",
                "]",
            ],
        )
        # A single read statement, and no Secrets Manager write anywhere.
        self.assertEqual(block.count("actions ="), 1)
        self.assertIn('actions = ["secretsmanager:GetSecretValue"]', block)
        for write in (
            "PutSecretValue",
            "UpdateSecret",
            "CreateSecret",
            "DeleteSecret",
            "RotateSecret",
            "RestoreSecret",
            "TagResource",
        ):
            self.assertNotIn(write, block)

    def test_application_root_policies_grant_no_iam_actions(self):
        source = (Path(__file__).resolve().parents[2] / "iam.tf").read_text()

        self.assertNotIn('"iam:', source)


class SecretsManagerEndpointHardeningTests(unittest.TestCase):
    """Keep endpoint policy and client network edges tied to exact consumers."""

    def test_endpoint_policy_is_limited_to_enabled_role_secret_pairs(self):
        source = (Path(__file__).resolve().parents[2] / "network.tf").read_text()
        policy = source[source.index('data "aws_iam_policy_document" "secretsmanager_endpoint" {') :]
        consumers = source[
            source.index("secretsmanager_endpoint_consumers = merge(") : source.index(
                "\n  )", source.index("secretsmanager_endpoint_consumers = merge(")
            )
        ]

        self.assertIn('actions   = ["secretsmanager:GetSecretValue"]', policy)
        self.assertIn("resources = statement.value.secrets", policy)
        self.assertIn('type        = "*"', policy)
        self.assertIn('identifiers = ["*"]', policy)
        self.assertIn('variable = "aws:PrincipalArn"', policy)
        self.assertIn("values   = [statement.value.role_arn]", policy)
        self.assertIn("var.db_master_secret_arn", consumers)
        self.assertIn("var.db_operator_secret_arn", consumers)
        self.assertIn("secrets  = [var.auth_migrator_secret_arn]", consumers)
        self.assertIn("secrets  = [var.core_migrator_secret_arn]", consumers)
        self.assertNotIn('type        = "AWS"', policy)
        self.assertIn("core_api", consumers)
        self.assertIn(
            'role_arn = "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-core-${var.env}-lambda"',
            consumers,
        )
        self.assertIn(
            'role_arn = "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-auth-${var.env}-lambda"',
            consumers,
        )
        self.assertIn("secrets  = [var.core_runtime_secret_arn]", consumers)
        self.assertIn("aws_iam_role.lambda,", source)
        self.assertIn("aws_iam_role.core_api,", source)

    def test_alarm_topic_policy_includes_only_enabled_application_alarms(self):
        source = (Path(__file__).resolve().parents[2] / "observability.tf").read_text()
        self.assertIn(
            "var.core_runtime_deployment_enabled ? [", source
        )
        self.assertIn(
            "var.application_runtime_deployment_enabled || var.core_runtime_deployment_enabled ? [",
            source,
        )
        self.assertIn("values   = local.operational_alarm_source_arns", source)

    def test_clients_and_destinations_use_security_group_references(self):
        source = (Path(__file__).resolve().parents[2] / "network.tf").read_text()
        egress_map = source[
            source.index("lambda_egress_security_groups = merge(") : source.index(
                "\n  )", source.index("lambda_egress_security_groups = merge(")
            )
        ]

        self.assertIn("application = aws_security_group.application_client.id", egress_map)
        self.assertIn("auth_migrations = aws_security_group.auth_migrations[0].id", egress_map)
        self.assertNotIn("core_migrations", egress_map)
        self.assertIn('resource "aws_vpc_security_group_egress_rule" "core_migrations_to_rds_postgres"', source)
        self.assertIn('resource "aws_vpc_security_group_egress_rule" "core_migrations_to_secretsmanager"', source)
        self.assertIn('resource "aws_vpc_security_group_egress_rule" "lambda_to_rds_postgres"', source)
        self.assertIn('resource "aws_vpc_security_group_egress_rule" "lambda_to_secretsmanager"', source)
        self.assertIn('resource "aws_vpc_security_group_ingress_rule" "rds_from_lambda_clients"', source)
        self.assertIn('resource "aws_vpc_security_group_ingress_rule" "endpoints_from_lambda_clients"', source)
        self.assertIn("referenced_security_group_id = aws_security_group.rds.id", source)
        self.assertIn("referenced_security_group_id = aws_security_group.endpoints.id", source)
        self.assertNotIn('cidr_blocks = ["0.0.0.0/0"]', source)


class ExactVpcEndpointCapabilityTests(unittest.TestCase):
    """The deploy role may modify only the reviewed endpoint policy target."""

    def test_network_policy_grants_modify_only_for_exact_endpoint_arn(self):
        plan = evaluator.render_plan(evaluator.BOOTSTRAP_MAXIMUM)
        resource = next(
            item
            for item in evaluator.iter_resources(plan)
            if item.get("type") == "aws_iam_policy"
            and item.get("values", {}).get("name") == "GootipTerraformDeployNetworkPermissions"
        )
        statements = json.loads(resource["values"]["policy"])["Statement"]
        matches = [
            statement
            for statement in statements
            if "ec2:ModifyVpcEndpoint" in statement.get("Action", [])
        ]

        self.assertEqual(len(matches), 1)
        self.assertEqual(
            matches[0]["Resource"],
            "arn:aws:ec2:us-east-2:123456789012:vpc-endpoint/vpce-0123456789abcdef0",
        )
        self.assertEqual(
            matches[0]["Condition"]["StringEquals"]["aws:RequestedRegion"], "us-east-2"
        )


class LambdaHardeningPolicyTests(unittest.TestCase):
    """Render and check the SPEC 07.1 per-function transition policies offline."""

    FUNCTIONS = {
        "auth": ("gootip-auth-dev", "gootip-auth-dev-lambda"),
        "core_api": ("gootip-core-dev", "gootip-core-dev-lambda"),
        "db_config": ("lambda_db_config", "gootip-db-config-dev-lambda"),
        "auth_migrations": (
            "gootip-dev-auth-migrations",
            "gootip-dev-auth-migrations-lambda",
        ),
        "core_migrations": (
            "gootip-dev-core-migrations",
            "gootip-dev-core-migrations-lambda",
        ),
    }
    LEGACY_ATTACHMENTS = {
        "auth": ("lambda_basic", "lambda_vpc"),
        "core_api": (),
        "db_config": ("db_config_basic", "db_config_vpc"),
        "auth_migrations": ("auth_migrations_basic", "auth_migrations_vpc"),
        "core_migrations": ("core_migrations_basic", "core_migrations_vpc"),
    }
    VPC_ACTIONS = {
        "ec2:AssignPrivateIpAddresses",
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:UnassignPrivateIpAddresses",
    }

    @classmethod
    def setUpClass(cls):
        cls.plan = evaluator.render_plan(evaluator.APPLICATION_MAXIMUM)
        cls.resources = list(evaluator.iter_resources(cls.plan))

    def policy_by_name(self, name):
        matches = [
            resource
            for resource in self.resources
            if resource.get("type") == "aws_iam_policy"
            and resource.get("values", {}).get("name") == name
        ]
        self.assertEqual(len(matches), 1, name)
        return json.loads(matches[0]["values"]["policy"])

    @staticmethod
    def arn_equals_context_matches(expected, context):
        return context is not None and expected == context

    def test_each_function_gets_exact_stream_and_vpc_policies(self):
        for key, (function_name, role_name) in self.FUNCTIONS.items():
            with self.subTest(function=key):
                logs = self.policy_by_name(f"{function_name}-logs")["Statement"]
                self.assertEqual(len(logs), 1)
                self.assertEqual(
                    set(logs[0]["Action"]),
                    {"logs:CreateLogStream", "logs:PutLogEvents"},
                )
                self.assertEqual(
                    logs[0]["Resource"],
                    "arn:aws:logs:us-east-2:123456789012:log-group:"
                    f"/aws/lambda/{function_name}:*",
                )

                vpc = self.policy_by_name(f"{function_name}-vpc")["Statement"]
                self.assertEqual(len(vpc), 2)
                by_sid = {statement["Sid"]: statement for statement in vpc}
                allow = by_sid["AllowLambdaVpcInterfaceOperationsInConfiguredRegion"]
                deny = by_sid["DenyFunctionCodeVpcInterfaceOperations"]
                for statement in (allow, deny):
                    self.assertEqual(set(statement["Action"]), self.VPC_ACTIONS)
                    self.assertEqual(statement["Resource"], "*")
                self.assertEqual(
                    allow["Condition"]["StringEquals"]["aws:RequestedRegion"],
                    "us-east-2",
                )
                function_arn = (
                    f"arn:aws:lambda:us-east-2:123456789012:function:{function_name}"
                )
                self.assertEqual(
                    deny["Condition"]["ArnEquals"]["lambda:SourceFunctionArn"],
                    function_arn,
                )
                # IAM ArnEquals does not match when the request context key is
                # absent; this structural fixture is offline, not live simulation.
                self.assertTrue(self.arn_equals_context_matches(function_arn, function_arn))
                self.assertFalse(self.arn_equals_context_matches(function_arn, None))
                self.assertFalse(
                    self.arn_equals_context_matches(function_arn, function_arn + ":1")
                )

                attachments = {
                    resource["address"]
                    for resource in self.resources
                    if resource.get("type") == "aws_iam_role_policy_attachment"
                }
                self.assertIn(
                    f'aws_iam_role_policy_attachment.lambda_logs["{key}"]',
                    attachments,
                )
                self.assertIn(
                    f'aws_iam_role_policy_attachment.lambda_vpc_scoped["{key}"]',
                    attachments,
                )
                logs_attachment = next(
                    resource
                    for resource in self.resources
                    if resource.get("type") == "aws_iam_role_policy_attachment"
                    and resource["address"]
                    == f'aws_iam_role_policy_attachment.lambda_logs["{key}"]'
                )
                self.assertEqual(logs_attachment["values"]["role"], role_name)

    def test_staged_withdrawal_is_limited_to_approved_roles(self):
        addresses = {
            resource["address"]
            for resource in self.resources
            if resource.get("type") == "aws_iam_role_policy_attachment"
        }
        for key, attachments_for_function in self.LEGACY_ATTACHMENTS.items():
            with self.subTest(function=key):
                for attachment in attachments_for_function:
                    address = f"aws_iam_role_policy_attachment.{attachment}[0]"
                    if key in {"auth", "core_api", "db_config", "core_migrations", "auth_migrations"}:
                        self.assertNotIn(address, addresses)
                    else:
                        self.assertIn(address, addresses)
                self.assertIn(
                    f'aws_iam_role_policy_attachment.lambda_logs["{key}"]', addresses
                )
                self.assertIn(
                    f'aws_iam_role_policy_attachment.lambda_vpc_scoped["{key}"]',
                    addresses,
                )


def make_plan(resources):
    """Build a minimal Terraform plan shape from resource dictionaries."""
    return {"planned_values": {"root_module": {"resources": list(resources)}}}


def write_root(directory, contents):
    (Path(directory) / "main.tf").write_text(contents)
    return Path(directory)


class SizeBudgetTests(unittest.TestCase):
    def test_size_thresholds_are_inclusive(self):
        self.assertEqual(guardrails.classify_size(0), "healthy")
        self.assertEqual(guardrails.classify_size(4_499), "healthy")
        self.assertEqual(guardrails.classify_size(4_500), "warning")
        self.assertEqual(guardrails.classify_size(5_499), "warning")
        self.assertEqual(guardrails.classify_size(5_500), "failure")
        self.assertEqual(guardrails.classify_size(6_144), "failure")

    def test_aws_hard_limit_boundary(self):
        self.assertFalse(guardrails.exceeds_aws_limit(6_144))
        self.assertTrue(guardrails.exceeds_aws_limit(6_145))

    def test_non_whitespace_length_ignores_whitespace(self):
        self.assertEqual(guardrails.non_whitespace_length('{ "a" : 1 }\n'), 7)


class AttachmentBudgetTests(unittest.TestCase):
    def test_attachment_thresholds_are_inclusive(self):
        self.assertEqual(guardrails.classify_attachments(0), "healthy")
        self.assertEqual(guardrails.classify_attachments(7), "healthy")
        self.assertEqual(guardrails.classify_attachments(8), "warning")
        self.assertEqual(guardrails.classify_attachments(9), "warning")
        self.assertEqual(guardrails.classify_attachments(10), "warning")
        self.assertEqual(guardrails.classify_attachments(11), "failure")

    def test_counts_include_aws_and_customer_managed_and_exclude_boundary(self):
        plan = make_plan(
            [
                {
                    "type": "aws_iam_role_policy_attachment",
                    "address": "aws_iam_role_policy_attachment.aws_managed",
                    "values": {
                        "role": "r1",
                        "policy_arn": "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                    },
                },
                {
                    "type": "aws_iam_role_policy_attachment",
                    "address": "aws_iam_role_policy_attachment.customer_managed",
                    "values": {"role": "r1", "policy_arn": "arn:aws:iam::123456789012:policy/gootip/x"},
                },
                {
                    "type": "aws_iam_role",
                    "address": "aws_iam_role.r1",
                    "values": {"name": "r1", "permissions_boundary": "arn:aws:iam::123456789012:policy/gootip/boundary"},
                },
            ]
        )
        self.assertEqual(guardrails.attachment_counts(plan), {"r1": 2})
        self.assertEqual(
            guardrails.role_boundaries(plan),
            {"r1": "arn:aws:iam::123456789012:policy/gootip/boundary"},
        )

    def test_exclusive_attachment_roles_are_counted(self):
        plan = make_plan(
            [
                {
                    "type": "aws_iam_policy_attachment",
                    "address": "aws_iam_policy_attachment.x",
                    "values": {"roles": ["r1", "r2"], "policy_arn": "arn:aws:iam::123456789012:policy/gootip/x"},
                }
            ]
        )
        self.assertEqual(guardrails.attachment_counts(plan), {"r1": 1, "r2": 1})


class NormalizationTests(unittest.TestCase):
    def test_normalize_address_strips_count_index(self):
        self.assertEqual(guardrails.normalize_address("aws_iam_policy.x[0]"), "aws_iam_policy.x")
        self.assertEqual(guardrails.normalize_address("aws_iam_policy.y"), "aws_iam_policy.y")
        self.assertEqual(
            guardrails.normalize_address('aws_iam_policy.x["auth"]'),
            'aws_iam_policy.x["auth"]',
        )

    def test_statement_wildcards_normalize_single_string_fields(self):
        document = {
            "Statement": [
                {"Sid": "Wild", "Action": "s3:*", "Resource": "arn:aws:s3:::bucket/*"},
                {
                    "Sid": "Negative",
                    "NotAction": ["sts:AssumeRole"],
                    "NotResource": "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-*",
                },
                {"Sid": "Plain", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::bucket/object"]},
            ]
        }
        self.assertEqual(
            guardrails.statement_wildcards(document),
            {("Wild", "Action"), ("Wild", "Resource"), ("Negative", "NotResource")},
        )

    def test_normalized_statement_keeps_every_semantic_field(self):
        statement = {
            "Sid": "S",
            "Effect": "Allow",
            "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::bucket/object",
            "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-2"}},
        }
        normalized = evaluator.normalized_statement(statement)
        self.assertEqual(normalized["Action"], ["s3:GetObject"])
        self.assertEqual(normalized["Resource"], ["arn:aws:s3:::bucket/object"])
        self.assertIn("Condition", normalized)


class CoverageTests(unittest.TestCase):
    def test_duplicate_sids_detected_per_document(self):
        document = {"Statement": [{"Sid": "A"}, {"Sid": "B"}, {"Sid": "A"}]}
        self.assertEqual(guardrails.duplicate_sids(document), {"A"})

    def test_unrendered_undeclared_unknown_and_inline_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = write_root(
                directory,
                'resource "aws_iam_policy" "declared" {}\n'
                'resource "aws_iam_policy" "missing" {}\n'
                'resource "aws_iam_role_policy" "inline" {}\n'
                'resource "aws_iam_role_policy" "gated_off" {}\n',
            )
            plan = make_plan(
                [
                    {
                        "type": "aws_iam_policy",
                        "address": "aws_iam_policy.declared[0]",
                        "values": {"name": "Declared", "path": "/", "policy": None},
                    },
                    {
                        "type": "aws_iam_policy",
                        "address": "aws_iam_policy.extra",
                        "values": {"name": "Extra", "path": "/", "policy": '{"Statement": []}'},
                    },
                    {
                        "type": "aws_iam_role_policy",
                        "address": "aws_iam_role_policy.inline",
                        "values": {"name": "Inline", "role": "r1", "policy": '{"Statement": []}'},
                    },
                ]
            )
            report = guardrails.Report()
            report.evaluate_plan("test", root, plan)

            self.assertIn("UNRENDERED_POLICY aws_iam_policy.missing", report.failures)
            self.assertIn("UNDECLARED_POLICY aws_iam_policy.extra", report.failures)
            self.assertIn("INLINE_POLICY aws_iam_role_policy.inline", report.failures)
            # A declared inline policy that the approved configuration gates off
            # (count = 0) is not in effect and must not be reported.
            self.assertNotIn("INLINE_POLICY aws_iam_role_policy.gated_off", report.failures)
            self.assertTrue(
                any(finding.startswith("UNKNOWN_POLICY_DOCUMENT aws_iam_policy.declared") for finding in report.failures)
            )


    def test_for_each_policy_instances_are_all_checked_without_false_coverage_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = write_root(
                directory,
                'resource "aws_iam_policy" "lambda_vpc" { for_each = {} }\n',
            )
            document = json.dumps(
                {
                    "Statement": [
                        {
                            "Sid": "Scoped",
                            "Effect": "Allow",
                            "Action": ["ec2:CreateNetworkInterface"],
                            "Resource": "*",
                        }
                    ]
                }
            )
            plan = make_plan(
                [
                    {
                        "type": "aws_iam_policy",
                        "address": f'aws_iam_policy.lambda_vpc["{key}"]',
                        "values": {"name": name, "path": "/", "policy": document},
                    }
                    for key, name in (("auth", "auth-vpc"), ("core", "core-vpc"))
                ]
            )
            report = guardrails.Report()
            report.evaluate_plan("test", root, plan)

            self.assertFalse(
                any(
                    finding.startswith(("UNRENDERED_POLICY", "UNDECLARED_POLICY"))
                    for finding in report.failures
                )
            )
            self.assertEqual(
                sum(finding.startswith("UNREVIEWED_WILDCARD") for finding in report.failures),
                2,
            )

    def test_duplicate_policy_identity_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = write_root(
                directory,
                'resource "aws_iam_policy" "a" {}\nresource "aws_iam_policy" "b" {}\n',
            )
            document = json.dumps({"Statement": []})
            plan = make_plan(
                [
                    {"type": "aws_iam_policy", "address": "aws_iam_policy.a", "values": {"name": "Same", "path": "/", "policy": document}},
                    {"type": "aws_iam_policy", "address": "aws_iam_policy.b", "values": {"name": "Same", "path": "/", "policy": document}},
                ]
            )
            report = guardrails.Report()
            report.evaluate_plan("test", root, plan)
            self.assertTrue(any(finding.startswith("DUPLICATE_POLICY_IDENTITY") for finding in report.failures))

    def test_size_failure_and_warning_through_evaluate_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = write_root(directory, 'resource "aws_iam_policy" "big" {}\n')
            for padding, expected in ((4_600, "POLICY_SIZE_WARNING"), (5_600, "POLICY_SIZE_FAILURE")):
                document = json.dumps(
                    {
                        "Statement": [
                            {"Sid": "S", "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["x" * padding]}
                        ]
                    }
                )
                plan = make_plan(
                    [{"type": "aws_iam_policy", "address": "aws_iam_policy.big", "values": {"name": "Big", "path": "/", "policy": document}}]
                )
                report = guardrails.Report()
                report.evaluate_plan("test", root, plan)
                findings = report.warnings + report.failures
                self.assertTrue(any(finding.startswith(expected) for finding in findings), expected)


class CredentialLifecycleInlineTests(unittest.TestCase):
    def test_only_the_exact_temporary_credential_role_grants_pass(self):
        report = guardrails.Report()
        statements = [
            {
                "Sid": sid,
                "Effect": "Allow",
                "Action": sorted(actions),
                "Resource": resource,
            }
            for sid, (actions, resource) in guardrails.CREDENTIAL_LIFECYCLE_STATEMENTS.items()
        ]
        resource = {
            "address": guardrails.CREDENTIAL_LIFECYCLE_INLINE_ADDRESS,
            "values": {
                "policy": json.dumps({"Version": "2012-10-17", "Statement": statements})
            },
        }
        report._check_credential_lifecycle_inline(resource)
        self.assertEqual(report.failures, [])

        statements[0]["Action"].append("iam:PassRole")
        resource["values"]["policy"] = json.dumps(
            {"Version": "2012-10-17", "Statement": statements}
        )
        report._check_credential_lifecycle_inline(resource)
        self.assertIn(
            f"CREDENTIAL_LIFECYCLE_SCOPE_FAILURE {guardrails.CREDENTIAL_LIFECYCLE_INLINE_ADDRESS}",
            report.failures,
        )


class TransitionGateTests(unittest.TestCase):
    """SPEC 03.1: the short-lived transition core is gated on size and exact SIDs."""

    @staticmethod
    def transition_plan(sids, padding=0):
        statements = [
            {
                "Sid": sid,
                "Effect": "Allow",
                "Action": ["iam:GetPolicy"],
                "Resource": ["arn:aws:iam::1:policy/x"],
            }
            for sid in sids
        ]
        if padding:
            statements.append(
                {
                    "Sid": "Padding",
                    "Effect": "Allow",
                    "Action": ["iam:GetPolicy"],
                    "Resource": ["x" * padding],
                }
            )
        document = json.dumps({"Statement": statements})
        return make_plan(
            [
                {
                    "type": "aws_iam_policy",
                    "address": guardrails.TRANSITION_POLICY_ADDRESS,
                    "values": {"name": "Admin", "path": "/", "policy": document},
                }
            ]
        )

    def test_transition_render_enables_the_split_flag(self):
        self.assertEqual(
            evaluator.BOOTSTRAP_TRANSITION.variables["split_policy_creation_enabled"], "true"
        )
        expected = {
            **evaluator.BOOTSTRAP_MAXIMUM.variables,
            "auth_runtime_secret_arn": evaluator.FIXTURE_AUTH_RUNTIME_SECRET_ARN,
            "auth_migrator_secret_arn": evaluator.FIXTURE_AUTH_MIGRATOR_SECRET_ARN,
            "core_runtime_secret_arn": evaluator.FIXTURE_CORE_RUNTIME_SECRET_ARN,
            "core_migrator_secret_arn": evaluator.FIXTURE_CORE_MIGRATOR_SECRET_ARN,
        }
        expected["split_policy_creation_enabled"] = "true"
        self.assertEqual(evaluator.BOOTSTRAP_TRANSITION.variables, expected)
        self.assertEqual(
            evaluator.BOOTSTRAP_TRANSITION.source_files, evaluator.BOOTSTRAP_MAXIMUM.source_files
        )

    def test_healthy_transition_core_passes(self):
        report = guardrails.Report()
        report.check_transition_core(self.transition_plan(sorted(guardrails.TRANSITION_RETAINED_SIDS)))
        self.assertEqual(report.failures, [])

    def test_repository_transition_limit_fails(self):
        report = guardrails.Report()
        report.check_transition_core(
            self.transition_plan(sorted(guardrails.TRANSITION_RETAINED_SIDS), padding=5_800)
        )
        self.assertTrue(
            any(finding.startswith("TRANSITION_POLICY_SIZE_FAILURE") for finding in report.failures)
        )

    def test_aws_hard_limit_fails(self):
        report = guardrails.Report()
        report.check_transition_core(
            self.transition_plan(sorted(guardrails.TRANSITION_RETAINED_SIDS), padding=6_200)
        )
        self.assertTrue(
            any(finding.startswith("TRANSITION_POLICY_SIZE_OVER_AWS_LIMIT") for finding in report.failures)
        )

    def test_missing_retained_sid_fails(self):
        report = guardrails.Report()
        report.check_transition_core(self.transition_plan([]))
        self.assertTrue(
            any(finding.startswith("TRANSITION_MISSING_SIDS") for finding in report.failures)
        )

    def test_unexpected_withdrawn_sid_fails(self):
        report = guardrails.Report()
        report.check_transition_core(
            self.transition_plan(
                sorted(guardrails.TRANSITION_RETAINED_SIDS) + ["ManageExactSplitPolicyTags"]
            )
        )
        self.assertTrue(
            any(finding.startswith("TRANSITION_UNEXPECTED_SIDS") for finding in report.failures)
        )

    def test_missing_transition_resource_fails(self):
        report = guardrails.Report()
        report.check_transition_core(make_plan([]))
        self.assertTrue(
            any(finding.startswith("MISSING_TRANSITION_POLICY") for finding in report.failures)
        )


class RoleSecretMaximumGateTests(unittest.TestCase):
    """SPEC 03.1: the role-secret handoff render is gated on both ceilings."""

    @staticmethod
    def plan(paddings):
        resources = []
        for index, padding in enumerate(paddings):
            document = json.dumps(
                {
                    "Statement": [
                        {
                            "Sid": "S",
                            "Effect": "Allow",
                            "Action": ["iam:GetPolicy"],
                            "Resource": ["x" * padding],
                        }
                    ]
                }
            )
            resources.append(
                {
                    "type": "aws_iam_policy",
                    "address": f"aws_iam_policy.p{index}",
                    "values": {"name": f"P{index}", "path": "/", "policy": document},
                }
            )
        return make_plan(resources)

    def test_render_supplies_exactly_the_role_secret_arns(self):
        variables = evaluator.BOOTSTRAP_ROLE_SECRET_MAXIMUM.variables
        self.assertEqual(
            variables["auth_runtime_secret_arn"], evaluator.FIXTURE_AUTH_RUNTIME_SECRET_ARN
        )
        self.assertEqual(
            variables["auth_migrator_secret_arn"], evaluator.FIXTURE_AUTH_MIGRATOR_SECRET_ARN
        )
        self.assertNotEqual(
            variables.get("role_secret_creation_enabled"), "true"
        )

    def test_healthy_render_passes(self):
        report = guardrails.Report()
        report.check_role_secret_maximum(self.plan([100, 200]))
        self.assertEqual(report.failures, [])

    def test_transition_limit_fails(self):
        report = guardrails.Report()
        report.check_role_secret_maximum(self.plan([100, 5_500]))
        self.assertTrue(
            any(
                finding.startswith("ROLE_SECRET_MAXIMUM_SIZE_FAILURE")
                for finding in report.failures
            )
        )

    def test_aws_hard_limit_fails(self):
        report = guardrails.Report()
        report.check_role_secret_maximum(self.plan([6_200]))
        self.assertTrue(
            any(
                finding.startswith("ROLE_SECRET_MAXIMUM_OVER_AWS_LIMIT")
                for finding in report.failures
            )
        )


class WildcardReviewTests(unittest.TestCase):
    def test_unreviewed_wildcard_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = write_root(directory, 'resource "aws_iam_policy" "p" {}\n')
            document = json.dumps(
                {"Statement": [{"Sid": "NewWild", "Effect": "Allow", "Action": ["*"], "Resource": ["*"]}]}
            )
            plan = make_plan(
                [{"type": "aws_iam_policy", "address": "aws_iam_policy.p", "values": {"name": "Unreviewed", "path": "/", "policy": document}}]
            )
            report = guardrails.Report()
            report.evaluate_plan("test", root, plan)
            self.assertTrue(any(finding.startswith("UNREVIEWED_WILDCARD") for finding in report.failures))

    def test_stale_review_detection(self):
        complete = guardrails.Report()
        complete.observed_wildcards = set(guardrails.REVIEWED_WILDCARDS)
        complete.check_stale_reviews()
        self.assertEqual(complete.failures, [])

        incomplete = guardrails.Report()
        incomplete.observed_wildcards = set(guardrails.REVIEWED_WILDCARDS) - {next(iter(guardrails.REVIEWED_WILDCARDS))}
        incomplete.check_stale_reviews()
        self.assertEqual(len(incomplete.failures), 1)
        self.assertTrue(incomplete.failures[0].startswith("STALE_WILDCARD_REVIEW"))


class DocumentedSubstitutionTests(unittest.TestCase):
    """SPEC 02.1 amendment: the comparator accepts only the recorded substitution.

    The pre-split baseline deliberately keeps the invalid action, so history is
    never silently re-recorded. These tests pin the allowance to exactly one
    substitution, in exactly one statement, on the Action field only.
    """

    @staticmethod
    def state_statement(actions):
        return {
            "Action": list(actions),
            "Resource": "arn:aws:s3:::gootip-terraform-state-123456789012",
        }

    def compare(self, before_actions, after_actions):
        before = {"ManageExactStateBucketConfiguration": self.state_statement(before_actions)}
        after = {"ManageExactStateBucketConfiguration": self.state_statement(after_actions)}
        return comparator.compare_union(
            "admin union", before, after, allow_lifecycle_additions=True
        )

    def test_documented_substitution_is_accepted(self):
        self.assertEqual(
            self.compare(
                ["s3:GetBucketAcl", "s3:PutBucketEncryption"],
                ["s3:GetBucketAcl", "s3:PutEncryptionConfiguration"],
            ),
            [],
        )

    def test_reversed_substitution_is_rejected(self):
        problems = self.compare(["s3:PutEncryptionConfiguration"], ["s3:PutBucketEncryption"])
        self.assertTrue(any("lost" in problem for problem in problems))


    def test_substitution_with_an_extra_action_is_rejected(self):
        problems = self.compare(
            ["s3:PutBucketEncryption"],
            ["s3:PutEncryptionConfiguration", "s3:DeleteBucket"],
        )
        self.assertTrue(any("s3:DeleteBucket" in problem for problem in problems))

    def test_substitution_in_another_statement_is_rejected(self):
        before = {"SomeOtherSid": self.state_statement(["s3:PutBucketEncryption"])}
        after = {"SomeOtherSid": self.state_statement(["s3:PutEncryptionConfiguration"])}
        problems = comparator.compare_union(
            "admin union", before, after, allow_lifecycle_additions=True
        )
        self.assertTrue(any("altered statement" in problem for problem in problems))

    def test_a_different_action_pair_is_rejected(self):
        problems = self.compare(["s3:PutBucketVersioning"], ["s3:PutBucketAcl"])
        self.assertTrue(any("lost" in problem for problem in problems))

    def test_resource_drift_alongside_the_substitution_is_rejected(self):
        before = {"ManageExactStateBucketConfiguration": self.state_statement(["s3:PutBucketEncryption"])}
        after = {
            "ManageExactStateBucketConfiguration": {
                "Action": ["s3:PutEncryptionConfiguration"],
                "Resource": "arn:aws:s3:::some-other-bucket",
            }
        }
        problems = comparator.compare_union(
            "admin union", before, after, allow_lifecycle_additions=True
        )
        self.assertTrue(any("lost" in problem for problem in problems))


class ReviewedComparatorAmendmentTests(unittest.TestCase):
    """Later specs remain exact exceptions to the immutable SPEC 03.1 baseline."""

    def test_rds_upgrade_resources_remain_exact(self):
        sid = "ModifyExactGootipRdsInstanceForUpgrade"
        statement = {
            "Effect": "Allow",
            "Action": "rds:ModifyDBInstance",
            "Resource": [
                "arn:aws:rds:us-east-2:123456789012:db:gootip-dev",
                "arn:aws:rds:us-east-2:123456789012:pg:gootip-dev-postgres18",
            ],
        }
        self.assertEqual(comparator.compare_union(
            "deploy union", {}, {sid: statement}, allow_lifecycle_additions=False
        ), [])
        statement["Resource"].append("arn:aws:rds:us-east-2:123456789012:db:other")
        self.assertTrue(comparator.compare_union(
            "deploy union", {}, {sid: statement}, allow_lifecycle_additions=False
        ))

    def test_exact_reviewed_addition_is_accepted(self):
        statement = copy.deepcopy(
            comparator.REVIEWED_ADDED_STATEMENTS["ReadDbTunnelResources"]
        )
        statement["Sid"] = "ReadDbTunnelResources"

        self.assertEqual(
            comparator.compare_union(
                "deploy union",
                {},
                {"ReadDbTunnelResources": statement},
                allow_lifecycle_additions=False,
            ),
            [],
        )

    def test_reviewed_addition_with_extra_action_is_rejected(self):
        statement = copy.deepcopy(
            comparator.REVIEWED_ADDED_STATEMENTS["ReadDbTunnelResources"]
        )
        statement["Action"].append("ec2:DescribeAccountAttributes")

        problems = comparator.compare_union(
            "deploy union",
            {},
            {"ReadDbTunnelResources": statement},
            allow_lifecycle_additions=False,
        )

        self.assertTrue(any("added statement" in problem for problem in problems))

    def test_exact_passrole_replacement_is_accepted(self):
        old_sid = "PassExactAdministrativeFunctionRole"
        new_sid, statement = comparator.REVIEWED_STATEMENT_REPLACEMENTS[old_sid]

        self.assertEqual(
            comparator.compare_union(
                "deploy union",
                {old_sid: {"Effect": "Allow"}},
                {new_sid: copy.deepcopy(statement)},
                allow_lifecycle_additions=False,
            ),
            [],
        )

    def test_passrole_replacement_with_extra_role_is_rejected(self):
        old_sid = "PassExactAdministrativeFunctionRole"
        new_sid, statement = comparator.REVIEWED_STATEMENT_REPLACEMENTS[old_sid]
        widened = copy.deepcopy(statement)
        widened["Resource"].append("arn:aws:iam::123456789012:role/gootip/admin")

        problems = comparator.compare_union(
            "deploy union",
            {old_sid: {"Effect": "Allow"}},
            {new_sid: widened},
            allow_lifecycle_additions=False,
        )

        self.assertTrue(any("removed statements" in problem for problem in problems))
        self.assertTrue(any("added statement" in problem for problem in problems))

    def test_exact_network_tag_alteration_is_accepted_but_drift_is_not(self):
        sid = "TagFoundationNetworkResources"
        expected = copy.deepcopy(comparator.REVIEWED_ALTERED_STATEMENTS[sid])
        before = {sid: {"Effect": "Allow"}}

        self.assertEqual(
            comparator.compare_union(
                "deploy union",
                before,
                {sid: expected},
                allow_lifecycle_additions=False,
            ),
            [],
        )

        expected["Condition"]["StringEquals"]["aws:RequestTag/purpose"] = "other"
        problems = comparator.compare_union(
            "deploy union",
            before,
            {sid: expected},
            allow_lifecycle_additions=False,
        )
        self.assertTrue(any("altered statement" in problem for problem in problems))


class PluginCacheTests(unittest.TestCase):
    """SPEC 03.2: the evaluator reuses a provider cache without rendering.

    Both cases are pure: they exercise ``plugin_cache_env()`` only and never
    materialize Terraform or make an AWS request.
    """

    def test_plugin_cache_env_respects_override(self):
        with tempfile.TemporaryDirectory() as directory:
            override = Path(directory) / "override-cache"
            with mock.patch.dict(os.environ, {"TF_PLUGIN_CACHE_DIR": str(override)}):
                env = evaluator.plugin_cache_env()
            self.assertEqual(env["TF_PLUGIN_CACHE_DIR"], str(override))
            self.assertTrue(override.is_dir())

    def test_plugin_cache_env_creates_default_when_unset(self):
        with tempfile.TemporaryDirectory() as directory:
            default = Path(directory) / "default-cache"
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("TF_PLUGIN_CACHE_DIR", None)
                with mock.patch.object(evaluator, "DEFAULT_PLUGIN_CACHE_DIR", default):
                    env = evaluator.plugin_cache_env()
            self.assertEqual(env["TF_PLUGIN_CACHE_DIR"], str(default))
            self.assertTrue(default.is_dir())

    def test_plugin_cache_env_normalizes_relative_path(self):
        with tempfile.TemporaryDirectory() as directory:
            original = os.getcwd()
            os.chdir(directory)
            try:
                with mock.patch.dict(os.environ, {"TF_PLUGIN_CACHE_DIR": "relative-cache"}):
                    env = evaluator.plugin_cache_env()
                expected = Path(os.getcwd()) / "relative-cache"
            finally:
                os.chdir(original)
            self.assertTrue(os.path.isabs(env["TF_PLUGIN_CACHE_DIR"]))
            self.assertEqual(env["TF_PLUGIN_CACHE_DIR"], str(expected))
            self.assertTrue(expected.is_dir())


def application_plan_fixture():
    scopes = {
        "aws_iam_policy.secrets_read": [evaluator.FIXTURE_APPLICATION_SECRET_ARN, evaluator.FIXTURE_AUTH_RUNTIME_SECRET_ARN],
        "aws_iam_policy.db_config_secrets_read": [
            evaluator.FIXTURE_RDS_MASTER_SECRET_ARN,
            evaluator.FIXTURE_AUTH_RUNTIME_SECRET_ARN,
            evaluator.FIXTURE_AUTH_MIGRATOR_SECRET_ARN,
            evaluator.FIXTURE_CORE_RUNTIME_SECRET_ARN,
            evaluator.FIXTURE_CORE_MIGRATOR_SECRET_ARN,
            evaluator.FIXTURE_DB_OPERATOR_SECRET_ARN,
        ],
        "aws_iam_policy.auth_migrations_secrets_read": [evaluator.FIXTURE_AUTH_MIGRATOR_SECRET_ARN],
        "aws_iam_policy.core_migrations_secrets_read": [evaluator.FIXTURE_CORE_MIGRATOR_SECRET_ARN],
    }
    return {"planned_values": {"root_module": {"resources": [
        {"address": address, "type": "aws_iam_policy", "values": {"policy": json.dumps({"Statement": [
            {"Action": "secretsmanager:GetSecretValue", "Resource": arns}
        ]})}} for address, arns in scopes.items()
    ]}}}


class IsolationTests(unittest.TestCase):
    def test_batch_cleans_directory_on_success(self):
        captured = []
        original = evaluator.tempfile.TemporaryDirectory

        def factory(*args, **kwargs):
            directory = original(*args, **kwargs)
            captured.append(Path(directory.name))
            return directory

        with mock.patch.object(evaluator.tempfile, "TemporaryDirectory", side_effect=factory), \
             mock.patch.object(evaluator, "_write_isolated_root"), \
             mock.patch.object(evaluator.subprocess, "run"), \
             mock.patch.object(evaluator, "_run_terraform_plan"), \
             mock.patch.object(evaluator, "_read_plan", return_value={"ok": True}), \
             mock.patch.object(evaluator, "plugin_cache_env", return_value={}):
            self.assertEqual(evaluator.render_plans([evaluator.BOOTSTRAP_MAXIMUM]),
                             {"bootstrap-maximum": {"ok": True}})
        self.assertEqual(len(captured), 1)
        self.assertFalse(captured[0].exists())

    def test_batch_cleans_directory_when_plan_fails(self):
        captured = []
        original = evaluator.tempfile.TemporaryDirectory

        def factory(*args, **kwargs):
            directory = original(*args, **kwargs)
            captured.append(Path(directory.name))
            return directory

        with mock.patch.object(evaluator.tempfile, "TemporaryDirectory", side_effect=factory), \
             mock.patch.object(evaluator, "_write_isolated_root"), \
             mock.patch.object(evaluator.subprocess, "run"), \
             mock.patch.object(evaluator, "_run_terraform_plan", side_effect=RuntimeError("plan failed")), \
             mock.patch.object(evaluator, "plugin_cache_env", return_value={}):
            with self.assertRaisesRegex(RuntimeError, "plan failed"):
                evaluator.render_plans([evaluator.BOOTSTRAP_MAXIMUM])
        self.assertEqual(len(captured), 1)
        self.assertFalse(captured[0].exists())

    def test_render_plan_remains_compatible(self):
        root = evaluator.IsolatedRoot("compat", evaluator.BOOTSTRAP_ROOT, (), {"a": "1"})
        with mock.patch.object(evaluator, "render_plans", return_value={"compat": {"plan": True}}) as batch:
            self.assertEqual(evaluator.render_plan(root, variables={"b": "2"}), {"plan": True})
        configured = batch.call_args.args[0][0]
        self.assertEqual(configured.variables, {"a": "1", "b": "2"})

    def test_batch_initializes_bootstrap_and_application_groups_once_each(self):
        roots = [evaluator.BOOTSTRAP_MAXIMUM, evaluator.BOOTSTRAP_STANDING,
                 evaluator.APPLICATION_MAXIMUM]
        with mock.patch.object(evaluator, "_write_isolated_root"), mock.patch.object(
            evaluator.subprocess, "run"
        ) as run, mock.patch.object(evaluator, "_run_terraform_plan"), mock.patch.object(
            evaluator, "_read_plan", side_effect=[{"name": root.name} for root in roots]
        ), mock.patch.object(evaluator, "plugin_cache_env", return_value={}):
            plans = evaluator.render_plans(roots)
        self.assertEqual(sum(call.args[0][1:3] == ["init", "-reconfigure"] for call in run.call_args_list), 2)
        self.assertEqual(set(plans), {root.name for root in roots})

    def test_render_plans_initializes_once_per_group_and_keeps_plans_distinct(self):
        with tempfile.TemporaryDirectory() as source:
            root = Path(source)
            (root / "main.tf").write_text("resource {}")
            (root / ".terraform.lock.hcl").write_text("# fixture lockfile\n")
            first = evaluator.IsolatedRoot("first", root, ("main.tf",), {"x": "1"})
            second = evaluator.IsolatedRoot("second", root, ("main.tf",), {"x": "2"})
            calls = []

            def run(command, **kwargs):
                calls.append(command)
                if command[1] == "init":
                    self.assertIn("-lockfile=readonly", command)
                    self.assertEqual(
                        (Path(kwargs["cwd"]) / ".terraform.lock.hcl").read_bytes(),
                        (root / ".terraform.lock.hcl").read_bytes(),
                    )
                if command[1] == "plan":
                    (Path(kwargs["cwd"]) / "policy.tfplan").write_text(
                        __import__("json").dumps({"variables": command[-1]})
                    )

            with mock.patch.object(evaluator.subprocess, "run", side_effect=run), mock.patch.object(
                evaluator.subprocess, "check_output", side_effect=lambda command, cwd: Path(cwd, "policy.tfplan").read_text().encode()
            ), mock.patch.object(evaluator, "plugin_cache_env", return_value={}):
                plans = evaluator.render_plans([first, second])
            self.assertEqual(sum(command[1:3] == ["init", "-reconfigure"] for command in calls), 1)
            self.assertNotEqual(plans["first"], plans["second"])

    def test_excluded_source_files_are_rejected(self):
        spec = evaluator.IsolatedRoot(
            name="excluded",
            source_root=evaluator.BOOTSTRAP_ROOT,
            source_files=("backend.tf",),
        )
        with self.assertRaises(ValueError):
            evaluator.render_plan(spec)

    def test_temporary_directory_is_cleaned_on_failure(self):
        temp_root = Path(tempfile.gettempdir())
        before = set(temp_root.glob("iam-policy-cleanup-*"))
        spec = evaluator.IsolatedRoot(
            name="cleanup",
            source_root=temp_root,
            source_files=("definitely-missing.tf",),
        )
        with self.assertRaises(FileNotFoundError):
            evaluator.render_plan(spec)
        self.assertEqual(before, set(temp_root.glob("iam-policy-cleanup-*")))

    def test_render_plan_materializes_policies_and_cleans_up(self):
        original = evaluator.tempfile.TemporaryDirectory
        captured = []

        def temporary_directory(*args, **kwargs):
            directory = original(*args, **kwargs)
            captured.append(Path(directory.name))
            return directory

        plan = application_plan_fixture()
        with mock.patch.object(evaluator.tempfile, "TemporaryDirectory", side_effect=temporary_directory), \
             mock.patch.object(evaluator.subprocess, "run") as run, \
             mock.patch.object(evaluator, "_run_terraform_plan") as run_plan, \
             mock.patch.object(evaluator, "_read_plan", return_value=plan):
            rendered = evaluator.render_plan(evaluator.APPLICATION_MAXIMUM)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(
            run.call_args.args[0],
            [
                "terraform",
                "init",
                "-reconfigure",
                "-input=false",
                "-lockfile=readonly",
            ],
        )
        run_plan.assert_called_once()
        self.assertEqual(rendered, plan)
        self.assert_application_plan(plan)
        self.assertEqual(len(captured), 1)
        self.assertFalse(captured[0].exists())

    def assert_application_plan(self, plan):
        addresses = {
            guardrails.normalize_address(resource["address"])
            for resource in evaluator.iter_resources(plan)
            if resource.get("type") == "aws_iam_policy"
        }
        self.assertTrue(
            {
                "aws_iam_policy.secrets_read",
                "aws_iam_policy.db_config_secrets_read",
                "aws_iam_policy.auth_migrations_secrets_read",
                "aws_iam_policy.core_migrations_secrets_read",
            }
            <= addresses
        )
        self.assert_auth_runtime_secret_scope(plan)
        self.assert_db_config_secret_scope(plan)
        self.assert_core_migrations_secret_scope(plan)

    def assert_auth_runtime_secret_scope(self, plan):
        """SPEC 05: the rendered app-runtime policy reads only the two ARNs."""
        resource = next(
            item
            for item in evaluator.iter_resources(plan)
            if guardrails.normalize_address(item["address"])
            == "aws_iam_policy.secrets_read"
        )
        statements = [
            evaluator.normalized_statement(statement)
            for statement in json.loads(resource["values"]["policy"])["Statement"]
        ]

        self.assertEqual(len(statements), 1)
        self.assertEqual(statements[0]["Action"], ["secretsmanager:GetSecretValue"])
        self.assertEqual(
            statements[0]["Resource"],
            sorted(
                [
                    evaluator.FIXTURE_APPLICATION_SECRET_ARN,
                    evaluator.FIXTURE_AUTH_RUNTIME_SECRET_ARN,
                ]
            ),
        )
        self.assertNotIn(
            evaluator.FIXTURE_RDS_MASTER_SECRET_ARN, statements[0]["Resource"]
        )
        self.assertNotIn(
            evaluator.FIXTURE_AUTH_MIGRATOR_SECRET_ARN, statements[0]["Resource"]
        )

    def assert_db_config_secret_scope(self, plan):
        """SPEC 05.1: the temporary administrative policy reads the exact operator ARN."""
        resource = next(
            item
            for item in evaluator.iter_resources(plan)
            if guardrails.normalize_address(item["address"])
            == "aws_iam_policy.db_config_secrets_read"
        )
        statements = [
            evaluator.normalized_statement(statement)
            for statement in json.loads(resource["values"]["policy"])["Statement"]
        ]

        self.assertEqual(len(statements), 1)
        self.assertEqual(statements[0]["Action"], ["secretsmanager:GetSecretValue"])
        self.assertEqual(
            statements[0]["Resource"],
            sorted(
                [
                    evaluator.FIXTURE_RDS_MASTER_SECRET_ARN,
                    evaluator.FIXTURE_AUTH_RUNTIME_SECRET_ARN,
                    evaluator.FIXTURE_AUTH_MIGRATOR_SECRET_ARN,
                    evaluator.FIXTURE_CORE_RUNTIME_SECRET_ARN,
                    evaluator.FIXTURE_CORE_MIGRATOR_SECRET_ARN,
                    evaluator.FIXTURE_DB_OPERATOR_SECRET_ARN,
                ]
            ),
        )

    def assert_core_migrations_secret_scope(self, plan):
        """SPEC 06: the private Core runner reads only its exact migrator ARN."""
        resource = next(
            item
            for item in evaluator.iter_resources(plan)
            if guardrails.normalize_address(item["address"])
            == "aws_iam_policy.core_migrations_secrets_read"
        )
        statements = [
            evaluator.normalized_statement(statement)
            for statement in json.loads(resource["values"]["policy"])["Statement"]
        ]

        self.assertEqual(len(statements), 1)
        self.assertEqual(statements[0]["Action"], ["secretsmanager:GetSecretValue"])
        self.assertEqual(statements[0]["Resource"], [evaluator.FIXTURE_CORE_MIGRATOR_SECRET_ARN])


if __name__ == "__main__":
    unittest.main()
