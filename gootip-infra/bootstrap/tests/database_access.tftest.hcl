variables {
  deployment_application_client_security_group_id = "sg-0123456789abcdef0"
  deployment_db_tunnel_ami_id                     = "ami-0123456789abcdef0"
  deployment_db_tunnel_subnet_id                  = "subnet-0123456789abcdef0"
}

variable "aws_account_id" {
  type = string
}

# SPEC 05.2: the database operator may discover, start, stop, and tunnel only
# through the intended tagged dev resources, with the reviewed session limits.
run "database_operator_session_permissions_are_exact" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
    db_operator_secret_arn              = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-db-operator-Ab12Cd"
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "DiscoverTaggedDbTunnelResources"
        ]).Action) == toset([
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeInstanceConnectEndpoints",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "DiscoverTaggedDbTunnelResources"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "DiscoverTaggedDbTunnelResources"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "Tunnel discovery must be Region-scoped and limited to the three reviewed read actions."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "DescribeExactDevDatabase"
      ]).Action == "rds:DescribeDBInstances" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "DescribeExactDevDatabase"
      ]).Resource == "arn:aws:rds:us-east-2:${var.aws_account_id}:db:gootip-dev"
    )
    error_message = "The operator may describe only the exact gootip-dev database."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "StartAndStopTaggedDbTunnelInstance"
      ]).Action) == toset(["ec2:StartInstances", "ec2:StopInstances"]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "StartAndStopTaggedDbTunnelInstance"
      ]).Resource == "arn:aws:ec2:us-east-2:${var.aws_account_id}:instance/*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "StartAndStopTaggedDbTunnelInstance"
      ]).Condition.StringEquals["aws:ResourceTag/project"] == "gootip" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "StartAndStopTaggedDbTunnelInstance"
      ]).Condition.StringEquals["aws:ResourceTag/env"] == "dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "StartAndStopTaggedDbTunnelInstance"
      ]).Condition.StringEquals["aws:ResourceTag/purpose"] == "db-tunnel"
    )
    error_message = "Start and stop must target only the instance carrying the exact Gootip dev tunnel tags."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "SendPublicKeyToTaggedDbTunnelInstance"
      ]).Action == "ec2-instance-connect:SendSSHPublicKey" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "SendPublicKeyToTaggedDbTunnelInstance"
      ]).Condition.StringEquals["ec2:osuser"] == "ec2-user" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "SendPublicKeyToTaggedDbTunnelInstance"
      ]).Condition.StringEquals["aws:ResourceTag/purpose"] == "db-tunnel"
    )
    error_message = "Public-key delivery must use ec2-user on the tagged tunnel instance only."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "OpenTunnelToTaggedDbTunnelEndpoint"
      ]).Action == "ec2-instance-connect:OpenTunnel" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "OpenTunnelToTaggedDbTunnelEndpoint"
      ]).Resource == "arn:aws:ec2:us-east-2:${var.aws_account_id}:instance-connect-endpoint/*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "OpenTunnelToTaggedDbTunnelEndpoint"
      ]).Condition.NumericEquals["ec2-instance-connect:remotePort"] == "22" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "OpenTunnelToTaggedDbTunnelEndpoint"
      ]).Condition.NumericLessThanEquals["ec2-instance-connect:maxTunnelDuration"] == "3600" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
        if statement.Sid == "OpenTunnelToTaggedDbTunnelEndpoint"
      ]).Condition.StringEquals["aws:ResourceTag/purpose"] == "db-tunnel"
    )
    error_message = "Tunnel authorization must cap the remote port at 22 and the duration at one hour."
  }

  assert {
    condition = length([
      for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement
      if length(setintersection(toset(flatten([statement.Action])), toset([
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
        "s3:GetObject",
        "lambda:InvokeFunction",
      ]))) > 0
    ]) == 0
    error_message = "The operator must receive no create, terminate, network-mutation, RDS-mutation, IAM, state, Lambda, or broader secret permission."
  }
}

# SPEC 05.2: the deployment role may create and manage only tagged tunnel
# resources, with a Region-scoped creation exception and no PassRole.
run "db_tunnel_deployment_permissions_are_tagged_and_exact" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition = (
      toset(flatten([one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagFoundationNetworkResources"
      ]).Action])) == toset(["ec2:CreateTags"]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagFoundationNetworkResources"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagFoundationNetworkResources"
      ]).Condition.StringEquals["aws:RequestTag/project"] == "gootip" &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagFoundationNetworkResources"
      ]).Condition["ForAllValues:StringEquals"]["aws:TagKeys"], "purpose")
    )
    error_message = "Tunnel creation-time tagging must allow the reviewed purpose tag."
  }

  assert {
    condition = (
      toset(flatten([one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RunTaggedDbTunnelInstance"
      ]).Action])) == toset(["ec2:RunInstances"]) &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RunTaggedDbTunnelInstance"
      ]).Resource, "arn:aws:ec2:us-east-2:${var.aws_account_id}:instance/*") &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RunTaggedDbTunnelInstance"
      ]).Resource, "arn:aws:ec2:us-east-2:${var.aws_account_id}:volume/*") &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RunTaggedDbTunnelInstance"
      ]).Condition.StringEquals["aws:RequestTag/purpose"] == "db-tunnel" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RunTaggedDbTunnelInstance"
      ]).Condition.Null["aws:TagKeys"] == "false"
    )
    error_message = "The tunnel instance and root volume must require the exact Gootip purpose tags."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateDbTunnelInfrastructure"
      ]).Action) == toset(["ec2:CreateInstanceConnectEndpoint", "ec2:RunInstances"]) &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateDbTunnelInfrastructure"
      ]).Resource, "arn:aws:ec2:us-east-2::image/ami-0123456789abcdef0") &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateDbTunnelInfrastructure"
      ]).Resource, "arn:aws:ec2:us-east-2:${var.aws_account_id}:subnet/subnet-0123456789abcdef0") &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateDbTunnelInfrastructure"
      ]).Resource, "arn:aws:ec2:us-east-2:${var.aws_account_id}:network-interface/*") &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateDbTunnelInfrastructure"
      ]).Resource, "arn:aws:ec2:us-east-2:${var.aws_account_id}:instance-connect-endpoint/*") &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateDbTunnelInfrastructure"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateDbTunnelInfrastructure"
      ]).Condition.ArnEqualsIfExists["ec2:Subnet"] == "arn:aws:ec2:us-east-2:${var.aws_account_id}:subnet/subnet-0123456789abcdef0"
    )
    error_message = "The launch and endpoint must use only the pinned image and reviewed private subnet."
  }

  assert {
    condition = (
      toset(flatten([one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "UseDbTunnelSecurityGroups"
        ]).Action])) == toset([
        "ec2:CreateInstanceConnectEndpoint",
        "ec2:CreateNetworkInterface",
        "ec2:RunInstances",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "UseDbTunnelSecurityGroups"
      ]).Resource == "arn:aws:ec2:us-east-2:${var.aws_account_id}:security-group/*" &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "UseDbTunnelSecurityGroups"
      ]).Condition["ForAnyValue:StringEquals"]["aws:ResourceTag/Name"], "gootip-dev-db-eice") &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "UseDbTunnelSecurityGroups"
      ]).Condition["ForAnyValue:StringEquals"]["aws:ResourceTag/Name"], "gootip-dev-db-tunnel")
    )
    error_message = "Launch and endpoint creation may use only the two named Gootip dev tunnel security groups."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagDbTunnelEndpointNetworkInterfaces"
      ]).Action == "ec2:CreateTags" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagDbTunnelEndpointNetworkInterfaces"
      ]).Resource == "arn:aws:ec2:us-east-2:${var.aws_account_id}:network-interface/*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagDbTunnelEndpointNetworkInterfaces"
      ]).Condition.Null["aws:TagKeys"] == "false"
    )
    error_message = "The endpoint network interface may only receive the reviewed purpose tag set."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ManageTaggedDbTunnelResources"
        ]).Action) == toset([
        "ec2:ModifyInstanceAttribute",
        "ec2:ModifyInstanceMetadataOptions",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:TerminateInstances",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ManageTaggedDbTunnelResources"
      ]).Condition.StringEquals["aws:ResourceTag/project"] == "gootip" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ManageTaggedDbTunnelResources"
      ]).Condition.StringEquals["aws:ResourceTag/env"] == "dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ManageTaggedDbTunnelResources"
      ]).Condition.StringEquals["aws:ResourceTag/purpose"] == "db-tunnel"
    )
    error_message = "Instance start, stop, update, and termination must target only resources with the exact Gootip dev tunnel tags."
  }

  assert {
    condition = !contains(
      flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement.Action]),
      "iam:PassRole"
    )
    error_message = "The deployment network policy must never grant PassRole."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ReadDbTunnelResources"
        ]).Action) == toset([
        "ec2:DescribeImages",
        "ec2:DescribeInstanceAttribute",
        "ec2:DescribeInstanceConnectEndpoints",
        "ec2:DescribeInstanceCreditSpecifications",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstances",
        "ec2:DescribeSecurityGroupRules",
        "ec2:DescribeVolumes",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ReadDbTunnelResources"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "Tunnel reads must stay Region-scoped and limited to the reviewed EC2 metadata actions."
  }
}

# The EC2 Instance Connect service-linked role is created externally once through
# a temporary, exact bootstrap permission that is removed immediately afterwards.
run "instance_connect_service_linked_role_grant_is_temporary" {
  command = plan

  variables {
    eligibility_gate_passed                               = true
    account_resource_phase_enabled                        = false
    foundation_policy_expansion_enabled                   = true
    secrets_manager_kms_key_arn                           = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
    instance_connect_service_linked_role_creation_enabled = true
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "CreateExactInstanceConnectServiceLinkedRole"
      ]).Action == "iam:CreateServiceLinkedRole" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "CreateExactInstanceConnectServiceLinkedRole"
      ]).Resource == "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/ec2-instance-connect.amazonaws.com/AWSServiceRoleForEc2InstanceConnect" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "CreateExactInstanceConnectServiceLinkedRole"
      ]).Condition.StringEquals["iam:AWSServiceName"] == "ec2-instance-connect.amazonaws.com"
    )
    error_message = "The temporary service-linked-role grant must target only the exact EC2 Instance Connect role and service name."
  }
}
