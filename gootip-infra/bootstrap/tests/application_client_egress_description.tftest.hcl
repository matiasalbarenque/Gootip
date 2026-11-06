variables {
  deployment_application_client_security_group_id = "sg-0123456789abcdef0"
  deployment_db_tunnel_ami_id                     = "ami-0123456789abcdef0"
  deployment_db_tunnel_subnet_id                  = "subnet-0123456789abcdef0"
}

variable "aws_account_id" {
  type = string
}

run "application_client_egress_description_permission_is_exact" {
  command = plan

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement
        if statement.Sid == "UpdateExactApplicationClientEgressDescription"
      ]).Action == "ec2:UpdateSecurityGroupRuleDescriptionsEgress" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement
        if statement.Sid == "UpdateExactApplicationClientEgressDescription"
      ]).Resource == "arn:aws:ec2:us-east-2:${var.aws_account_id}:security-group/sg-0123456789abcdef0" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement
        if statement.Sid == "UpdateExactApplicationClientEgressDescription"
      ]).Condition.StringEquals["ec2:Region"] == "us-east-2" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement
        if statement.Sid == "UpdateExactApplicationClientEgressDescription"
      ]).Condition.StringEquals["aws:ResourceTag/project"] == "gootip" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement
        if statement.Sid == "UpdateExactApplicationClientEgressDescription"
      ]).Condition.StringEquals["aws:ResourceTag/env"] == "dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement
        if statement.Sid == "UpdateExactApplicationClientEgressDescription"
      ]).Condition.StringEquals["aws:ResourceTag/managed_by"] == "terraform"
    )
    error_message = "The description-only EC2 permission must be limited to the exact dev application-client security group, Region, and ownership tags."
  }
}
