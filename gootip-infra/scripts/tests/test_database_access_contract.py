#!/usr/bin/env python3
"""Focused offline contract tests for SPEC 05.2 private dev database access.

These tests read the Terraform sources and assert the reviewed security
boundary: no public networking, one private tunnel host, reference-only
security-group edges, exact operator/session permissions, and no escalation
capability. They never call AWS and never read a secret value.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APPLICATION_ACCESS = ROOT / "database_access.tf"
APPLICATION_VARIABLES = ROOT / "variables.tf"
APPLICATION_OUTPUTS = ROOT / "outputs.tf"
BOOTSTRAP_IAM = ROOT / "bootstrap" / "iam.tf"
BOOTSTRAP_VARIABLES = ROOT / "bootstrap" / "variables.tf"


def read(path: Path) -> str:
    if not path.exists():
        raise AssertionError(f"{path.relative_to(ROOT)} must exist for SPEC 05.2.")
    return path.read_text()


def block(source: str, header: str) -> str:
    """Return one HCL block, including nested braces, starting at ``header``."""
    start = source.index(header)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        character = source[index]
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    raise AssertionError(f"Unbalanced HCL block for {header!r}.")


def resource(source: str, resource_type: str, name: str) -> str:
    return block(source, f'resource "{resource_type}" "{name}" {{')


def policy_statement(document: str, sid: str) -> str:
    match = re.search(rf'sid\s*=\s*"{re.escape(sid)}"', document)
    if match is None:
        raise AssertionError(f"Policy statement {sid} must exist.")
    start = match.start()
    remainder = document[start:]
    end = remainder.index("\n  }")
    return remainder[: end + 4]


class PrivateNetworkingTests(unittest.TestCase):
    def test_database_access_is_gated_off_by_default(self):
        variables = read(APPLICATION_VARIABLES)
        declaration = block(
            variables, 'variable "database_operator_access_enabled" {'
        )
        self.assertIn("type        = bool", declaration)
        self.assertIn("default     = false", declaration)
        self.assertIn("validation", declaration)

    def test_application_root_has_no_public_or_general_egress_resources(self):
        source = read(APPLICATION_ACCESS).lower()
        for forbidden in (
            "aws_internet_gateway",
            "aws_nat_gateway",
            "aws_eip",
            "aws_vpn_gateway",
            "aws_ec2_client_vpn_endpoint",
            "aws_ec2_client_vpn_network_association",
            "aws_vpc_endpoint_service",
        ):
            self.assertNotIn(forbidden, source)
        self.assertNotIn("0.0.0.0/0", source)
        self.assertNotIn("::/0", source)

    def test_endpoint_and_instance_contract(self):
        source = read(APPLICATION_ACCESS)
        endpoint = resource(
            source, "aws_ec2_instance_connect_endpoint", "db_tunnel"
        )
        self.assertIn("subnet_id", endpoint)
        self.assertIn("aws_subnet.private[0].id", endpoint)
        self.assertIn("preserve_client_ip = false", endpoint)
        self.assertIn("${local.name_prefix}-db-eice", endpoint)

        instance = resource(source, "aws_instance", "db_tunnel")
        self.assertIn("ami", instance)
        self.assertIn("var.db_tunnel_ami_id", instance)
        self.assertIn("instance_type", instance)
        self.assertIn("var.db_tunnel_instance_type", instance)
        self.assertIn("aws_subnet.private[0].id", instance)
        self.assertIn("aws_security_group.db_tunnel[0].id", instance)
        self.assertRegex(instance, r"associate_public_ip_address\s*=\s*false")
        self.assertNotIn("iam_instance_profile", instance)
        self.assertIn('instance_initiated_shutdown_behavior = "stop"', instance)

        stopped_state = resource(
            source, "aws_ec2_instance_state", "db_tunnel_stopped"
        )
        self.assertIn("instance_id = aws_instance.db_tunnel[0].id", stopped_state)
        self.assertRegex(stopped_state, r'state\s*=\s*"stopped"')

        metadata = block(instance, "metadata_options {")
        self.assertRegex(metadata, r'http_endpoint\s*=\s*"enabled"')
        self.assertRegex(metadata, r'http_tokens\s*=\s*"required"')

        root = block(instance, "root_block_device {")
        self.assertRegex(root, r"volume_size\s*=\s*8")
        self.assertRegex(root, r'volume_type\s*=\s*"gp3"')
        self.assertRegex(root, r"encrypted\s*=\s*true")
        self.assertRegex(root, r"delete_on_termination\s*=\s*true")
        self.assertIn('purpose    = "db-tunnel"', instance)

    def test_security_group_edges_are_reference_only(self):
        source = read(APPLICATION_ACCESS)

        for group in ("db_tunnel_endpoint", "db_tunnel"):
            declaration = resource(source, "aws_security_group", group)
            self.assertIn("egress      = []", declaration)
            self.assertNotIn("egress {", declaration)
        self.assertNotIn("ingress {", resource(source, "aws_security_group", "db_tunnel_endpoint"))
        self.assertNotIn("ingress {", resource(source, "aws_security_group", "db_tunnel"))

        endpoint_egress = resource(
            source, "aws_vpc_security_group_egress_rule", "endpoint_to_tunnel_ssh"
        )
        self.assertRegex(endpoint_egress, r"from_port\s*=\s*22")
        self.assertRegex(endpoint_egress, r"to_port\s*=\s*22")
        self.assertRegex(endpoint_egress, r'ip_protocol\s*=\s*"tcp"')
        self.assertIn(
            "referenced_security_group_id = aws_security_group.db_tunnel[0].id",
            endpoint_egress,
        )
        self.assertNotIn("cidr_ipv4", endpoint_egress)
        self.assertNotIn("cidr_ipv6", endpoint_egress)

        tunnel_ingress = resource(
            source, "aws_vpc_security_group_ingress_rule", "tunnel_ssh_from_endpoint"
        )
        self.assertRegex(tunnel_ingress, r"from_port\s*=\s*22")
        self.assertRegex(tunnel_ingress, r"to_port\s*=\s*22")
        self.assertIn(
            "referenced_security_group_id = aws_security_group.db_tunnel_endpoint[0].id",
            tunnel_ingress,
        )
        self.assertNotIn("cidr_ipv4", tunnel_ingress)
        self.assertNotIn("cidr_ipv6", tunnel_ingress)

        tunnel_egress = resource(
            source, "aws_vpc_security_group_egress_rule", "tunnel_to_rds_postgres"
        )
        self.assertRegex(tunnel_egress, r"from_port\s*=\s*5432")
        self.assertRegex(tunnel_egress, r"to_port\s*=\s*5432")
        self.assertIn(
            "referenced_security_group_id = aws_security_group.rds.id",
            tunnel_egress,
        )
        self.assertNotIn("cidr_ipv4", tunnel_egress)
        self.assertNotIn("cidr_ipv6", tunnel_egress)

        network_source = read(ROOT / "network.tf")
        rds = resource(network_source, "aws_security_group", "rds")
        self.assertIn("ingress = []", rds)
        self.assertIn("ignore_changes = [ingress]", rds)
        self.assertNotIn("cidr_blocks", rds)
        self.assertNotIn("cidr_ipv6_blocks", rds)

        tunnel_rds_ingress = resource(
            network_source,
            "aws_vpc_security_group_ingress_rule",
            "rds_from_database_operator",
        )
        self.assertIn(
            "for_each = var.database_operator_access_enabled ? { operator = true } : {}",
            tunnel_rds_ingress,
        )
        self.assertRegex(
            tunnel_rds_ingress,
            r'referenced_security_group_id\s*=\s*aws_security_group\.db_tunnel\[0\]\.id',
        )

        self.assertIn("removed {", source)
        self.assertIn(
            "from = aws_vpc_security_group_ingress_rule.rds_postgres_from_tunnel",
            source,
        )
        self.assertIn("destroy = false", source)

    def test_rds_remains_private(self):
        rds = read(ROOT / "rds.tf")
        self.assertIn("publicly_accessible    = false", rds)
        self.assertNotIn("publicly_accessible    = true", rds)

    def test_required_inputs_and_outputs(self):
        variables = read(APPLICATION_VARIABLES)
        ami = block(variables, 'variable "db_tunnel_ami_id" {')
        self.assertIn("type        = string", ami)
        self.assertIn('^ami-[0-9a-f]+$', ami)
        self.assertIn("No automatic latest-AMI", ami)

        instance_type = block(variables, 'variable "db_tunnel_instance_type" {')
        self.assertIn('default     = "t4g.micro"', instance_type)
        self.assertIn('var.db_tunnel_instance_type == "t4g.micro"', instance_type)

        outputs = read(APPLICATION_OUTPUTS)
        for name in (
            "db_tunnel_instance_id",
            "db_instance_connect_endpoint_id",
            "db_endpoint",
        ):
            declaration = block(outputs, f'output "{name}" {{')
            self.assertIn("var.database_operator_access_enabled", declaration)


class OperatorPolicyTests(unittest.TestCase):
    def test_operator_policy_contains_only_the_reviewed_session_actions(self):
        source = read(BOOTSTRAP_IAM)
        document = block(
            source, 'data "aws_iam_policy_document" "database_operator_permissions" {'
        )

        for action in (
            "ec2:DescribeInstances",
            "ec2:DescribeInstanceStatus",
            "ec2:DescribeInstanceConnectEndpoints",
            "rds:DescribeDBInstances",
            "ec2:StartInstances",
            "ec2:StopInstances",
            "ec2-instance-connect:SendSSHPublicKey",
            "ec2-instance-connect:OpenTunnel",
        ):
            self.assertIn(action, document)

        for forbidden in (
            "ec2:RunInstances",
            "ec2:TerminateInstances",
            "ec2:CreateSecurityGroup",
            "ec2:AuthorizeSecurityGroupIngress",
            "ec2:CreateInstanceConnectEndpoint",
            "rds:ModifyDBInstance",
            "rds:DeleteDBInstance",
            "iam:PassRole",
            "secretsmanager:PutSecretValue",
            "iam:CreatePolicy",
        ):
            self.assertNotIn(forbidden, document)

    def test_operator_session_conditions_are_exact(self):
        source = read(BOOTSTRAP_IAM)
        document = block(
            source, 'data "aws_iam_policy_document" "database_operator_permissions" {'
        )

        self.assertIn('values   = ["ec2-user"]', document)
        self.assertIn('values   = ["22"]', document)
        self.assertIn('values   = ["3600"]', document)
        self.assertIn("aws:ResourceTag/purpose", document)
        self.assertIn('values   = ["db-tunnel"]', document)
        self.assertIn("aws:RequestedRegion", document)
        self.assertIn('local.application_database_arn', document)

    def test_operator_receives_no_mutation_or_administration_actions(self):
        source = read(BOOTSTRAP_IAM)
        document = block(
            source, 'data "aws_iam_policy_document" "database_operator_permissions" {'
        )
        self.assertNotIn("ec2:CreateTags", document)
        self.assertNotIn("secretsmanager:UpdateSecret", document)
        self.assertNotIn("s3:", document)
        self.assertNotIn("lambda:", document)


class DeploymentPolicyTests(unittest.TestCase):
    def test_tunnel_deployment_actions_require_purpose_tags(self):
        source = read(BOOTSTRAP_IAM)
        document = block(
            source, 'data "aws_iam_policy_document" "deployment_network_permissions" {'
        )
        create = policy_statement(document, "TagFoundationNetworkResources")
        self.assertIn("ec2:CreateTags", create)
        self.assertNotIn("ec2:RunInstances", create)
        self.assertNotIn("ec2:CreateInstanceConnectEndpoint", create)
        self.assertIn("aws:RequestTag/project", create)
        self.assertIn("aws:RequestTag/env", create)
        self.assertIn("aws:RequestTag/managed_by", create)
        self.assertIn("aws:TagKeys", create)
        self.assertIn("purpose", create)

        run = policy_statement(document, "RunTaggedDbTunnelInstance")
        self.assertIn("ec2:RunInstances", run)
        self.assertIn(":instance/*", run)
        self.assertIn(":volume/*", run)
        self.assertIn("aws:RequestTag/project", run)
        self.assertIn("aws:RequestTag/purpose", run)
        self.assertIn('values   = ["false"]', run)

        infrastructure = policy_statement(document, "CreateDbTunnelInfrastructure")
        self.assertIn("ec2:RunInstances", infrastructure)
        self.assertIn("ec2:CreateInstanceConnectEndpoint", infrastructure)
        read_statement = policy_statement(document, "ReadDbTunnelResources")
        self.assertIn("ec2:DescribeInstanceTypes", read_statement)
        self.assertIn("${var.deployment_db_tunnel_ami_id}", infrastructure)
        self.assertIn("${var.deployment_db_tunnel_subnet_id}", infrastructure)
        self.assertIn(":network-interface/*", infrastructure)
        self.assertIn(":instance-connect-endpoint/*", infrastructure)
        self.assertIn("ec2:Subnet", infrastructure)

        security_group = policy_statement(document, "UseDbTunnelSecurityGroups")
        self.assertIn("ec2:RunInstances", security_group)
        self.assertIn("ec2:CreateInstanceConnectEndpoint", security_group)
        self.assertIn("ec2:CreateNetworkInterface", security_group)
        self.assertIn(":security-group/*", security_group)
        self.assertIn("ForAnyValue:StringEquals", security_group)
        self.assertIn("${var.project}-${var.env}-db-tunnel", security_group)
        self.assertIn("${var.project}-${var.env}-db-eice", security_group)

        endpoint_eni = policy_statement(
            document, "CreateDbTunnelEndpointNetworkInterfaces"
        )
        self.assertIn("ec2:CreateNetworkInterface", endpoint_eni)
        self.assertIn(":network-interface/*", endpoint_eni)
        self.assertIn(":subnet/*", endpoint_eni)

        endpoint_eni_tags = policy_statement(
            document, "TagDbTunnelEndpointNetworkInterfaces"
        )
        self.assertIn("ec2:CreateTags", endpoint_eni_tags)
        self.assertIn(":network-interface/*", endpoint_eni_tags)
        self.assertIn("aws:TagKeys", endpoint_eni_tags)
        self.assertIn('values   = ["false"]', endpoint_eni_tags)

        manage = policy_statement(document, "ManageTaggedDbTunnelResources")
        self.assertIn("ec2:StartInstances", manage)
        self.assertIn("ec2:StopInstances", manage)
        self.assertIn("ec2:ModifyInstanceAttribute", manage)
        self.assertIn("aws:ResourceTag/purpose", manage)
        self.assertIn(":ec2:", manage)
        self.assertIn(":instance/*", manage)

    def test_deployment_policy_cannot_pass_a_role(self):
        source = read(BOOTSTRAP_IAM)
        document = block(
            source, 'data "aws_iam_policy_document" "deployment_network_permissions" {'
        )
        self.assertNotIn("iam:PassRole", document)
        self.assertNotIn("ec2:ModifyInstanceAttribute", block(
            document, "RunTaggedDbTunnelInstance"
        ))

    def test_instance_connect_service_linked_role_grant_is_temporary(self):
        variables = read(BOOTSTRAP_VARIABLES)
        declaration = block(
            variables,
            'variable "instance_connect_service_linked_role_creation_enabled" {',
        )
        self.assertIn("type        = bool", declaration)
        self.assertIn("default     = false", declaration)

        source = read(BOOTSTRAP_IAM)
        permissions = block(
            source, 'data "aws_iam_policy_document" "bootstrap_permissions" {'
        )
        self.assertIn("instance_connect_service_linked_role_creation_enabled", permissions)
        self.assertIn("CreateExactInstanceConnectServiceLinkedRole", permissions)
        self.assertIn("ec2-instance-connect.amazonaws.com", permissions)


if __name__ == "__main__":
    unittest.main()
